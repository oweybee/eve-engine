'use strict';

/**
 * verifyIntegrity.js — the "constant eye" on the maths.
 *
 * Runs every engine cycle and asserts the invariants that keep the published
 * numbers honest. Any violation is logged and (if ENGINE_ALERT_WEBHOOK is set)
 * pushed to the alert channel. It never mutates data and never fails the
 * pipeline — it is a smoke alarm, not a gate.
 *
 * Invariants checked (active fixtures + pending signals):
 *   1. Probability sanity     — every model probability in [0, 1].
 *   2. EV ↔ odds consistency  — modelProb = (edge + 1)/odds must be in [0, 1].
 *   3. No implausible edges    — |edge| ≤ EDGE_CAP (a 30%+ "value" edge on a
 *                                priced market is almost always a model error).
 *   4. Value-flag integrity    — a selection flagged value=true must clear the
 *                                EV threshold and carry a price > 1.
 *   5. Signal self-consistency — value_signals.detected_edge ≈ model_prob·odds−1.
 *
 * A SMOKE ALARM THAT CANNOT SEE STILL SAYS NOTHING IS BURNING, and this file
 * has been in that state twice. Once when its select named a column that does
 * not exist, which errored and silently disabled the whole signal check. And
 * again until 20 Aug 2026: both reads used `.limit(2000)`, which READS as a
 * deliberate ceiling but is not one — PostgREST caps a response at 1,000 rows
 * server-side and a larger client limit does not raise it. Measured against
 * production: 1,599 rows in `computed_values`, 1,000 returned, and the run
 * logged "OK — 1000 computed rows".
 *
 * That mattered more here than in the four other truncated reads fixed the
 * same day, because those merely lost work; this one loses the CHECK. Of the
 * 1,599 rows only 186 were live, so an arbitrary 1,000-row slice verified
 * roughly 116 of them and missed ~70 every cycle — a different ~70 each run,
 * since there was no `order` either. Both reads are paged through
 * lib/pagedRead now, and the log states how many rows were CHECKED rather than
 * how many were fetched, because those are different numbers and only one of
 * them is the claim.
 */

const { getClient } = require('./lib/supabaseClient');
const { pageAll, inChunks } = require('./lib/pagedRead');

const EV_THRESHOLD = parseFloat(process.env.EV_THRESHOLD || '0.005');
const EDGE_CAP     = parseFloat(process.env.INTEGRITY_EDGE_CAP || '0.30'); // 30%
const PROB_TOL     = 1e-6;
const EDGE_TOL     = 0.01; // 1pp tolerance on EV reconstruction
// How far the newest odds may lead the newest compute before a match counts as
// "compute is falling behind". The engine ticks every ~5 min, so a healthy lag
// is single-digit minutes; 90 min clears CI queueing yet still catches the
// hours/days-stale failure that hides secondary markets ("awaiting prices").
const STALE_COMPUTE_MIN = parseFloat(process.env.INTEGRITY_STALE_COMPUTE_MIN || '90');
// The consensus engine only prices a match with h2h odds from at least this
// many bookmakers (matches computeValues' own gate). Single-book fixtures —
// e.g. Betfair-exchange-only rows — are legitimately unpriced, so the coverage
// guard ignores them to avoid false alarms.
const MIN_BOOKMAKERS = parseInt(process.env.MIN_BOOKMAKERS || '2', 10);

// Each priced selection: [edge col, odds col, value col, model-prob col|null, label]
const SELECTIONS = [
  ['home_edge', 'best_home_odds', 'home_value', null, '1X2 home'],
  ['draw_edge', 'best_draw_odds', 'draw_value', null, '1X2 draw'],
  ['away_edge', 'best_away_odds', 'away_value', null, '1X2 away'],
  ['over_edge', 'over_odds', 'over_value', null, 'totals over'],
  ['under_edge', 'under_odds', 'under_value', null, 'totals under'],
  ['btts_yes_edge', 'btts_yes_odds', 'btts_yes_value', 'btts_model_prob', 'btts yes'],
  ['btts_no_edge', 'btts_no_odds', 'btts_no_value', null, 'btts no'],
  ['corners_over_edge', 'corners_over_odds', 'corners_over_value', 'corners_model_prob', 'corners over'],
  ['corners_under_edge', 'corners_under_odds', 'corners_under_value', null, 'corners under'],
  ['bookings_over_edge', 'bookings_over_odds', 'bookings_over_value', 'bookings_model_prob', 'cards over'],
  ['bookings_under_edge', 'bookings_under_odds', 'bookings_under_value', null, 'cards under'],
];

const num = x => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
const COMPLETED = new Set(['FT', 'FINISHED', 'COMPLETED', 'AET', 'PEN', 'CANC', 'ABD', 'AWD', 'WO', 'INT']);
const KICKOFF_GRACE_MS = 2.5 * 60 * 60 * 1000;
// Only LIVE, pre-kickoff rows are user-facing — those are the ones whose maths
// can mislead. Completed / long-past matches are excluded from alerting.
function isLive(match) {
  if (!match) return true; // no join → don't suppress
  const st = (match.status ?? '').toUpperCase();
  if (COMPLETED.has(st)) return false;
  if (match.kickoff_at && Date.now() - new Date(match.kickoff_at).getTime() > KICKOFF_GRACE_MS) return false;
  return true;
}

async function checkComputedValues(supabase, violations) {
  const cols = [
    'match_id', 'model_architecture',
    ...new Set(SELECTIONS.flatMap(s => [s[0], s[1], s[2], s[3]].filter(Boolean))),
    'btts_model_prob', 'corners_model_prob', 'bookings_model_prob',
  ];
  // `.limit(2000)` DID NOT DO WHAT IT LOOKED LIKE. PostgREST caps a response at
  // 1,000 rows server-side and a larger client limit does not raise it — the
  // cap simply wins, in silence. Measured 20 Aug 2026: 1,599 rows in the table,
  // 1,000 returned, and the run printed "OK — 1000 computed rows".
  //
  // A LIMIT THAT LOOKS DELIBERATE IS WORSE THAN NONE. The other four truncated
  // reads in this repo had no bound at all, which at least reads as an
  // oversight; this one reads as a considered ceiling that someone chose.
  //
  // And it matters most HERE. This file is the smoke alarm — a truncated read
  // makes it report "no violations" while never looking at the rows. Only 186
  // of those 1,599 are live, so an arbitrary 1,000-row slice checked roughly
  // 116 of them and missed ~70 EVERY CYCLE, a different ~70 each run because
  // there was no order either. This file has already had one silent-disabling
  // bug (see checkSignals below); that is the failure mode to design against.
  let data;
  try {
    data = await pageAll(() => supabase
      .from('computed_values')
      .select([...new Set(cols)].join(',') + ',match:matches(status,kickoff_at)'),
      'id', 'computed_values');
  } catch (e) {
    violations.push(`[query] computed_values: ${e.message}`);
    return { fetched: 0, checked: 0 };
  }

  let checked = 0;
  for (const row of data ?? []) {
    if (!isLive(row.match)) continue;  // skip completed / past-kickoff
    checked++;
    const tag = `cv ${row.match_id?.slice(0, 8)} (${row.model_architecture ?? 'null'})`;

    for (const col of ['btts_model_prob', 'corners_model_prob', 'bookings_model_prob']) {
      const p = num(row[col]);
      if (p != null && (p < -PROB_TOL || p > 1 + PROB_TOL)) {
        violations.push(`${tag}: ${col} = ${p} outside [0,1]`);
      }
    }

    for (const [edgeC, oddsC, valueC, , label] of SELECTIONS) {
      const edge = num(row[edgeC]);
      const odds = num(row[oddsC]);
      if (edge == null || odds == null) continue;

      if (odds <= 1) { violations.push(`${tag} ${label}: odds ${odds} ≤ 1`); continue; }

      const modelProb = (edge + 1) / odds;
      if (modelProb < -PROB_TOL || modelProb > 1 + PROB_TOL) {
        violations.push(`${tag} ${label}: implied modelProb ${modelProb.toFixed(3)} outside [0,1] (edge ${edge}, odds ${odds})`);
      }
      // Only POSITIVE edges are published as value — a large negative edge just
      // means the model rates that side poorly and is never shown, so it isn't
      // misinformation.
      if (edge > EDGE_CAP) {
        violations.push(`${tag} ${label}: implausible +edge ${(edge * 100).toFixed(1)}% (cap ${(EDGE_CAP * 100).toFixed(0)}%)`);
      }
      if (row[valueC] === true && edge < EV_THRESHOLD) {
        violations.push(`${tag} ${label}: value=true but edge ${(edge * 100).toFixed(2)}% < threshold`);
      }
    }
  }
  // BOTH NUMBERS, because they answer different questions. `fetched` is how
  // much of the table was read; `checked` is how much was actually verified.
  // The old log printed the fetched count alone — "OK — 1000 computed rows" —
  // which reads as a thousand rows verified when the real figure was ~116.
  return { fetched: data?.length ?? 0, checked };
}

/**
 * Coverage / freshness guard — the smoke alarm for the exact failure that hid
 * secondary markets on otherwise-priced fixtures (the "awaiting prices" bug):
 * odds are in the DB but never reach computed_values, so the app shows Match
 * Odds only. It catches the whole class by SYMPTOM regardless of cause (a
 * future row-cap regression, a crashed/lagging compute, a plan gap) by
 * comparing, per live upcoming match, the newest ingested odds against the
 * newest computed price.
 *
 * Every multi-match read here is bounded both ways via lib/pagedRead, so the
 * guard cannot itself be blinded by the truncation it exists to watch for.
 */
async function checkMarketCoverage(supabase, violations) {
  const nowMs = Date.now();
  // Nearest 500 upcoming scheduled fixtures — a single bounded, ordered read.
  const { data: matches, error: mErr } = await supabase
    .from('matches')
    .select('id, external_id, status, kickoff_at')
    .eq('status', 'scheduled')
    .gt('kickoff_at', new Date(nowMs).toISOString())
    .lt('kickoff_at', new Date(nowMs + 7 * 24 * 3600 * 1000).toISOString())
    .order('kickoff_at', { ascending: true })
    .limit(500);
  if (mErr) { violations.push(`[query] coverage matches: ${mErr.message}`); return 0; }
  const live = matches ?? [];
  if (!live.length) return 0;
  const ids = live.map(m => m.id);

  // Odds presence + freshness per match. Chunked + paged: these ids are the
  // nearest-500 slate, which still inlines to a ~20KB .in() URL, and the odds
  // table holds many rows per match.
  let oddsRows;
  try {
    oddsRows = await inChunks(ids, 'id', 'coverage odds', chunk =>
      supabase.from('odds').select('id, match_id, market, bookmaker, fetched_at').in('match_id', chunk));
  } catch (e) { violations.push(`[query] coverage odds: ${e.message}`); return 0; }
  const oddsByMatch = new Map();
  for (const o of oddsRows) {
    let e = oddsByMatch.get(o.match_id);
    if (!e) { e = { markets: new Set(), h2hBooks: new Set(), latest: 0 }; oddsByMatch.set(o.match_id, e); }
    const market = o.market ?? 'h2h';
    e.markets.add(market);
    if (market === 'h2h' && o.bookmaker) e.h2hBooks.add(o.bookmaker);
    const t = o.fetched_at ? new Date(o.fetched_at).getTime() : 0;
    if (t > e.latest) e.latest = t;
  }

  // Latest compute + which markets are priced, per match. Chunked + paged for
  // the same reasons.
  let cvRows;
  try {
    cvRows = await inChunks(ids, 'id', 'coverage computed_values', chunk =>
      supabase.from('computed_values')
        .select('id, match_id, computed_at, best_home_odds, over_odds, btts_yes_odds')
        .in('match_id', chunk));
  } catch (e) { violations.push(`[query] coverage computed_values: ${e.message}`); return 0; }
  const cvByMatch = new Map();
  for (const r of cvRows) {
    let e = cvByMatch.get(r.match_id);
    if (!e) { e = { latest: 0, hasH2h: false, hasTotals: false, hasBtts: false }; cvByMatch.set(r.match_id, e); }
    const t = r.computed_at ? new Date(r.computed_at).getTime() : 0;
    if (t > e.latest) e.latest = t;
    if (r.best_home_odds != null) e.hasH2h = true;
    if (r.over_odds != null)      e.hasTotals = true;
    if (r.btts_yes_odds != null)  e.hasBtts = true;
  }

  let checked = 0;
  for (const m of live) {
    const od = oddsByMatch.get(m.id);
    if (!od || !od.latest) continue; // no odds ingested yet → nothing to price
    // Only assert pricing for matches the consensus engine is meant to price.
    if (od.h2hBooks.size < MIN_BOOKMAKERS) continue;
    checked++;
    const tag = `coverage ${m.external_id ?? m.id?.slice(0, 8)}`;
    const cv = cvByMatch.get(m.id);

    if (!cv) {
      violations.push(`${tag}: ${od.markets.size} odds market(s) ingested but NO computed_values row`);
      continue;
    }
    const lagMin = (od.latest - cv.latest) / 60000;
    if (lagMin > STALE_COMPUTE_MIN) {
      violations.push(`${tag}: computed_values stale — newest odds ${Math.round(lagMin)} min ahead of newest compute (last ${new Date(cv.latest).toISOString()})`);
      continue; // staleness already explains any missing markets — one alert
    }
    // Compute is current, yet a market with ingested odds is unpriced. Gated on
    // h2h being priced so we know the match was actually processed this cycle.
    if (cv.hasH2h) {
      if (od.markets.has('totals') && !cv.hasTotals) {
        violations.push(`${tag}: totals odds ingested but over/under not priced`);
      }
      if (od.markets.has('btts') && !cv.hasBtts) {
        violations.push(`${tag}: BTTS odds ingested but not priced`);
      }
    }
  }
  return checked;
}

async function checkSignals(supabase, violations) {
  // value_signals has no stored model_prob — it carries detected_edge +
  // detected_odds, from which the implied model probability is (edge+1)/odds.
  // (The previous select of a non-existent model_prob column errored, silently
  // disabling the entire signal check.)
  // Paged for the same reason, though it is not truncated TODAY: 20 pending
  // signals against the 1,000 cap. An unbounded read that happens to fit is
  // still unbounded, and `computed_values` was comfortably under a thousand
  // once too.
  let data;
  try {
    data = await pageAll(() => supabase
      .from('value_signals')
      .select('id, market, outcome, detected_edge, detected_odds')
      .eq('result', 'pending'),
      'id', 'value_signals');
  } catch (e) {
    violations.push(`[query] value_signals: ${e.message}`);
    return 0;
  }

  for (const s of data ?? []) {
    const tag = `signal ${String(s.id).slice(0, 8)} ${s.market}/${s.outcome}`;
    const edge = num(s.detected_edge), odds = num(s.detected_odds);
    if (odds != null && odds <= 1) violations.push(`${tag}: odds ${odds} ≤ 1`);
    if (edge != null && edge > EDGE_CAP) violations.push(`${tag}: implausible +edge ${(edge * 100).toFixed(1)}%`);
    // EV↔odds consistency: the implied model probability must be a probability.
    if (edge != null && odds != null && odds > 1) {
      const mp = (edge + 1) / odds;
      if (mp < -PROB_TOL || mp > 1 + PROB_TOL) {
        violations.push(`${tag}: implied model_prob ${mp.toFixed(3)} outside [0,1] (edge ${edge}, odds ${odds})`);
      }
    }
  }
  return data?.length ?? 0;
}

async function postAlert(violations) {
  const url = process.env.ENGINE_ALERT_WEBHOOK;
  if (!url || !violations.length) return;
  const shown = violations.slice(0, 20);
  const body = `[INTEGRITY] ${violations.length} data violation(s):\n- ${shown.join('\n- ')}` +
    (violations.length > shown.length ? `\n…and ${violations.length - shown.length} more` : '');
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: body }) });
  } catch (e) { console.warn(`[integrity] alert post failed: ${e.message}`); }
}

async function run() {
  console.log(`\n[integrity] ${new Date().toISOString()}`);
  const supabase = getClient();
  const violations = [];

  const cv = await checkComputedValues(supabase, violations);
  const sigN = await checkSignals(supabase, violations);
  const covN = await checkMarketCoverage(supabase, violations);

  const scope = `${cv.checked} live of ${cv.fetched} computed row(s), ${sigN} pending signal(s), ${covN} live match(es) covered`;
  if (violations.length) {
    console.error(`[integrity] ${violations.length} VIOLATION(S) across ${scope}:`);
    for (const v of violations) console.error(`  ✗ ${v}`);
    await postAlert(violations);
  } else {
    console.log(`[integrity] OK — ${scope}, no violations`);
  }
  return violations.length;
}

if (require.main === module) {
  run().then(n => process.exit(0)).catch(err => { console.error('[integrity] unhandled:', err); process.exit(0); });
}

module.exports = { run, checkComputedValues, checkSignals, checkMarketCoverage, isLive };
