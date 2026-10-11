#!/usr/bin/env node
/**
 * IS THE LIVE SITE STILL REGENERATING, OR HAS IT FROZEN AGAIN?
 *
 * On 3 Sep 2026 production was serving documents four and a half days old and
 * nothing said so. Measured from the served `age` header:
 *
 *     /             383,205s   (4d 10h)
 *     /signals      383,671s
 *     /pricing      187,695s   (2d 4h)
 *     /performance    4,470s   ← the only one with a revalidate window
 *
 * The cause was structural rather than an incident: those pages exported no
 * `revalidate`, so Next prerendered them once at build and Vercel served that
 * artifact until the next deploy. There was no outage to notice, no error to
 * log and no alert to fire. A visitor simply read a four-day-old board.
 *
 * The fix was a revalidate window on each. THIS is what says the fix is still
 * working, and it is deliberately two assertions rather than one:
 *
 *   1. THE WINDOW IS STILL DECLARED. Read out of the route's own source, not
 *      from a list typed here. A page that loses its `export const revalidate`
 *      is frozen again the moment it deploys, and that deletion looks like
 *      tidying in a diff. Two lists that agree until one is edited is the bug
 *      this repo has extracted MethodNav.STEPS and CalibrationSection.SECTIONS
 *      after; the source is the list.
 *   2. THE WINDOW IS BEING HONOURED. The served `age` must not exceed it by
 *      more than TOLERANCE. Vercel serves stale-while-revalidate, so an age
 *      slightly past the window is normal and expected — a route stuck at 40×
 *      its window is not, and 383,205 against a 900s window is 425×.
 *
 * WHY A SCHEDULED WORKFLOW AND NOT A DASHBOARD. It has to surface where Owen
 * already looks and it has to be loud on its own. A red run in the Actions tab
 * emails the repo owner without anybody subscribing to anything, and
 * `::error::` annotations put the failing route and its age on the run summary
 * without opening the log. Nothing else in this repo alerts at all.
 *
 * Exit 0 = fresh. Exit 1 = something is frozen or unreachable.
 * `--json` prints a machine-readable line as well, for wiring somewhere else.
 */
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.FRESHNESS_BASE_URL || 'https://maxedge.live';

/**
 * How far past its own window a route may drift before this is a fault.
 *
 * Three, not one. `revalidate` is a floor, not a promise: Vercel answers from
 * the edge cache while it regenerates behind the request, so a quiet route
 * genuinely reads older than its window and a tolerance of 1 would page
 * somebody nightly for correct behaviour. Three still catches the failure this
 * exists for by two orders of magnitude — the observed freeze was 425×.
 */
const TOLERANCE = 3;

/**
 * The routes that MUST be bounded, and the file each one's window lives in.
 *
 * This list is the CLAIM ("these pages may never freeze"); the numbers come
 * from the source. A route added here with no `revalidate` in its file fails
 * the check, which is the point — that is the state every one of these was in
 * on 3 Sep.
 */
// THIS COPY LIVES IN eve-engine, NOT BESIDE THE PAGES IT WATCHES.
//
// It moved here on 11 Oct 2026 because GitHub stopped starting jobs in the
// private eve-frontend repo (billing), while this repo is public and its
// Actions minutes are free. From here it cannot read the page files, so each
// route's window is written below instead of read from its
// `export const revalidate`. That costs the CAUSE in the message, not the
// alarm: a page that loses its window freezes at the next deploy, and a frozen
// page's age runs past the window written here, which fails this check.
// If a page's revalidate changes in eve-frontend, change it here too.
const MONITORED = [
  { route: '/',             seconds: 900,  source: 'app/page.js' },
  { route: '/pricing',      seconds: 3600, source: 'app/pricing/page.js' },
  { route: '/performance',  seconds: 3600, source: 'app/performance/page.tsx' },
  { route: '/sitemap.xml',  seconds: 3600, source: 'app/sitemap.js' },
  { route: '/market-pulse', seconds: 30,   source: 'app/market-pulse/page.js' },
];

/** `export const revalidate = 900` → 900. Returns null if the route is unbounded. */
function declaredWindow(sourcePath) {
  const abs = path.resolve(__dirname, '..', sourcePath);
  let src;
  try {
    src = fs.readFileSync(abs, 'utf8');
  } catch {
    return { seconds: null, reason: `cannot read ${sourcePath}` };
  }
  // Comments in this repo quote the word constantly, so match an EXPORT.
  const m = src.match(/^\s*export\s+const\s+revalidate\s*=\s*(\d+)/m);
  if (!m) return { seconds: null, reason: `no \`export const revalidate\` in ${sourcePath}` };
  const seconds = Number(m[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { seconds: null, reason: `revalidate is ${m[1]} in ${sourcePath}, which does not bound anything` };
  }
  return { seconds, reason: null };
}

async function probe(route) {
  const url = `${BASE}${route}`;
  // Two attempts: a single transient network blip must not page anybody at
  // 04:00, and a genuine freeze is not transient.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: { 'user-agent': 'maxedge-deploy-freshness' },
        signal: AbortSignal.timeout(30_000),
      });
      const ageHeader = res.headers.get('age');
      return {
        status: res.status,
        age: ageHeader == null ? null : Number(ageHeader),
        cache: res.headers.get('x-vercel-cache'),
      };
    } catch (err) {
      if (attempt === 2) return { status: null, age: null, cache: null, error: String(err) };
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

async function main() {
  const failures = [];
  const report = [];

  for (const { route, source, seconds: written } of MONITORED) {
    const { seconds, reason } = written ? { seconds: written, reason: null } : declaredWindow(source);
    if (seconds == null) {
      failures.push(`${route} is UNBOUNDED — ${reason}. It will freeze at the next deploy.`);
      report.push({ route, window: null, age: null, status: null, ok: false });
      continue;
    }

    let res = await probe(route);
    // A STALE answer is Vercel serving the old copy while it rebuilds, which
    // is what the FIRST visitor after a quiet spell always gets. On a 30s page
    // checked every six hours that is nearly every run, so the verdict is
    // taken from a second read once the rebuild has had a few seconds. A page
    // that has really stopped regenerating is still stale the second time.
    if (res.cache === 'STALE' && res.age != null && res.age > seconds) {
      await new Promise((r) => setTimeout(r, 10_000));
      res = await probe(route);
    }
    if (res.error || res.status == null) {
      failures.push(`${route} could not be fetched: ${res.error ?? 'no response'}`);
      report.push({ route, window: seconds, age: null, status: null, ok: false });
      continue;
    }
    if (res.status !== 200) {
      failures.push(`${route} returned HTTP ${res.status}`);
      report.push({ route, window: seconds, age: res.age, status: res.status, ok: false });
      continue;
    }

    const limit = seconds * TOLERANCE;
    // A MISSING `age` IS NOT A FAILURE. It means the edge served this from
    // origin rather than from cache, which is the freshest answer there is.
    const stale = res.age != null && res.age > limit;
    if (stale) {
      failures.push(
        `${route} is STALE: age ${res.age}s against a ${seconds}s window ` +
          `(${(res.age / seconds).toFixed(1)}x, limit ${limit}s, x-vercel-cache ${res.cache})`
      );
    }
    report.push({ route, window: seconds, age: res.age, status: res.status, cache: res.cache, ok: !stale });
  }

  for (const r of report) {
    console.log(
      `${r.ok ? 'ok  ' : 'FAIL'}  ${r.route.padEnd(14)} ` +
        `window=${r.window ?? '—'}s  age=${r.age ?? 'none'}  ` +
        `status=${r.status ?? '—'}  cache=${r.cache ?? '—'}`
    );
  }
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ base: BASE, checkedAt: new Date().toISOString(), report }));
  }

  if (failures.length) {
    for (const f of failures) console.log(`::error title=Deploy freshness::${f}`);
    console.error(
      `\n${failures.length} freshness failure(s) against ${BASE}.\n` +
        'A route past its window means Vercel is serving an artifact that is no\n' +
        'longer regenerating — the 3 Sep state, where every visitor read a\n' +
        'four-day-old board and nothing said so. Check the route still exports\n' +
        '`revalidate`, then that the last deploy actually reached READY.'
    );
    process.exit(1);
  }
  console.log(`\nAll ${report.length} monitored routes are inside their windows.`);
}

main().catch((err) => {
  console.log(`::error title=Deploy freshness::the check itself failed: ${err}`);
  console.error(err);
  process.exit(1);
});
