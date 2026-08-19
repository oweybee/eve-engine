'use strict';

/**
 * captureIndependentLines.js — THE SCORING ANCHOR THAT DID NOT PICK THE BET.
 *
 * `closing_lines` freezes Pinnacle's own Shin-de-vigged close. That is the
 * platform's definition of fair value, which is exactly why it cannot be used
 * to score `MARKET_ANCHORED`: that architecture SELECTS the outcome whose best
 * bettable price most exceeds Pinnacle's Shin-de-vigged fair line, and then
 * `no_vig_clv` scored that same price against Pinnacle's Shin-de-vigged CLOSING
 * line. Same books, same de-vig, same line — two timestamps. Measured over 89
 * settled fixtures the split was:
 *
 *     no-vig CLV            +3.475%
 *     edge at detection     +3.844%   <- the selection threshold, restated
 *     anchor line movement  -0.369%   (z -0.91)
 *
 * The headline was the rule measured against itself, and `paper_trade_gate()`
 * could not have failed it. This file builds the benchmark that can.
 *
 * WHAT IT WRITES. For each fixture that has kicked off, the last price vector
 * quoted STRICTLY BEFORE kickoff, taken as the MEDIAN across the bettable panel
 * with PINNACLE EXCLUDED, then Shin-de-vigged. One row per selection, into
 * `closing_lines_independent`. `closing_lines` is untouched and still written by
 * captureClosingLines.js — BOTH are wanted, to compare.
 *
 * WHY A MEDIAN AND NOT A BEST PRICE. The benchmark has to be what the market
 * believed, not what the luckiest book was showing. A max-of-panel close would
 * bake the line-shopping premium into the benchmark and make every CLV read low.
 *
 * WHY FIVE BOOKS. Below that the median is one or two prices wearing a
 * consensus's clothes. 635 of the last 30 days' h2h fixtures clear it, against
 * Pinnacle's 705, so the floor costs almost no coverage.
 *
 * IT IS INDEPENDENT OF THE PRICE, NOT OF THE CAUSAL CHAIN. The surviving CLV on
 * `MARKET_ANCHORED` is the soft panel converging toward Pinnacle between
 * detection and close. Pinnacle is out of the benchmark; it is still the reason
 * the benchmark moves. Read the number as "the soft market came to us", not as
 * "we beat the market", and see docs/ANCHOR_INDEPENDENCE.md.
 *
 * WRITTEN ONCE, NEVER REVISED — same rule as `closing_lines`.
 *
 *   node captureIndependentLines.js              # fixtures that kicked off recently
 *   node captureIndependentLines.js --backfill   # every past fixture still missing one
 *   node captureIndependentLines.js --dry-run    # print, write nothing
 */

const { getClient } = require('./lib/supabaseClient');
const { shinDevig } = require('./lib/devig');
const { BETTABLE_BOOKS } = require('./lib/marketAnchor');

/**
 * The panel, with the anchor removed. Derived from BETTABLE_BOOKS rather than
 * re-listed, so a book added to the platform's bettable panel joins this
 * benchmark automatically and cannot be forgotten here. `pinnacle` is already
 * absent from that list (it is in EXCLUDED_BOOKS, as the anchor), so the filter
 * is belt-and-braces — it is here so that the exclusion this benchmark depends
 * on is stated where the benchmark is built, not inferred two files away.
 */
const INDEPENDENT_BOOKS = Object.freeze(BETTABLE_BOOKS.filter(b => b !== 'pinnacle'));
const INDEPENDENT_SET = new Set(INDEPENDENT_BOOKS);

/** Below this a median is not a consensus. See the header. */
const MIN_BOOKS = parseInt(process.env.INDEPENDENT_MIN_BOOKS || '5', 10);

/** Same windows as captureClosingLines.js, for the same reasons. */
const LOOKBACK_HOURS = parseFloat(process.env.CLOSING_LOOKBACK_HOURS || '6');
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
 * One independent closing vector for one market at one line.
 *
 * @param {Array} rows odds rows for this (market, line), already restricted to
 *                     `fetched_at <= kickoff_at`
 * @param {{selections:string[], cols:string[]}} spec
 * @returns {{prices:number[], bookCount:number, books:string[], quotedAt:string}|null}
 */
function independentVector(rows, spec) {
  // Latest quote per book. Without this the "close" is a max over history — the
  // defect that made `bestTwoWay` de-vig a market that never existed.
  const byBook = new Map();
  for (const r of rows) {
    if (!INDEPENDENT_SET.has(r.bookmaker)) continue;
    const prev = byBook.get(r.bookmaker);
    if (!prev || r.fetched_at > prev.fetched_at) byBook.set(r.bookmaker, r);
  }

  const complete = r => {
    const p = spec.cols.map(c => num(r[c]));
    return p.every(v => v != null) ? p : null;
  };

  // A book contributes to EVERY leg or to none. Taking a per-leg median over
  // different book sets silently changes which market the benchmark describes.
  const panel = [...byBook.values()].filter(complete);
  if (panel.length < MIN_BOOKS) return null;

  const prices = spec.cols.map(c => median(panel.map(r => num(r[c]))));
  const quotedAt = panel.reduce((b, r) => (r.fetched_at > b ? r.fetched_at : b), panel[0].fetched_at);
  const books = panel.map(r => r.bookmaker).sort();

  return { prices, bookCount: panel.length, books, quotedAt };
}

/** Turn one fixture's pre-kickoff odds into closing_lines_independent rows. */
function linesForMatch(match, oddsRows) {
  const out = [];
  const kickoff = match.kickoff_at;
  const kickoffMs = new Date(kickoff).getTime();
  const stalenessCutoff = kickoffMs - MAX_STALENESS_HOURS * 3_600_000;

  const groups = new Map();
  for (const r of oddsRows) {
    const market = r.market ?? 'h2h';
    if (!MARKETS[market]) continue;
    if (new Date(r.fetched_at).getTime() > kickoffMs) continue;   // strictly before kickoff
    const line = r.market_line != null ? Number(r.market_line) : null;
    const key = `${market}|${line == null ? 'null' : line}`;
    if (!groups.has(key)) groups.set(key, { market, line, rows: [] });
    groups.get(key).rows.push(r);
  }

  for (const g of groups.values()) {
    const spec = MARKETS[g.market];
    const v = independentVector(g.rows, spec);
    if (!v) continue;

    // A quote this old is not a close, it is the last thing anyone bothered to
    // publish. Say nothing rather than freeze it as the benchmark.
    if (new Date(v.quotedAt).getTime() < stalenessCutoff) continue;

    const d = shinDevig(v.prices);
    // Fails closed for the reason `devigProbs` does: a vector with no margin
    // left is not a market, and a benchmark built from one reports CLV against
    // a price nobody quoted.
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
        book_count:   v.bookCount,
        books:        v.books,
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
      .lt('kickoff_at', upper)
      .order('kickoff_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`matches: ${error.message}`);
    if (!data?.length) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

async function fetchAlreadyCaptured(supabase, matchIds) {
  const done = new Set();
  const CHUNK = 300;
  for (let i = 0; i < matchIds.length; i += CHUNK) {
    const slice = matchIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('closing_lines_independent')
      .select('match_id')
      .in('match_id', slice);
    if (error) throw new Error(`closing_lines_independent: ${error.message}`);
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
    console.log('[independent] no fixtures have kicked off in the window');
    return;
  }

  const already = await fetchAlreadyCaptured(supabase, matches.map(m => m.id));
  const todo = matches.filter(m => !already.has(m.id) && m.kickoff_at);
  console.log(`[independent] ${matches.length} kicked off, ${already.size} already captured, ${todo.length} to do`);
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

  // WHY IT IS EMPTY MATTERS — the same rule captureClosingLines.js follows.
  // "Nothing kicked off", "no odds stored" and "fewer than MIN_BOOKS quoted
  // before kickoff" are three different states and read identically from
  // outside unless the routine says which.
  console.log(
    `[independent] ${rows.length} lines from ${todo.length - noOdds - noVector} fixtures ` +
    `(no odds: ${noOdds}, fewer than ${MIN_BOOKS} books or no usable pre-kickoff vector: ${noVector})`
  );

  if (dryRun) {
    for (const r of rows.slice(0, 12)) {
      console.log(`  ${r.market}${r.market_line != null ? ` ${r.market_line}` : ''} ${r.selection}: ` +
                  `close ${r.closing_odds} → fair ${r.no_vig_odds} (${r.book_count} books, or ${r.overround})`);
    }
    console.log('[independent] dry run — nothing written');
    return;
  }

  let written = 0;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const { error } = await supabase
      .from('closing_lines_independent')
      .upsert(slice, { onConflict: 'match_id,market,market_line,selection', ignoreDuplicates: true });
    if (error) throw new Error(`closing_lines_independent insert: ${error.message}`);
    written += slice.length;
  }
  console.log(`[independent] wrote ${written} independent closing lines`);
}

if (require.main === module) {
  main().catch(err => { console.error(`[independent] ${err.message}`); process.exit(1); });
}

module.exports = { independentVector, linesForMatch, INDEPENDENT_BOOKS, MIN_BOOKS, MARKETS };
