/**
 * fetchResults.js — settles value signals and refreshes the performance summary.
 *
 * 1. Finds value_signals with result = 'pending' whose kickoff was > 2h ago.
 * 2. Looks up the actual match result from API-Football (API-Sports) and sets
 *    result = 'win' | 'loss' on each signal, plus closing_odds, clv and
 *    no_vig_clv from `closing_lines` — the price vector quoted STRICTLY before
 *    kickoff, Shin-de-vigged and frozen by captureClosingLines.js.
 *      clv        = ln(detected_odds) − ln(closing_odds)   vs the closing PRICE
 *      no_vig_clv = ln(detected_odds) − ln(no_vig_odds)    vs the FAIR close
 *    The second is the one that means something: beating a price with the
 *    bookmaker's margin still in it is not hard, and across 671 settled h2h
 *    rows the two read -2.51% and +4.36% on the same bets.
 * 3. Recomputes performance_summary (win rate, yield, ROI, avg CLV, …) from the
 *    full settled history.
 *
 * If API_FOOTBALL_KEY is not set it skips settlement (no-op) but still refreshes
 * the summary so the pipeline never fails just because results aren't wired up yet.
 *
 * ── THE CADENCE COMES FROM THE LOOP, NOT FROM THE CRON ──────────────────────
 *
 * This was step 10 of engine.yml, so settlement could only happen as often as
 * the heaviest job in the repo, and only if that job's schedule was delivered.
 * On 27 Aug 2026 it was not: engine.yml ran at 11:12 UTC and then not again
 * until 21:02 — a 9h50m gap on an every-15-minutes cron, with no failed run to show for
 * it, because a schedule that never fires produces nothing to fail. Every
 * fixture on the European evening card kicked off inside that window, so 39
 * matches sat at status='live', `settle_match_signals()` refuses anything that
 * is not 'completed', and every signal on them stayed pending. Two PRIME picks
 * that had won were missing from /performance for three hours after full time.
 *
 * The same outage cost more than a delay. capture-closing-lines.yml went
 * 05:07 -> 16:26, both kickoffs landed after its last run, and those two rows
 * settled with a null CLV.
 *
 * So the job POLLS ITSELF, the pattern fetchLineups.js and runInplayLoop.js
 * already use for the same reason. One GitHub tick keeps a process alive for
 * RESULTS_LOOP_MINUTES, running a pass every RESULTS_PASS_INTERVAL_SECONDS.
 * The cron's only duty is to make sure a process is running at all.
 *
 *   node fetchResults.js            poll for RESULTS_LOOP_MINUTES
 *   node fetchResults.js --once     one pass, then exit (the old behaviour)
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');
const { classifyTier, dedupeConflicts } = require('./lib/signalTier');
const { beginWatchdog } = require('./lib/watchdog');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Clean-slate epoch: the SUMMARY below counts only signals detected on or after
// this instant. Everything before it was generated under different selection
// rules and must not be reported as evidence for the current ones.
//
// MOVED 6 AUG 2026, the second reset since launch. The conviction ladder
// unified on this date and PRIME now needs BOTH the odds+edge box and an MXS of
// 65+, where before it needed only the box — a different rule, so the two sets
// cannot share a headline. Measured over the 366 settled signals at the time,
// 208 came from MARKET_CONSENSUS and 54 from API_PREDICTIVE, both switched off
// in the 5 Aug audit, and together they dominated every figure.
//
// NOTHING IS DELETED AND NOTHING STOPS BEING GRADED. This constant is read in
// exactly one place — the summarise step at the foot of this file — so results
// are still settled for every signal whatever its age, and /performance still
// shows the older record under the notice naming the architectures behind it.
// Deleting an unflattering record because it came from a withdrawn model is the
// same failure as publishing it as an edge, pointed the other way (5 Aug).
//
// Must equal PERFORMANCE_EPOCH in eve-frontend/lib/epoch.js, which also derives
// the date the site prints. Override with the env var if the slate is reset
// again.
const PERFORMANCE_EPOCH = process.env.PERFORMANCE_EPOCH || '2026-08-06T16:00:00Z';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;

const API_FOOTBALL_HOST = 'v3.football.api-sports.io';
const SETTLE_DELAY_MS = 2 * 60 * 60 * 1000; // only settle signals 2h+ past kickoff

const ONCE = process.argv.includes('--once');

/**
 * How long one tick stays alive. 50 minutes, matching fetchLineups.js: LONGER
 * than the median gap GitHub actually delivers between ticks, so a fresh tick
 * usually lands while a loop is still running and queues behind it, closing
 * the seam instead of leaving one. Raise this, not the cron, if gaps reappear.
 */
const LOOP_MINUTES = parseFloat(process.env.RESULTS_LOOP_MINUTES || '50');

/**
 * How often to settle, inside that. THIS is the real cadence, and 15 minutes
 * rather than the 5 fetchLineups uses is a COST decision with a number behind
 * it. `settleFinishedMatches` selects every scheduled/live fixture past the
 * cutoff with no lower bound on kickoff_at, and on 27 Aug 2026 that was 78
 * rows across 45 DISTINCT DATES, oldest 23 Oct 2022 — the fixtures the feed
 * never settled. One pass is therefore ~45 API-Football calls, 44 of them for
 * dates that will never resolve. At a 5-minute interval that is ~13,000
 * requests a day against a 75,000 budget, spent on nothing.
 *
 * A lineup expires; a result does not. Settling within 15 minutes instead of
 * within ten hours is the whole win here, and the last five minutes of it are
 * not worth a sixth of the daily allowance.
 */
const PASS_INTERVAL_SECONDS = parseFloat(process.env.RESULTS_PASS_INTERVAL_SECONDS || '900');

/**
 * How long a settleable signal may sit unsettled before the run says so out
 * loud. This is the alarm the 27 Aug outage did not have: nothing anywhere
 * measured "the settler has not run", so ten hours of silence looked exactly
 * like a quiet afternoon.
 */
const STALE_AFTER_MINUTES = parseFloat(process.env.RESULTS_STALE_AFTER_MINUTES || '90');

/**
 * How far back a pending signal still counts as a BACKLOG rather than a fact
 * about the feed. Measured on production the night this was written: of the 11
 * signals pending past their settle window, NOT ONE was under a day old, none
 * sat on a completed match, and the oldest kickoff was 8 Aug — every one of
 * them on a fixture API-Football has never returned as finished. A count-based
 * alarm would therefore read 11 for ever and be ignored within a week, which
 * is worse than no alarm. So the horizon excludes them and they are reported
 * as a plain line instead.
 */
const BACKLOG_HORIZON_HOURS = parseFloat(process.env.RESULTS_BACKLOG_HORIZON_HOURS || '24');

function getClient() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}

// Normalise a team name for fuzzy matching across data sources.
function norm(s) {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(fc|cf|afc|sc|fk)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// A few known DB ↔ API-Football name differences.
const NAME_ALIASES = {
  southkorea: 'korearepublic',
  usa: 'unitedstates',
  ussr: 'russia',
};
function aliasNorm(s) {
  const n = norm(s);
  return NAME_ALIASES[n] ?? n;
}
function namesMatch(a, b) {
  const na = aliasNorm(a), nb = aliasNorm(b);
  return na === nb || na.includes(nb) || nb.includes(na);
}

// ---------------------------------------------------------------------------
// API-Football: fetch all fixtures for a UTC date (one call per date, cached)
// ---------------------------------------------------------------------------

async function fetchFixturesForDate(date, cache) {
  if (cache.has(date)) return cache.get(date);
  const url = `https://${API_FOOTBALL_HOST}/fixtures?date=${date}`;
  // P0-3 upstream: do NOT cache on error — a transient 5xx would permanently
  // mark every signal that day as unmatched. Let the caller retry on the next run.
  const res = await fetch(url, {
    headers: { 'x-apisports-key': API_FOOTBALL_KEY },
  });
  if (!res.ok) {
    throw new Error(`API-Football ${date}: HTTP ${res.status}`);
  }
  const json = await res.json();
  const fixtures = json?.response ?? [];
  cache.set(date, fixtures);
  return fixtures;
}

// Maps a finished fixture to the winning outcome: 'home' | 'draw' | 'away' | null.
function fixtureOutcome(fx) {
  const status = fx?.fixture?.status?.short;
  if (!['FT', 'AET', 'PEN'].includes(status)) return null; // not finished
  const hg = fx?.goals?.home, ag = fx?.goals?.away;
  if (hg == null || ag == null) return null;
  if (hg > ag) return 'home';
  if (hg < ag) return 'away';
  return 'draw';
}

/**
 * Resolves a market selection against a FINAL scoreline, RESPECTING THE MARKET.
 * The old code compared the 1X2 result to sig.outcome directly, so any secondary
 * selection ('btts_yes', 'over', …) could never equal 'home'/'draw'/'away' and
 * was always marked a loss. This resolves each market from the goals alone:
 *   h2h     → match result
 *   btts    → did both teams score
 *   totals  → total goals vs the .5 line
 *   corners / bookings → not derivable from goals; returns null (unsettleable)
 * Returns 'win' | 'loss' | null (null = missing goals, or unsettleable market).
 *
 * Pure and stateless so it can settle from EITHER the API fixture payload or the
 * authoritative matches.goals columns, and so reconcileSettledSignals can replay
 * it over already-settled rows.
 */
function resultFromGoals(hg, ag, market, outcome, line) {
  if (hg == null || ag == null) return null;

  const oc = (outcome ?? '').toLowerCase();
  const mk = (market ?? 'h2h').toLowerCase();

  if (mk === 'h2h' || oc === 'home' || oc === 'draw' || oc === 'away') {
    const res = hg > ag ? 'home' : hg < ag ? 'away' : 'draw';
    return res === oc ? 'win' : 'loss';
  }
  if (mk === 'btts' || oc.includes('btts') || oc === 'yes' || oc === 'no') {
    const both = hg > 0 && ag > 0;
    if (oc.includes('yes')) return both ? 'win' : 'loss';
    if (oc.includes('no'))  return both ? 'loss' : 'win';
    return null;
  }
  if (mk === 'totals') {
    // Guard null/'' explicitly — Number(null) is 0, which would silently settle
    // against a phantom 0.5-style line. A totals signal with no line is unsettleable.
    const L = (line == null || line === '') ? NaN : Number(line);
    if (!Number.isFinite(L)) return null;
    const total = hg + ag;
    if (oc === 'over')  return total > L ? 'win' : 'loss';
    if (oc === 'under') return total < L ? 'win' : 'loss';
    return null;
  }
  // corners / bookings — needs the statistics endpoint, not goals. Leave pending.
  return null;
}

/**
 * Settles a single value signal against a finished API fixture. Thin wrapper:
 * gates on the fixture being finished, then defers to resultFromGoals.
 * Returns 'win' | 'loss' | null (null = not finished, or unsettleable market).
 */
function settleSignal(fx, market, outcome, line) {
  const status = fx?.fixture?.status?.short;
  if (!['FT', 'AET', 'PEN'].includes(status)) return null; // not finished
  return resultFromGoals(fx?.goals?.home, fx?.goals?.away, market, outcome, line);
}

// ---------------------------------------------------------------------------
// Match status settlement
//
// fetchResults historically only settled value_signals — it never updated
// matches.status. Once a match kicked off it stayed 'scheduled' forever, so
// computeValues/computeApiValues (WHERE status IN ('scheduled','live')) kept
// recomputing dead fixtures indefinitely, polluting Market Pulse with games
// that already finished. This routine flips finished matches to 'completed'
// AND writes the final scoreline (goals + result: home/draw/away).
//
// INVARIANT: a match is only ever set to 'completed' TOGETHER with a non-null
// scoreline. A completed match with no goals is meaningless — it silently
// vanishes from Recent Form (fetchTeamForm filters null goals), team stats and
// ELO — so we never create one. A draw is a first-class result here: 0-0 / 1-1
// settle exactly like any other score (result='draw'), never dropped.
//
// Two failure modes this heals, on top of the normal scheduled→completed flow:
//   1. STRANDED rows — a match left 'completed' with NULL goals by some earlier
//      path. The old query only looked at scheduled/live, so such a row was
//      invisible to settlement forever. We now re-select and re-settle them.
//   2. NON-NUMERIC ids — Betfair/Odds-API fixtures carry a hash external_id, so
//      the old exact-fixture-id lookup skipped them entirely. We fall back to
//      matching API-Football's fixtures for that date by team name.
//
// Duplicate guard: the same fixture can exist twice (API-Football numeric id +
// Betfair/Odds-API hash id). We never settle a row whose (home, away, date) is
// already completed-with-a-score on another row, so a match is never
// double-counted in form / ELO / training.
// ---------------------------------------------------------------------------

const MATCH_SELECT_COLS =
  'id, external_id, kickoff_at, status, home_team_id, away_team_id, ' +
  'home_team:teams!matches_home_team_id_fkey ( name ), ' +
  'away_team:teams!matches_away_team_id_fkey ( name )';

const dayKey = (homeId, awayId, iso) => `${homeId}|${awayId}|${(iso ?? '').slice(0, 10)}`;

async function settleFinishedMatches(supabase, cache) {
  const cutoff = new Date(Date.now() - SETTLE_DELAY_MS).toISOString();

  // (a) scheduled/live past kickoff — the normal settlement queue.
  const { data: stale, error } = await supabase
    .from('matches')
    .select(MATCH_SELECT_COLS)
    .in('status', ['scheduled', 'live'])
    .lt('kickoff_at', cutoff);
  if (error) throw new Error(`settleFinishedMatches(select scheduled): ${error.message}`);

  // (b) stranded — 'completed' but missing a scoreline. Re-settle so they get a
  // real result (incl. draws) instead of being dropped everywhere downstream.
  const { data: stranded, error: strErr } = await supabase
    .from('matches')
    .select(MATCH_SELECT_COLS)
    .eq('status', 'completed')
    .or('goals_home.is.null,goals_away.is.null')
    .lt('kickoff_at', cutoff);
  if (strErr) throw new Error(`settleFinishedMatches(select stranded): ${strErr.message}`);

  const matches = [...(stale ?? []), ...(stranded ?? [])];
  if (!matches.length) {
    console.log('[results] no past-kickoff matches awaiting status settlement');
    return { completed: 0, pending: 0 };
  }
  if (!API_FOOTBALL_KEY) {
    console.log(`[results] ${matches.length} match(es) past kickoff but API_FOOTBALL_KEY not set — skipping status settlement`);
    return { completed: 0, pending: matches.length };
  }

  // Seed the duplicate guard with fixtures ALREADY completed-with-a-score, so a
  // hash twin is never settled into a second copy of a match we already have.
  const settledKeys = new Set();
  const teamIds = [...new Set(matches.flatMap(m => [m.home_team_id, m.away_team_id]).filter(Boolean))];
  if (teamIds.length) {
    const { data: done } = await supabase
      .from('matches')
      .select('home_team_id, away_team_id, kickoff_at')
      .eq('status', 'completed')
      .not('goals_home', 'is', null)
      .not('goals_away', 'is', null)
      .or(`home_team_id.in.(${teamIds.join(',')}),away_team_id.in.(${teamIds.join(',')})`);
    for (const d of done ?? []) settledKeys.add(dayKey(d.home_team_id, d.away_team_id, d.kickoff_at));
  }

  let completed = 0, stillPending = 0, skippedDup = 0;
  for (const m of matches) {
    const key = dayKey(m.home_team_id, m.away_team_id, m.kickoff_at);
    if (settledKeys.has(key)) { skippedDup++; continue; } // twin already scored

    const date = new Date(m.kickoff_at).toISOString().slice(0, 10); // UTC YYYY-MM-DD
    let fixtures;
    try {
      fixtures = await fetchFixturesForDate(date, cache);
    } catch (err) {
      // Transient API error — leave this match for the next run.
      console.warn(`  [results] status skip fixture ${m.external_id}: ${err.message}`);
      stillPending++;
      continue;
    }

    // Numeric external_id → exact API-Football fixture id (authoritative).
    // Otherwise (Betfair/Odds-API hash id) → match by team name on that date.
    const numeric = /^\d+$/.test(m.external_id ?? '');
    const fx = numeric
      ? fixtures.find(f => String(f?.fixture?.id) === m.external_id)
      : fixtures.find(f =>
          namesMatch(m.home_team?.name, f?.teams?.home?.name) &&
          namesMatch(m.away_team?.name, f?.teams?.away?.name));

    const outcome = fx ? fixtureOutcome(fx) : null;
    // fixtureOutcome only returns non-null when the fixture is FT/AET/PEN AND
    // both goals are present — so reaching here guarantees a real scoreline.
    // Never write 'completed' without one (the whole point of this fix).
    if (!outcome) { stillPending++; continue; }

    const { error: upErr } = await supabase
      .from('matches')
      .update({
        status:     'completed',
        goals_home: fx.goals.home,
        goals_away: fx.goals.away,
        result:     outcome,
      })
      .eq('id', m.id);
    if (upErr) {
      console.warn(`  [results] status update ${m.id} failed: ${upErr.message}`);
      stillPending++;
      continue;
    }
    settledKeys.add(key); // block any twin later in this batch
    completed++;
  }

  console.log(`[results] match status: completed ${completed}, still pending ${stillPending}, dup-skipped ${skippedDup}`);
  return { completed, pending: stillPending, skippedDup };
}

// ---------------------------------------------------------------------------
// Closing Betfair price for CLV (best-effort)
// ---------------------------------------------------------------------------


/**
 * Best-effort closing price: a 'closing' odds_snapshot if captured, otherwise the
 * latest Betfair Exchange price we recorded for the match before kickoff.
 */
/**
 * Bulk-prefetch closing odds for all pending signals in 2 queries instead of
 * 2×N serial round-trips. Returns Map<`${matchId}:${outcome}`, number|null>.
 */
async function prefetchClosingOdds(supabase, signals) {
  const matchIds = [...new Set(signals.map(s => s.match_id).filter(Boolean))];
  if (!matchIds.length) return new Map();

  // `closing_lines` ONLY. It is the last price vector quoted STRICTLY BEFORE
  // kickoff, Shin-de-vigged and frozen once (migration 061), and the constraint
  // `quoted_at <= kickoff_at` is enforced by the database rather than hoped for.
  //
  // WHAT THIS REPLACED, AND WHY NOTHING FALLS BACK TO IT. The old reader took
  // `odds_snapshots` where `snapshot_type = 'closing'`, a label
  // captureSnapshot.js applies from 60 minutes BEFORE kickoff to 180 minutes
  // AFTER: 22,988 of the 32,303 rows carrying it were captured after kickoff,
  // and the median one is 42 MINUTES INTO THE MATCH. Failing that it took the
  // latest Betfair Exchange price, read at settlement time — two hours past
  // kickoff, so on a finished match. Both are in-play prices on a match whose
  // score has already moved, which is not a noisy closing line but a different
  // quantity.
  //
  // A fixture with no closing line gets NO CLV. That is the honest answer and
  // it is why there is no fallback here: the fallbacks were the bug.
  const out = new Map();
  const CHUNK = 200;
  for (let i = 0; i < matchIds.length; i += CHUNK) {
    const slice = matchIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('closing_lines')
      .select('match_id, market, market_line, selection, closing_odds, no_vig_odds, basis')
      .in('match_id', slice);
    if (error) throw new Error(`closing_lines: ${error.message}`);
    for (const r of data ?? []) {
      out.set(closingKey(r.match_id, r.market, r.market_line, r.selection), {
        closing: parseFloat(r.closing_odds),
        noVig:   parseFloat(r.no_vig_odds),
        basis:   r.basis,
      });
    }
  }
  return out;
}

/** The identity of a closing line. The LINE is part of it: a price at one
 *  handicap benchmarked against another handicap's close is not CLV. */
function closingKey(matchId, market, line, selection) {
  const m = market ?? 'h2h';
  const l = line == null ? 'null' : String(Number(line));
  return `${matchId}|${m}|${l}|${selection}`;
}

// ---------------------------------------------------------------------------
// 1+2. Settle pending signals
// ---------------------------------------------------------------------------

async function settlePendingSignals(supabase, cache = new Map()) {
  const cutoff = new Date(Date.now() - SETTLE_DELAY_MS).toISOString();
  const { data: pending, error } = await supabase
    .from('value_signals')
    .select(`
      id, match_id, outcome, detected_odds, kickoff_at, result, market, market_line, phase,
      match:matches (
        kickoff_at, status, goals_home, goals_away,
        home_team:teams!matches_home_team_id_fkey ( name ),
        away_team:teams!matches_away_team_id_fkey ( name )
      )
    `)
    .eq('result', 'pending')
    .lt('kickoff_at', cutoff);

  if (error) throw new Error(`settlePendingSignals(select): ${error.message}`);
  if (!pending?.length) {
    console.log('[results] no pending signals ready to settle');
    return { settled: 0, unmatched: 0 };
  }

  if (!API_FOOTBALL_KEY) {
    console.log(`[results] ${pending.length} signal(s) pending but API_FOOTBALL_KEY not set — skipping settlement`);
    return { settled: 0, unmatched: pending.length };
  }

  // Bulk-prefetch closing odds (2 queries instead of 2×N serial round-trips)
  const closingMap = await prefetchClosingOdds(supabase, pending);

  let settled = 0, unmatched = 0;

  for (const sig of pending) {
    const home = sig.match?.home_team?.name;
    const away = sig.match?.away_team?.name;
    const kickoff = sig.kickoff_at ?? sig.match?.kickoff_at;
    if (!home || !away || !kickoff) { unmatched++; continue; }

    // Prefer the AUTHORITATIVE score. settleFinishedMatches settles matches by
    // EXACT API-Football fixture id and runs before us, so matches.goals is the
    // source of truth. Settling from it (rather than a fuzzy name+date re-fetch)
    // means a signal can never be resolved against the wrong same-day fixture,
    // and the two passes can never disagree.
    let result = null;
    if (sig.match?.status === 'completed') {
      result = resultFromGoals(sig.match.goals_home, sig.match.goals_away,
                               sig.market, sig.outcome, sig.market_line);
    }

    // Fallback: matches.goals not available (e.g. non-numeric external_id that
    // settleFinishedMatches skips) — resolve via the dated fixtures fetch.
    if (result == null && sig.match?.status !== 'completed') {
      const date = new Date(kickoff).toISOString().slice(0, 10); // UTC YYYY-MM-DD
      let fixtures;
      try {
        fixtures = await fetchFixturesForDate(date, cache);
      } catch (err) {
        // Transient API error — leave this signal pending for the next run.
        console.warn(`  [results] skip ${home} vs ${away}: ${err.message}`);
        unmatched++;
        continue;
      }
      const fx = fixtures.find(f =>
        namesMatch(home, f?.teams?.home?.name) && namesMatch(away, f?.teams?.away?.name)
      );
      // Market-aware: 1X2 by result, BTTS by both-scored, totals by goal line.
      // Corners/cards return null and stay pending (not derivable from goals).
      result = fx ? settleSignal(fx, sig.market, sig.outcome, sig.market_line) : null;
    }
    if (result == null) { unmatched++; continue; }

    // CLV is undefined for in-play signals — the line already closed at kickoff,
    // so a pre-kickoff benchmark is not one. Store null rather than a
    // misleading number; in-play is judged on realised yield.
    const isInplay = sig.phase === 'inplay';
    const line     = isInplay
      ? null
      : (closingMap.get(closingKey(sig.match_id, sig.market, sig.market_line, sig.outcome)) ?? null);
    const detected = parseFloat(sig.detected_odds);
    const usable   = v => Number.isFinite(v) && v > 1;

    // TWO MEASURES, AND THE SECOND IS THE ONE THAT MEANS SOMETHING.
    //   clv         vs the closing PRICE — beating a price with the
    //               bookmaker's margin still in it is not hard, so this
    //               number runs several points flatteringly positive.
    //   no_vig_clv  vs the Shin-de-vigged FAIR close. This is the measure
    //               `paper_trade_gate()` opens the publication gate on, and
    //               across 671 settled h2h rows it reads -2.51% where the
    //               vig-inclusive one reads +4.36%. Same bets, same closes.
    // Guard against NaN/Infinity before the logarithm: an invalid price gives
    // null, never a garbage number.
    const ok  = !isInplay && line && usable(detected);
    const clv = ok && usable(line.closing)
      ? +(Math.log(detected) - Math.log(line.closing)).toFixed(4) : null;
    const noVigClv = ok && usable(line.noVig)
      ? +(Math.log(detected) - Math.log(line.noVig)).toFixed(4) : null;
    const closing = ok && usable(line.closing) ? line.closing : null;

    const { error: upErr } = await supabase
      .from('value_signals')
      .update({ result, closing_odds: closing, clv, no_vig_clv: noVigClv })
      .eq('id', sig.id);
    if (upErr) { console.warn(`  [results] update ${sig.id} failed: ${upErr.message}`); continue; }

    settled++;
    console.log(`  [results] ${home} vs ${away} (${sig.outcome}) → ${result}${clv != null ? ` clv=${clv}` : ''}`);
  }

  console.log(`[results] settled ${settled}, unmatched ${unmatched}`);
  return { settled, unmatched };
}

// ---------------------------------------------------------------------------
// 2b. Reconcile already-settled signals against the authoritative score
//
// Settlement used to be write-once: settlePendingSignals only ever touches
// result='pending', so any signal settled against a WRONG result stayed wrong
// forever. That bit us badly — an earlier settleSignal bug marked every
// secondary-market signal (btts/totals) a loss regardless of the score; the
// code was fixed but the already-settled rows kept their bogus 'loss',
// understating tracked performance.
//
// This pass replays resultFromGoals over every settled signal whose match has a
// final score and corrects any mismatch. It settles from matches.goals (exact
// fixture id), so it is self-healing: whatever caused a wrong settlement — old
// bug, a provisional in-play score, a fuzzy mismatch — is fixed once the true
// score is known. Only `result` is rewritten; closing_odds/clv are captured at
// the close and do not depend on the outcome.
// ---------------------------------------------------------------------------

async function reconcileSettledSignals(supabase) {
  const { data: rows, error } = await supabase
    .from('value_signals')
    .select(`
      id, outcome, market, market_line, result,
      match:matches ( status, goals_home, goals_away )
    `)
    .in('result', ['win', 'loss']);

  if (error) throw new Error(`reconcileSettledSignals(select): ${error.message}`);
  if (!rows?.length) return { corrected: 0 };

  let corrected = 0;
  for (const sig of rows) {
    const m = sig.match;
    if (!m || m.status !== 'completed' || m.goals_home == null || m.goals_away == null) continue;

    const correct = resultFromGoals(m.goals_home, m.goals_away, sig.market, sig.outcome, sig.market_line);
    if (correct == null || correct === sig.result) continue;

    const { error: upErr } = await supabase
      .from('value_signals')
      .update({ result: correct })
      .eq('id', sig.id);
    if (upErr) { console.warn(`  [results] reconcile ${sig.id} failed: ${upErr.message}`); continue; }

    corrected++;
    console.log(`  [results] reconciled ${sig.market}/${sig.outcome}: ${sig.result} → ${correct}`);
  }

  console.log(`[results] reconciled ${corrected} mis-settled signal(s)`);
  return { corrected };
}

// ---------------------------------------------------------------------------
// 3. Performance summary
// ---------------------------------------------------------------------------

function avg(arr) {
  return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null;
}

/**
 * Aggregates the full value_signals history into one performance_summary row.
 *   win_rate = wins / (wins + losses)
 *   yield    = Σ profit / settled        (profit = odds−1 if win else −1, 1u stake)
 *   roi      = Σ profit / 100u bankroll   (growth on a fixed bankroll — distinct
 *                                          from level-stakes yield)
 */
const ROI_BANKROLL_UNITS = 100;

/**
 * THE SAMPLE IS NOT INDEPENDENT, AND THE HEADLINE WAS COMPUTED AS IF IT WERE.
 *
 * A yield over N settled SIGNALS treats every signal as one observation. They
 * are not: the engine writes several signals per fixture, and their outcomes
 * are driven by the same ninety minutes. On the live tracked cohort, 90 settled
 * signals came from 56 fixtures — so the effective sample is a third smaller
 * than the number the site was quoting a yield over, and the error bars are
 * correspondingly wider than the ones nobody was drawing.
 *
 * The unit of independence is the MATCH. `yield_clustered` averages the P/L
 * within a fixture first and then across fixtures; `yield_z` is that mean over
 * its own standard error. On the live cohort:
 *
 *     per signal    n=90  yield +8.57%   z 0.70
 *     per match     n=56  yield +14.80%  z 0.98
 *
 * Clustering did not make the number smaller here — it made the number HONEST,
 * and the honest number carries a z below 1. A yield you cannot distinguish
 * from zero is not a result, and `paper_trade_gate()` already sets this
 * platform's own standard at 300 settled bets with z above 2.
 */
const MIN_SETTLED_MATCHES = 100;
const MIN_YIELD_Z = 2.0;

function stddev(arr) {
  if (arr.length < 2) return null;
  const m = avg(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
}

/** Aggregate one phase's slice of value_signals into a summary object. */
function summarisePhase(rows, { includeClv }) {
  const settled = rows.filter(r => r.result === 'win' || r.result === 'loss');
  const wins   = settled.filter(r => r.result === 'win').length;
  const losses = settled.filter(r => r.result === 'loss').length;
  const plOf   = r => (r.result === 'win' ? (parseFloat(r.detected_odds) - 1) : -1);
  const profit = settled.reduce((s, r) => s + plOf(r), 0);

  // One observation per fixture: mean P/L within the match, then across matches.
  const byMatch = new Map();
  for (const r of settled) {
    const k = r.match_id ?? r.id;
    if (!byMatch.has(k)) byMatch.set(k, []);
    byMatch.get(k).push(plOf(r));
  }
  const matchPls = [...byMatch.values()].map(avg);
  const clusteredYield = matchPls.length ? avg(matchPls) : null;
  const sd = stddev(matchPls);
  const yieldZ = (clusteredYield != null && sd != null && sd > 0 && matchPls.length > 1)
    ? clusteredYield / (sd / Math.sqrt(matchPls.length))
    : null;

  const clvs    = settled.map(r => r.clv).filter(v => v != null).map(Number);
  const noVigs  = settled.map(r => r.no_vig_clv).filter(v => v != null).map(Number);
  const edges   = rows.map(r => r.detected_edge).filter(v => v != null).map(Number);
  const messes  = rows.map(r => r.detected_mes).filter(v => v != null).map(Number);

  // THE GATE ON PUBLISHING A YIELD AT ALL. Both conditions, and the reason is
  // recorded so a surface can say why it is showing nothing rather than
  // silently rendering an empty state that reads like a quiet day.
  let insufficientReason = null;
  if (matchPls.length < MIN_SETTLED_MATCHES) {
    insufficientReason =
      `${matchPls.length} settled ${matchPls.length === 1 ? 'fixture' : 'fixtures'} — ` +
      `below the ${MIN_SETTLED_MATCHES} this platform requires before a yield is a result`;
  } else if (yieldZ == null || Math.abs(yieldZ) < MIN_YIELD_Z) {
    insufficientReason =
      `yield z = ${yieldZ == null ? 'n/a' : yieldZ.toFixed(2)} — ` +
      `indistinguishable from zero at the ${MIN_YIELD_Z} sigma this platform requires`;
  }

  return {
    total_signals:   rows.length,
    settled_signals: settled.length,
    wins,
    losses,
    win_rate: settled.length ? +(wins / settled.length).toFixed(4) : null,
    yield:    settled.length ? +(profit / settled.length).toFixed(4) : null,
    roi:      settled.length ? +(profit / ROI_BANKROLL_UNITS).toFixed(4) : null,

    // The clustered figures are the ones a surface should publish.
    settled_matches: matchPls.length,
    yield_clustered: clusteredYield != null ? +clusteredYield.toFixed(4) : null,
    yield_z:         yieldZ != null ? +yieldZ.toFixed(2) : null,
    insufficient:        insufficientReason != null,
    insufficient_reason: insufficientReason,

    // CLV is only meaningful pre-match (the close happens at kickoff). In-play
    // is judged on realised yield/strike-rate alone.
    //
    // BOTH CLV MEASURES, because they disagree by more than six points on the
    // same bets and only one of them is hard to achieve. `avg_clv` is measured
    // against the closing PRICE, margin still in it; `avg_no_vig_clv` against
    // the Shin-de-vigged FAIR close, which is the measure `paper_trade_gate()`
    // opens the publication gate on. Across the settled book they read +4.98%
    // and -1.55%.
    avg_clv:        includeClv && clvs.length   ? +avg(clvs).toFixed(4)   : null,
    avg_no_vig_clv: includeClv && noVigs.length ? +avg(noVigs).toFixed(4) : null,
    clv_sample:     includeClv ? clvs.length : null,
    avg_edge: edges.length  ? +avg(edges).toFixed(4)  : null,
    avg_mes:  messes.length ? +avg(messes).toFixed(1) : null,
  };
}

/**
 * Recompute the performance rows from the settled history:
 *   singleton_key='current'    phase='prematch' — the CLV-tracked headline
 *   singleton_key='inplay'     phase='inplay'   — yield/strike-rate, no CLV
 *   singleton_key='supermodel' phase='prematch' — the learning model, alone
 *
 * Keeping them separate is what stops in-play picks from skewing CLV, and — as
 * of 1 Aug — what stops the learning model from being scored inside a headline
 * it has not earned. The supermodel began publishing value_signals on that date
 * after months of driving nothing; folding an unproven forecast into the number
 * the entire product's credibility rests on would corrupt the one figure a
 * sceptic checks. It accrues its own record in public instead, and its trust
 * weight rises on that evidence or not at all.
 */
async function calculatePerformance(supabase) {
  const { data, error } = await supabase
    .from('value_signals')
    .select('result, detected_odds, detected_edge, detected_mes, clv, no_vig_clv, phase, detected_at, match_id, market, market_line, model_architecture, signal_category');
  if (error) throw new Error(`calculatePerformance(select): ${error.message}`);

  const rows = data ?? [];
  // Legacy rows (phase NULL) predate the in-play engine and were pre-match.
  const prematchRows = rows.filter(r => (r.phase ?? 'prematch') !== 'inplay');
  const inplayRows   = rows.filter(r => r.phase === 'inplay');

  // Headline performance reflects PRIME signals only — and only those detected
  // on/after the clean-slate epoch. Value and longshot picks stay visible on the
  // site as a tool but must never distort the tracked win-rate / yield / ROI.
  //
  // THE BUCKET IS READ, NOT RE-DERIVED, AND THAT IS THE FIX (27 Aug 2026).
  // This asked `classifyTier(odds, edge)`, which answers with TODAY's
  // thresholds — so every time the eligibility box moved, the settled record
  // re-sorted itself underneath the headline. Measured over settled prematch
  // rows since the epoch, deduped:
  //
  //     from the stored bucket    85 rows   42 wins   49.4%
  //     re-derived with today's   34 rows   20 wins   58.8%
  //
  // Fifty-one signals this engine had published as prime, twenty-two of them
  // winners, had dropped out of their own history because PRIME_EDGE_MIN moved
  // to 5% on 26 Aug — and the number left behind was the FLATTERING one. A
  // record that improves when a constant changes is not a record.
  //
  // `signal_category` is stamped at write time by categoryFor() in
  // computeValues.js, so it is the bucket the product actually broadcast. The
  // EDGE band needs no exception here: rows written since 26 Aug carry 'edge'
  // and stay out of the headline exactly as lib/signalTier intends, while older
  // rows carry the bucket they were published under. Nothing is rewritten and
  // the asymmetry ages out on its own.
  //
  // Falls back to the live classification only where the column is absent —
  // production has none, and dropping a settled signal is worse than dating it.
  const epochMs = new Date(PERFORMANCE_EPOCH).getTime();
  const bucketOf = r =>
    r.signal_category ?? classifyTier({ odds: r.detected_odds, edge: r.detected_edge }).tier;
  const isPrimeSinceEpoch = r =>
    bucketOf(r) === 'prime' &&
    r.detected_at != null && new Date(r.detected_at).getTime() >= epochMs;

  // The learning model is scored on its own, never in the headline (see above).
  const isSupermodel = r => r.model_architecture === 'SUPERMODEL';
  const primeRows      = prematchRows.filter(r => isPrimeSinceEpoch(r) && !isSupermodel(r));
  const supermodelRows = prematchRows.filter(r => isPrimeSinceEpoch(r) && isSupermodel(r));

  // Collapse mutually-exclusive picks (e.g. home + away on the same match) to a
  // single tracked bet so opposing signals can't wash out the numbers.
  const trackedPrimes = dedupeConflicts(primeRows);

  const calculated_at = new Date().toISOString();
  const prematch = { ...summarisePhase(trackedPrimes, { includeClv: true }),
                     phase: 'prematch', singleton_key: 'current', calculated_at };
  const inplay   = { ...summarisePhase(inplayRows, { includeClv: false }),
                     phase: 'inplay', singleton_key: 'inplay', calculated_at };
  const supermodel = { ...summarisePhase(dedupeConflicts(supermodelRows), { includeClv: true }),
                       phase: 'prematch', singleton_key: 'supermodel', calculated_at };

  // P0-2 fix: upsert on singleton_key — one authoritative row per phase.
  const { error: insErr } = await supabase
    .from('performance_summary')
    .upsert([prematch, inplay, supermodel], { onConflict: 'singleton_key' });
  if (insErr) throw new Error(`calculatePerformance(upsert): ${insErr.message}`);

  console.log('[performance] prematch  ', JSON.stringify(prematch));
  console.log('[performance] inplay    ', JSON.stringify(inplay));
  console.log('[performance] supermodel', JSON.stringify(supermodel));
  return { prematch, inplay, supermodel };
}

/**
 * Refresh the per-band performance record (`performance_band`).
 *
 * WHY IT RUNS HERE AND NOT ONLY ON A SCHEDULE. `refresh_performance_by_band()`
 * was reachable only from a weekly scheduled task, and /performance is a public
 * page: a settled fixture that landed on Saturday would not reach the band table
 * until the following week, so the page would state a record that the database
 * had already superseded. Settlement is the event that changes the answer, so
 * settlement is where the recompute belongs — the same rule
 * `calculatePerformance` above already follows for `performance_summary`.
 *
 * IT IS INDEPENDENT OF THE ELIGIBILITY LADDER, DELIBERATELY. The function
 * buckets `value_signals` by EDGE BAND and never reads `tracked`, so it does not
 * change meaning when the PRIME/EDGE boxes move. That is why it can be wired
 * ahead of the ladder release rather than with it.
 *
 * The argument is left to its default (`p_tracked_from = 2026-08-06`, the
 * tracked epoch) so the bar is stated in one place — the function — rather than
 * copied into a caller, which is how the sigma hand-copy failed twice.
 */
async function refreshPerformanceBands(supabase) {
  const { error } = await supabase.rpc('refresh_performance_by_band');
  if (error) throw new Error(`refreshPerformanceBands: ${error.message}`);
  console.log('[performance] band table refreshed');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * How far behind settlement is, and the only alarm that would have caught the
 * 27 Aug outage.
 *
 * It reports AGE, NOT COUNT. A count is nonzero for perfectly ordinary reasons
 * — a fixture that finished four minutes ago is eligible and not yet settled —
 * and it is permanently nonzero because of the never-settling cohort above. An
 * age is different: if the OLDEST settleable signal has been eligible for
 * longer than STALE_AFTER_MINUTES, then no pass has completed in that time,
 * which is a statement about the settler and not about football.
 *
 * It never throws. A failed reading must not take down the settlement it is
 * reporting on — the whole point is to make silence loud, and a reporter that
 * can turn a working run red would be the silence's second cause.
 */
async function reportBacklog(supabase) {
  const now = Date.now();
  const eligibleBefore = new Date(now - SETTLE_DELAY_MS).toISOString();
  const horizon = new Date(now - BACKLOG_HORIZON_HOURS * 3_600_000).toISOString();

  // Oldest eligible-but-unsettled signal inside the horizon, and how many.
  const { data, count, error } = await supabase
    .from('value_signals')
    .select('kickoff_at', { count: 'exact' })
    .eq('result', 'pending')
    .lt('kickoff_at', eligibleBefore)
    .gte('kickoff_at', horizon)
    .order('kickoff_at', { ascending: true })
    .limit(1);
  if (error) throw new Error(error.message);

  // The never-settling cohort, counted separately and deliberately NOT alarmed
  // on: these are fixtures the feed has never returned as finished, so they are
  // a fact about the source, not a backlog anyone can clear.
  const { count: stale, error: staleErr } = await supabase
    .from('value_signals')
    .select('id', { count: 'exact', head: true })
    .eq('result', 'pending')
    .lt('kickoff_at', horizon);
  if (staleErr) throw new Error(staleErr.message);

  const oldest = data?.[0]?.kickoff_at ?? null;
  // Minutes since the row became ELIGIBLE, not since kickoff — the settle delay
  // is intended waiting and must not be counted as lateness.
  const overdueMin = oldest
    ? Math.max(0, (now - (Date.parse(oldest) + SETTLE_DELAY_MS)) / 60_000)
    : 0;

  console.log(
    `[results] backlog: ${count ?? 0} settleable in the last ${BACKLOG_HORIZON_HOURS}h` +
    (oldest ? ` (oldest eligible ${overdueMin.toFixed(0)}m ago)` : '') +
    ` · ${stale ?? 0} older than that, never returned finished by the feed`);

  if (overdueMin > STALE_AFTER_MINUTES) {
    // A GitHub annotation, so a delivery outage leaves a mark on the first run
    // that does happen rather than only in a table nobody is watching.
    console.log(
      `::error title=settlement is behind::${count} signal(s) have been settleable ` +
      `for up to ${overdueMin.toFixed(0)} minutes (limit ${STALE_AFTER_MINUTES}). ` +
      `Either no pass has completed in that time — check the schedule is being ` +
      `delivered — or the feed is not returning those fixtures as finished.`);
  }
  return { count: count ?? 0, overdueMin, stale: stale ?? 0 };
}

/**
 * Drop the dates whose fixture list can still change, keeping the rest.
 *
 * The cache exists so one API call per date covers both settlement passes. Held
 * ACROSS passes it does much more than that: 44 of the 45 dates in the queue are
 * years old and their results are immutable, so re-fetching them every pass buys
 * nothing. Today's and yesterday's DO change — a match finishes mid-run, which is
 * exactly the case this loop exists to catch — so those are evicted and re-read.
 */
function pruneVolatileDates(cache, volatileDays = 2) {
  const cutoff = new Date(Date.now() - volatileDays * 86_400_000).toISOString().slice(0, 10);
  for (const date of [...cache.keys()]) if (date >= cutoff) cache.delete(date);
  return cache;
}

async function run(cache = new Map()) {
  console.log(`\n[results] ${new Date().toISOString()}`);
  const supabase = getClient();

  try {
    await settleFinishedMatches(supabase, cache);
  } catch (err) {
    console.error('[results] match-status settlement error:', err.message);
  }

  try {
    await settlePendingSignals(supabase, cache);
  } catch (err) {
    console.error('[results] settlement error:', err.message);
  }

  try {
    await reconcileSettledSignals(supabase);
  } catch (err) {
    console.error('[results] reconcile error:', err.message);
  }

  try {
    await calculatePerformance(supabase);
  } catch (err) {
    console.error('[results] performance error:', err.message);
  }

  // After performance_summary, because both read the same settled rows and the
  // band table is the one a public page renders. A failure here must not take
  // down the run: the summary above is already written and the band table simply
  // stays at its previous refresh.
  try {
    await refreshPerformanceBands(supabase);
  } catch (err) {
    console.error('[results] band refresh error:', err.message);
  }

  // Last, so it reads the state this pass LEFT rather than the one it found.
  try {
    await reportBacklog(supabase);
  } catch (err) {
    console.error('[results] backlog reading failed:', err.message);
  }

  console.log('[results] done');
}

/**
 * The self-poll loop. `--once` is the old single-pass behaviour and is what a
 * one-off dispatch or another script should use.
 */
async function main() {
  const started = Date.now();
  const loopUntil = ONCE ? 0 : started + LOOP_MINUTES * 60_000;

  // ONE cache for the whole run, pruned of the dates that can still move. See
  // pruneVolatileDates: the 44 dead dates in the queue are fetched once per
  // RUN rather than once per pass, which is what makes a tighter cadence
  // affordable at all.
  const cache = new Map();

  let pass = 0;
  const dog = beginWatchdog('fetchResults.js', {
    onTerminate: ({ stage }) => console.error(
      `[results] killed during ${stage} — any settlement already written stands, ` +
      `the performance summary may be a pass behind`),
  });

  for (;;) {
    pass++;
    dog.stage(`pass ${pass}`);
    await run(pruneVolatileDates(cache));

    if (ONCE) break;
    const nextAt = started + pass * PASS_INTERVAL_SECONDS * 1000;
    if (nextAt >= loopUntil) break;
    await sleep(Math.max(0, nextAt - Date.now()));
  }

  console.log(
    `[results] ${pass} pass(es) over ${((Date.now() - started) / 1000 / 60).toFixed(1)}m ` +
    `· pass interval ${PASS_INTERVAL_SECONDS}s`);
  dog.finish();
}

if (require.main === module) {
  main().catch(err => { console.error('[results] unhandled:', err); process.exit(1); });
}

module.exports = {
  run, main, calculatePerformance, refreshPerformanceBands, settlePendingSignals,
  settleFinishedMatches, reconcileSettledSignals, namesMatch, fixtureOutcome,
  settleSignal, resultFromGoals, reportBacklog, pruneVolatileDates,
  LOOP_MINUTES, PASS_INTERVAL_SECONDS, STALE_AFTER_MINUTES, BACKLOG_HORIZON_HOURS,
};
