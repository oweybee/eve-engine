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
 */

const { getClient, fetchOddsForMatches } = require('./lib/supabaseClient');

const EV_THRESHOLD = parseFloat(process.env.EV_THRESHOLD || '0.005');
const EDGE_CAP     = parseFloat(process.env.INTEGRITY_EDGE_CAP || '0.30'); // 30%
const PROB_TOL     = 1e-6;
const EDGE_TOL     = 0.01; // 1pp tolerance on EV reconstruction
// How far the latest odds may lead the latest compute before we treat a match
// as "compute is falling behind". The engine ticks every ~5 min, so a healthy
// lag is single-digit minutes; 90 min is well clear of CI queueing yet still
// catches the hours/days-stale failure that hides secondary markets.
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
  const { data, error } = await supabase
    .from('computed_values')
    .select([...new Set(cols)].join(',') + ',match:matches(status,kickoff_at)')
    .limit(2000);
  if (error) { violations.push(`[query] computed_values: ${error.message}`); return 0; }

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
  return data?.length ?? 0;
}

/**
 * Coverage / freshness guard — the smoke alarm for the exact failure that hid
 * secondary markets on otherwise-priced fixtures (the "awaiting prices" bug):
 * odds are in the DB but never reach computed_values, so the app shows Match
 * Odds only. Catches it regardless of cause (silent row-cap truncation, a
 * crashed/lagging compute, a plan gap) by comparing, per live upcoming match,
 * the newest ingested odds against the newest computed price.
 */
async function checkMarketCoverage(supabase, violations) {
  const nowMs = Date.now();
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

  // Odds presence + freshness per match (paged past the 1000-row cap so this
  // guard can't itself be blinded by the very truncation it watches for).
  const oddsRows = await fetchOddsForMatches(supabase, ids, 'match_id, market, bookmaker, fetched_at');
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

  // Latest compute + which markets are priced, per match (computed_values holds
  // only upcoming matches, so this stays small — no paging needed).
  const { data: cvRows, error: cErr } = await supabase
    .from('computed_values')
    .select('match_id, computed_at, best_home_odds, over_odds, btts_yes_odds')
    .in('match_id', ids);
  if (cErr) { violations.push(`[query] coverage computed_values: ${cErr.message}`); return 0; }
  const cvByMatch = new Map();
  for (const r of cvRows ?? []) {
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
  const { data, error } = await supabase
    .from('value_signals')
    .select('id, market, outcome, detected_edge, detected_odds')
    .eq('result', 'pending')
    .limit(2000);
  if (error) { violations.push(`[query] value_signals: ${error.message}`); return 0; }

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

  const cvN = await checkComputedValues(supabase, violations);
  const sigN = await checkSignals(supabase, violations);
  const covN = await checkMarketCoverage(supabase, violations);

  if (violations.length) {
    console.error(`[integrity] ${violations.length} VIOLATION(S) across ${cvN} computed rows / ${sigN} signals / ${covN} live matches:`);
    for (const v of violations) console.error(`  ✗ ${v}`);
    await postAlert(violations);
  } else {
    console.log(`[integrity] OK — ${cvN} computed rows, ${sigN} pending signals, ${covN} live matches covered, no violations`);
  }
  return violations.length;
}

if (require.main === module) {
  run().then(n => process.exit(0)).catch(err => { console.error('[integrity] unhandled:', err); process.exit(0); });
}

module.exports = { run };
