'use strict';

/**
 * captureClosingLines.js — FREEZE THE CLOSING LINE AT KICKOFF.
 *
 * CLV is the only feedback this platform can get inside a week. Yield needs
 * hundreds of settled bets before it says anything; the closing line says
 * something about every selection the moment its match starts. It is also what
 * `paper_trade_gate()` opens the publication gate on — 300 settled bets, CLV
 * above +0.5%, z above 2 — so a wrong CLV is a wrong gate.
 *
 * IT WAS WRONG, TWO WAYS (see migration 061 for the measurements):
 *
 *   `odds_snapshots.snapshot_type = 'closing'` labels anything from 60 minutes
 *   BEFORE kickoff to 180 minutes AFTER it as "closing". 71% of those rows were
 *   captured after kickoff and the median one is 42 minutes into the match, so
 *   the benchmark was frequently an in-play price on a match whose score had
 *   already moved.
 *
 *   `settle_match_signals()` built `no_vig_clv` with PROPORTIONAL de-vig over
 *   whichever single bookmaker row happened to be fetched last. lib/devig.js
 *   exists because proportional de-vig manufactures edge on the longer leg.
 *
 * WHAT THIS WRITES. For each fixture that has kicked off, the last price vector
 * quoted STRICTLY BEFORE kickoff, Shin-de-vigged, one row per selection:
 *
 *   basis 'anchor'     Pinnacle's own closing vector. The platform already
 *                      rules fair value IS Shin-de-vigged Pinnacle, so the
 *                      benchmark a price is judged against is the same thing
 *                      that defined value in the first place.
 *   basis 'consensus'  Pinnacle did not quote. Median price per selection
 *                      across the bettable panel, then Shin.
 *
 * The basis is stored and must never be averaged across — the same ruling
 * `gap_basis` carries in migration 058.
 *
 * WRITTEN ONCE, NEVER REVISED. A closing line is a record of a moment that has
 * passed. Only a pending offer is ever re-priced.
 *
 *   node captureClosingLines.js              # fixtures that kicked off recently
 *   node captureClosingLines.js --backfill   # every past fixture still missing one
 *   node captureClosingLines.js --dry-run    # print, write nothing
 */

const { getClient } = require('./lib/supabaseClient');
const { shinDevig } = require('./lib/devig');
const { BETTABLE_BOOKS } = require('./lib/marketAnchor');

/** The anchor, exactly as computeValues defines it. */
const ANCHOR_BOOK = 'pinnacle';
const BETTABLE_SET = new Set(BETTABLE_BOOKS);

/**
 * How far back the routine pass looks for fixtures that have kicked off. The
 * engine runs every 15 minutes; 6 hours of slack means a handful of missed runs
 * costs nothing, and the `quoted_at <= kickoff_at` constraint means a late
 * capture is still a correct one — it re-reads history, it does not sample now.
 */
const LOOKBACK_HOURS = parseFloat(process.env.CLOSING_LOOKBACK_HOURS || '6');

/**
 * A quote older than this before kickoff is not a closing price. Books stop
 * updating dead fixtures, and freezing a 3-day-old line as "the close" would
 * report drift that never happened. Such a fixture gets NO closing line, which
 * is the honest answer.
 */
const MAX_STALENESS_HOURS = parseFloat(process.env.CLOSING_MAX_STALENESS_HOURS || '12');

/** Engine convention: over/yes → home_odds, under/no → away_odds. */
const MARKETS = {
  h2h:    { selections: ['home', 'draw', 'away'], cols: ['home_odds', 'draw_odds', 'away_odds'] },
  totals: { selections: ['over', 'under'],        cols: ['home_odds', 'away_odds'] },
  btts:   { selections: ['btts_yes', 'btts_no'],  cols: ['home_odds', 'away_odds'] },
};

const num = x => {
  if (x == null || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) && n > 1 ? n : null;
};

const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Build one closing vector for one market at one line.
 *
 * @param {Array} rows odds rows for this (market, line), already restricted to
 *                     `fetched_at <= kickoff_at`
 * @param {{selections:string[], cols:string[]}} spec
 * @returns {{prices:number[], basis:string, bookCount:number, quotedAt:string}|null}
 */
function closingVector(rows, spec) {
  // Latest quote per book. Without this the "close" is a max over history, the
  // same defect that made `bestTwoWay` de-vig a market that never existed.
  const byBook = new Map();
  for (const r of rows) {
    const prev = byBook.get(r.bookmaker);
    if (!prev || r.fetched_at > prev.fetched_at) byBook.set(r.bookmaker, r);
  }

  const complete = r => {
    const p = spec.cols.map(c => num(r[c]));
    return p.every(v => v != null) ? p : null;
  };

  // ── Preferred: the anchor's own vector. ─────────────────────────────────
  const anchorRow = byBook.get(ANCHOR_BOOK);
  const anchorPrices = anchorRow ? complete(anchorRow) : null;
  if (anchorPrices) {
    return {
      prices: anchorPrices,
      basis: 'anchor',
      bookCount: 1,
      quotedAt: anchorRow.fetched_at,
    };
  }

  // ── Fallback: median across the bettable panel. ─────────────────────────
  // Per SELECTION, not per book, because books drop in and out of a market and
  // a per-book median would silently change which book it means between legs.
  const panel = [...byBook.values()].filter(r => BETTABLE_SET.has(r.bookmaker) && complete(r));
  if (panel.length < 2) return null;

  const prices = spec.cols.map((c, i) => median(panel.map(r => num(r[c]))));
  if (prices.some(p => p == null)) return null;

  const quotedAt = panel.reduce((b, r) => (r.fetched_at > b ? r.fetched_at : b), panel[0].fetched_at);
  return { prices, basis: 'consensus', bookCount: panel.length, quotedAt };
}

/** Turn one fixture's pre-kickoff odds into closing_lines rows. */
function linesForMatch(match, oddsRows) {
  const out = [];
  const kickoff = match.kickoff_at;
  const kickoffMs = new Date(kickoff).getTime();
  const stalenessCutoff = kickoffMs - MAX_STALENESS_HOURS * 3_600_000;

  // Group by (market, line). Only rows quoted strictly before kickoff.
  const groups = new Map();
  for (const r of oddsRows) {
    const market = r.market ?? 'h2h';
    if (!MARKETS[market]) continue;
    if (new Date(r.fetched_at).getTime() > kickoffMs) continue;
    const line = r.market_line != null ? Number(r.market_line) : null;
    const key = `${market}|${line == null ? 'null' : line}`;
    if (!groups.has(key)) groups.set(key, { market, line, rows: [] });
    groups.get(key).rows.push(r);
  }

  for (const g of groups.values()) {
    const spec = MARKETS[g.market];
    const v = closingVector(g.rows, spec);
    if (!v) continue;

    // A quote this old is not a close, it is the last thing anyone bothered to
    // publish. Say nothing rather than freeze it as the closing line.
    if (new Date(v.quotedAt).getTime() < stalenessCutoff) continue;

    const d = shinDevig(v.prices);
    // Fails closed for the same reason `devigProbs` does: a vector with no
    // margin left is not a market, and a benchmark built from one would report
    // CLV against a price nobody quoted.
    if (!d.probs || d.arbitrage) continue;

    spec.selections.forEach((sel, i) => {
      const p = d.probs[i];
      if (!(p > 0 && p < 1)) return;
      out.push({
        match_id:     match.id,
        market:       g.market,
        market_line:  g.line,
        selection:    sel,
        closing_odds: +v.prices[i].toFixed(4),
        no_vig_prob:  +p.toFixed(6),
        no_vig_odds:  +(1 / p).toFixed(4),
        basis:        v.basis,
        book_count:   v.bookCount,
        overround:    +d.overround.toFixed(6),
        kickoff_at:   kickoff,
        quoted_at:    v.quotedAt,
      });
    });
  }

  return out;
}

// ── DB plumbing ─────────────────────────────────────────────────────────────

async function fetchCandidateMatches(supabase, { backfill }) {
  const now = new Date();
  const upper = now.toISOString();
  const lower = backfill
    ? new Date(0).toISOString()
    : new Date(now.getTime() - LOOKBACK_HOURS * 3_600_000).toISOString();

  const out = [];
  const PAGE = 500;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('matches')
      .select('id, kickoff_at')
      .gte('kickoff_at', lower)
      .lt('kickoff_at', upper)          // strictly: the fixture has kicked off
      .order('kickoff_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`matches: ${error.message}`);
    if (!data?.length) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

/** Matches that already have a closing line — never revised, so never re-read. */
async function fetchAlreadyCaptured(supabase, matchIds) {
  const done = new Set();
  const CHUNK = 300;
  for (let i = 0; i < matchIds.length; i += CHUNK) {
    const slice = matchIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('closing_lines')
      .select('match_id')
      .in('match_id', slice);
    if (error) throw new Error(`closing_lines: ${error.message}`);
    for (const r of data ?? []) done.add(r.match_id);
  }
  return done;
}

async function fetchOddsFor(supabase, matchIds) {
  const byMatch = new Map();
  const CHUNK = 40;
  for (let i = 0; i < matchIds.length; i += CHUNK) {
    const slice = matchIds.slice(i, i + CHUNK);
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('odds')
        .select('match_id, bookmaker, market, market_line, home_odds, draw_odds, away_odds, fetched_at')
        .in('match_id', slice)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`odds: ${error.message}`);
      if (!data?.length) break;
      for (const r of data) {
        if (!byMatch.has(r.match_id)) byMatch.set(r.match_id, []);
        byMatch.get(r.match_id).push(r);
      }
      if (data.length < PAGE) break;
    }
  }
  return byMatch;
}

async function main() {
  const backfill = process.argv.includes('--backfill');
  const dryRun   = process.argv.includes('--dry-run');
  const supabase = getClient();

  const matches = await fetchCandidateMatches(supabase, { backfill });
  if (!matches.length) {
    console.log('[closing] no fixtures have kicked off in the window');
    return;
  }

  const already = await fetchAlreadyCaptured(supabase, matches.map(m => m.id));
  const todo = matches.filter(m => !already.has(m.id) && m.kickoff_at);
  console.log(`[closing] ${matches.length} kicked off, ${already.size} already captured, ${todo.length} to do`);
  if (!todo.length) return;

  const oddsByMatch = await fetchOddsFor(supabase, todo.map(m => m.id));

  const rows = [];
  let noOdds = 0, noVector = 0;
  for (const m of todo) {
    const odds = oddsByMatch.get(m.id);
    if (!odds?.length) { noOdds++; continue; }
    const lines = linesForMatch(m, odds);
    if (!lines.length) { noVector++; continue; }
    rows.push(...lines);
  }

  // WHY IT IS EMPTY MATTERS. An empty result has three different causes and
  // they are indistinguishable from outside: nothing kicked off, no odds were
  // ever stored, or nothing quoted strictly before kickoff survived the
  // staleness and coherence gates.
  console.log(
    `[closing] ${rows.length} lines from ${todo.length - noOdds - noVector} fixtures ` +
    `(no odds: ${noOdds}, no usable pre-kickoff vector: ${noVector})`
  );

  if (dryRun) {
    for (const r of rows.slice(0, 12)) {
      console.log(`  ${r.market}${r.market_line != null ? ` ${r.market_line}` : ''} ${r.selection}: ` +
                  `close ${r.closing_odds} → fair ${r.no_vig_odds} (${r.basis}, ${r.book_count} books, or ${r.overround})`);
    }
    console.log('[closing] dry run — nothing written');
    return;
  }

  let written = 0;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const { error } = await supabase
      .from('closing_lines')
      .upsert(slice, { onConflict: 'match_id,market,market_line,selection', ignoreDuplicates: true });
    if (error) throw new Error(`closing_lines insert: ${error.message}`);
    written += slice.length;
  }
  console.log(`[closing] wrote ${written} closing lines`);
}

if (require.main === module) {
  main().catch(err => { console.error(`[closing] ${err.message}`); process.exit(1); });
}

module.exports = { closingVector, linesForMatch, MARKETS };
