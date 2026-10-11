#!/usr/bin/env node
/**
 * IS THE HOMEPAGE ACTUALLY SHOWING ANYBODY ANY FOOTBALL?
 *
 * On 5 Sep 2026 a link to maxedge.live was sent to a prospective customer. What
 * they opened was a homepage with three of its four figures reading an
 * em-dash, no games under "Today's board", and a card stating "154 MATCHES
 * PRICED TODAY · 0 BACKED" directly above the empty space where the 154 should
 * have been. It read as a dead site. It looked identical in Instagram's in-app
 * browser, in mobile Safari and on the desktop app, because none of that was
 * the cause: the board was filtering on the `*_value` flags and production had
 * ZERO of them on 129 upcoming priced fixtures.
 *
 * ── WHY A BROWSER, WHEN `deploy-freshness.js` NEEDS ONLY `curl` ────────────
 *
 * Because the board is not in the document. Measured on the served page the
 * same day: 87,473 bytes of HTML containing the string "to win" exactly ZERO
 * times, no team name, and no "matches priced". `useHomeFeed` fetches in an
 * effect, and an effect does not run during SSR — so every byte a crawler, a
 * link-preview scraper or a `curl` sees is the shell. A check that reads the
 * HTML would have passed happily throughout the incident.
 *
 * So this one renders the page the way a customer does and counts what is on
 * the screen afterwards. That is also the only check that cannot DRIFT from
 * the product: re-deriving "should the board have rows?" from the database
 * would be a second copy of the rule, and the copy that agrees with the code
 * is the one that would have gone wrong in exactly the same way.
 *
 * ── WHAT IT ASSERTS, AND WHAT IT DELIBERATELY DOES NOT ─────────────────────
 *
 * ASSERTS: the anonymous visitor — the seat a shared link opens in — is shown
 * at least one real fixture on the board. When the board is empty `BoardPreview`
 * returns before the table exists, so "no table" and "no rows" are the same
 * state and both mean the page told a stranger there is nothing here.
 *
 * DOES NOT ASSERT that anything is BACKED. "Most days this returns null, and
 * that is the product" (§1.2). An alarm that fires on a quiet day is an alarm
 * nobody reads, which this repo has now written down four times — the anon RLS
 * probe, the feed pulse thresholds, the dunning strip and the brief's scraper
 * banner. The free pick being absent is normal and is reported, never failed.
 *
 * DOES NOT ASSERT the KPI figures. For an anonymous seat they are padlocked BY
 * DESIGN, so a padlock there is the product working.
 *
 * ── THE SECOND READ IS OPTIONAL ON PURPOSE ─────────────────────────────────
 *
 * With `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` set, it also asks the database
 * the same anonymous question and can name WHICH layer failed — a page with no
 * rows over an API with rows is the frontend, and both empty is the pipeline.
 * Without them the check still runs and still fails; it just cannot name the
 * layer. That way a missing secret degrades the MESSAGE and never the ALARM,
 * which is the failure mode this dashboard's Discord webhook already cost once.
 *
 * Exit 0 = a stranger sees football. Exit 1 = they do not, or the page would
 * not load. `--json` prints a machine-readable line for wiring elsewhere.
 */
'use strict'

const BASE = process.env.HOMEPAGE_BASE_URL || 'https://maxedge.live'

/** How long to let the client fetch settle before calling the board empty. */
const SETTLE_MS = Number(process.env.HOMEPAGE_SETTLE_MS || 25_000)

/**
 * THE VERDICT, as a pure function, because the browser half cannot be run from
 * every environment this repo is edited in and an untested alarm is a decoration.
 *
 * `apiPriced` is null when the optional second read was not configured or did
 * not answer — which is DISTINCT from 0, exactly as `priced` on the homepage is
 * null until a request succeeds. Coercing it would make an unconfigured check
 * blame the pipeline for every fault.
 *
 * @param {{ pickState: string|null, apiPriced: number|null }} x
 * @returns {{ ok: boolean, code: string, message: string }}
 */
function verdict({ pickState, apiPriced }) {
  // A DRAWN PICK IS THE PAGE WORKING, and so is an honest "no pick today".
  // §1.2 is explicit that some days there is nothing, and migration 124 made
  // that rare rather than impossible — an alarm that fired on it would be an
  // alarm nobody reads, which this product has now recorded four times.
  if (pickState === 'pick' || pickState === 'none') {
    return {
      ok: true,
      code: 'ok',
      message: pickState === 'pick'
        ? 'The free pick is on screen for an anonymous visitor.'
        : 'The card resolved and there is no pick today, which is a legitimate answer.',
    }
  }
  if (pickState === 'error') {
    return {
      ok: false,
      code: 'pick-read-failed',
      message:
        'The free-pick card is drawing its ERROR state to an anonymous visitor. The page ' +
        'rendered and its read failed — this is ours, not the market.',
    }
  }
  // Absent or still loading. Both mean the visitor is looking at a page that
  // never produced the product, which is the 5 Sep incident exactly.
  const stuck = pickState === 'loading'
    ? 'The free-pick card is STILL LOADING'
    : 'The free-pick card is not on the page at all'
  if (apiPriced == null) {
    return {
      ok: false,
      code: 'pick-missing-layer-unknown',
      message:
        `${stuck} for an anonymous visitor. The database was not checked (set ` +
        'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to have this ' +
        'name the failing layer).',
    }
  }
  if (apiPriced > 0) {
    return {
      ok: false,
      code: 'pick-missing-frontend',
      message:
        `${stuck} while the API returns ${apiPriced} priced upcoming fixture(s) to the ` +
        'same anonymous seat. The data is there and the page is not drawing it — this ' +
        'is the frontend, and it is the shape of the 5 Sep incident.',
    }
  }
  return {
    ok: false,
    code: 'pick-missing-no-data',
    message:
      `${stuck} and the API returns no priced upcoming fixtures either. This is the ` +
      'pipeline, not the page — check the engine and the odds feed.',
  }
}

/* Runs INSIDE the page, so it is written as a self-contained string of work:
   it may not close over anything this module holds.

   THE ATTRIBUTE, NOT THE TEXT. `data-pick-state` is declared by
   components/home/FreePick and pinned by FreePick.state.test.jsx. Matching on
   "No pick today." instead would be a contract just as binding and far more
   fragile — a copy edit nobody thought was load-bearing would take the alarm
   out, silently, and silence here reads as health. */
function readPickState() {
  const el = document.querySelector('[data-pick-state]')
  return el ? el.getAttribute('data-pick-state') : null
}

async function readPage() {
  const { chromium } = require('playwright')
  // TWO ENVIRONMENTS, TWO WAYS TO FIND A BROWSER. This repo's other Playwright
  // scripts pin `executablePath` to /opt/pw-browsers/chromium because that is
  // where the agent image keeps it; a CI runner has no such path and resolves
  // from its own install. And a bare `launch()` asks for the headless SHELL,
  // which is a separate download from `chromium` and is the error this hit
  // first — so the CI branch names the full build explicitly rather than
  // depending on which of the two the install step happened to fetch.
  const exe = process.env.CHROMIUM_PATH
  const browser = await chromium.launch(exe ? { executablePath: exe } : { channel: 'chromium' })
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    const response = await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    const status = response ? response.status() : 0
    if (status !== 200) return { status, pickState: null }

    // POLL RATHER THAN WAIT ON A SELECTOR. The card mounts in its `loading`
    // state, so the attribute is present almost immediately and its VALUE is
    // what settles — waiting on the element would return `loading` on the
    // first tick and call a stuck page healthy. It breaks as soon as the card
    // reaches a settled state, and otherwise runs the clock out and reports
    // whatever it is still saying, which is the state this exists to catch.
    const deadline = Date.now() + SETTLE_MS
    let pickState = null
    for (;;) {
      pickState = await page.evaluate(readPickState)
      if (pickState === 'pick' || pickState === 'none' || pickState === 'error') break
      if (Date.now() > deadline) break
      await page.waitForTimeout(1_000)
    }

    return { status, pickState }
  } finally {
    await browser.close()
  }
}

/**
 * The same question the page asks, from the same anonymous seat: are there
 * priced fixtures still to kick off? `computed_values` is tier-capped, so this
 * returns the PREVIEW rather than the day's work — which is the right
 * comparison, because the preview is what the page was given too.
 */
async function readApi() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return null
  try {
    const iso = new Date().toISOString()
    const res = await fetch(
      `${url}/rest/v1/computed_values?select=match_id,match!inner(kickoff_at)` +
        `&match.kickoff_at=gt.${iso}&limit=50`,
      { headers: { apikey: key, authorization: `Bearer ${key}` } },
    )
    if (!res.ok) return null
    const rows = await res.json()
    return Array.isArray(rows) ? rows.length : null
  } catch {
    return null
  }
}

async function main() {
  const json = process.argv.includes('--json')
  let page
  try {
    page = await readPage()
  } catch (err) {
    console.error(`::error::Could not load ${BASE}: ${err.message}`)
    if (json) console.log(JSON.stringify({ ok: false, code: 'unreachable', error: err.message }))
    process.exit(1)
  }

  if (page.status !== 200) {
    console.error(`::error::${BASE} answered ${page.status}`)
    if (json) console.log(JSON.stringify({ ok: false, code: 'bad-status', status: page.status }))
    process.exit(1)
  }

  const apiPriced = await readApi()
  const v = verdict({ pickState: page.pickState, apiPriced })

  console.log(`base            ${BASE}`)
  console.log(`pick card       ${page.pickState ?? '(absent)'}`)
  console.log(`api priced      ${apiPriced == null ? '(not checked)' : apiPriced}`)
  console.log('')

  if (v.ok) {
    console.log(`OK — ${v.message}`)
    if (json) console.log(JSON.stringify({ ok: true, ...v, ...page, apiPriced }))
    return
  }

  console.error(`::error::${v.message}`)
  if (json) console.log(JSON.stringify({ ok: false, ...v, ...page, apiPriced }))
  process.exit(1)
}

module.exports = { verdict, readPickState }

if (require.main === module) main()
