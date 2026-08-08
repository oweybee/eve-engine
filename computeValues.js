'use strict';

/**
 * EVE — Value Detection Engine  v7
 *
 * Model: Market Consensus / Wisdom of Crowds (Kaunitz et al.)
 *        "Beating the bookies with their own numbers" (2017)
 *
 * v7: price-change signalling
 *   - Removed signals_written gate — every compute cycle re-evaluates
 *   - Dedup is odds-based: same price within SIGNAL_DEDUP_MINUTES = skip
 *     Different price = new signal (PriceMove category)
 *   - EV_THRESHOLD default lowered to 0.005 (0.5%) to surface marginal value
 */

// NOTE: lib/supabaseClient is required lazily inside main() (see below) rather
// than at module load. It pulls in @supabase/supabase-js and throws if the
// SUPABASE_* env vars are absent, which would make the pure pricing functions
// (computeConsensus/computeMatch) impossible to unit-test without a live DB.
// The pure exports below have no DB dependency.
const sm            = require('./lib/secondaryMarkets');
const { categoryFor } = require('./lib/signalTier');
const { scoreSignal } = require('./lib/maxedge');
const { shinDevig } = require('./lib/devig');
// The whole module, not just the book list: `gate()` is applied to every
// outcome below so the engine, the match-card API and the backtest all read
// the same thresholds from one place.
const ma = require('./lib/marketAnchor');
const { BETTABLE_BOOKS } = ma;
const { buildPrematchVector } = require('./lib/halftimeFeatures');
const { checkQuality, thresholdsFromEnv } = require('./lib/dataQuality');

// Config
const MIN_BOOKMAKERS      = parseInt(process.env.MIN_BOOKMAKERS      || '2',    10);
const COMPUTE_CONCURRENCY = parseInt(process.env.COMPUTE_CONCURRENCY || '5',    10);
const USE_UNIFORM_ALPHA   = (process.env.USE_UNIFORM_ALPHA || '').toLowerCase() === 'true';
const ODDS_MAX_AGE_HOURS  = parseFloat(process.env.ODDS_MAX_AGE_HOURS || '24');

const ALPHA_HOME    = parseFloat(process.env.ALPHA_HOME    || '0.034');
const ALPHA_DRAW    = parseFloat(process.env.ALPHA_DRAW    || '0.057');
const ALPHA_AWAY    = parseFloat(process.env.ALPHA_AWAY    || '0.037');
const ALPHA_UNIFORM = parseFloat(process.env.ALPHA_UNIFORM || '0.05');

// The anchor. ONE book, deliberately: fair value is Pinnacle's Shin-de-vigged
// line and nothing else. See the note on computeConsensus() for why averaging a
// panel of soft books inverted the signal.
const ANCHOR_BOOK = 'pinnacle';

// Books a UK subscriber can realistically hold. Mirrors lib/marketAnchor.js,
// which is the authority — imported rather than re-listed so the two cannot
// drift. Pinnacle is absent because it is the anchor.
const BETTABLE_SET = new Set(BETTABLE_BOOKS);

// DEVIG_MARGIN is GONE. It shaved 2% off the consensus probability as a safety
// buffer against the consensus's own error. There is nothing to buy back from a
// Shin-de-vigged sharp line, and a shave would mean fair value is the anchor
// plus an arbitrary constant rather than the anchor. The MIN_EDGE gate in
// lib/marketAnchor.js does the job it was reaching for, explicitly.

// Palpable-error guard. A lone book pricing an outcome more than this multiple
// longer/shorter than the median is almost always a mistake, not value — e.g. a
// draw at 48.0 when every other book is ~3.5. Such a price was being taken as
// the "best available" and producing a +258% fake edge that cascaded into the
// goals/BTTS models. Outliers are dropped before computing both the consensus
// and the best price. Only applied with ≥3 books (need a stable median).
const OUTLIER_MULT = parseFloat(process.env.ODDS_OUTLIER_MULT || '3');

// Lowered from 0.02 — World Cup market is efficient, 0.5% surfaces real marginal edge
const EV_THRESHOLD = parseFloat(process.env.EV_THRESHOLD || '0.005');

// Implausible-edge guard. A consensus edge this large is essentially always a
// data error — a lone stale/illiquid price (e.g. a Betfair Exchange home at 9.8
// while every book is ~3.5) that the 3×-median outlier filter doesn't catch
// because it sits just under the threshold. Such a price produced a +142% fake
// edge that also tripped the integrity alarm. Mirrors computeApiValues'
// MAX_PLAUSIBLE_EDGE: above this, drop the edge rather than publish value.
const MAX_PLAUSIBLE_EDGE = parseFloat(process.env.MAX_PLAUSIBLE_EDGE || '0.30');

// SUPERMODEL_EV_THRESHOLD is GONE with the publisher it gated. It read as a
// safeguard — "the model only speaks when it disagrees by an amount worth
// acting on" — and was the opposite. Model-market disagreement is
// anti-predictive on this corpus, so a bar that publishes only the WIDEST
// disagreements selects for the model's worst calls by construction.

/**
 * supermodelEdge() IS GONE. DELETED 6 AUG 2026 UNDER THE MARKET-ANCHORED RULING.
 *
 * It computed `edge = modelProb · odds − 1` from the XGBoost forecast and, above
 * a 3% bar, wrote a value_signals row. That is a model generating a value flag
 * and an edge number, which the ruling forbids outright — rule 1, and the most
 * literal breach of it in the codebase.
 *
 * The comment it shipped under argued the case for itself: that the model had
 * been "decorative", that its probabilities "drove no signal, no edge and no
 * conviction". All true, and all beside the point. The measured record is that
 * this model's disagreement with the market is ANTI-PREDICTIVE — across 44,820
 * settled selections the market is closer to the truth 65.1% of the time once
 * the two are 15pp apart, and monotonically more often as the gap widens. A
 * forecast that publishes only where it disagrees MOST with the market is
 * therefore selecting, on purpose, for its own worst selections. The 3%
 * threshold was not a safeguard; it was the mechanism.
 *
 * The model probabilities are STILL COMPUTED AND STILL WRITTEN — see the
 * ensemble block in main(). They remain display-only, which is exactly what
 * rule 2 permits: a model probability may sit beside the market's on a match
 * card, and may never sit beside a price in a way that implies edge.
 *
 * If this model is ever to speak again it goes through paper_trade_gate() like
 * anything else: 300 settled bets, CLV above +0.5%, z above 2. Yield does not
 * open it. Do not reinstate a threshold-based publisher.
 */

// Skip re-signal if same odds seen within this window (avoid spam)
const SIGNAL_DEDUP_MINUTES = parseInt(process.env.SIGNAL_DEDUP_MINUTES || '60', 10);

async function fetchMatchesForComputation(supabase, statuses = ['scheduled']) {
  // Pre-match engine: scheduled only. In-play matches are handled by
  // computeInplayValues.js so their signals are tagged phase='inplay' and kept
  // out of the CLV-tracked pre-match performance summary. (Was previously
  // ['scheduled','live'], which silently polluted CLV with post-kickoff edges.)
  const { data: matchData, error: matchError } = await supabase
    .from('matches')
    .select(`
      id, external_id, kickoff_at, status, referee, goals_home, goals_away, minute,
      home_team:teams!matches_home_team_id_fkey ( id, name ),
      away_team:teams!matches_away_team_id_fkey ( id, name ),
      league:leagues ( id, name )
    `)
    .in('status', statuses)
    .order('kickoff_at', { ascending: true });

  if (matchError) throw new Error(`fetchMatchesForComputation[matches]: ${matchError.message}`);
  if (!matchData?.length) return [];

  const matchIds = new Set(matchData.map(m => m.id));

  // Fetch odds paginated. `odds` is a snapshot history (thousands of rows across
  // the slate), and a plain .in() is capped at 1000 rows by PostgREST — which
  // silently truncated the result so most matches got ZERO odds and were skipped
  // (only a handful of games ever priced). We (a) restrict to the freshness
  // window the consensus uses anyway, cutting volume sharply, and (b) page
  // through in 1000-row chunks so every match's odds are returned.
  //
  // The match filter is applied client-side, NOT as .in('match_id', ...): since
  // the season backfill, 'scheduled' is the whole season (9,500+ matches), and
  // inlining that many UUIDs builds a ~350KB request URL the API gateway
  // rejects with a bare 400 before PostgREST sees it. Odds inside the
  // freshness window are one slate's worth, so fetching them all and
  // intersecting here costs at most a page or two of rows we discard.
  const freshCutoff = new Date(Date.now() - ODDS_MAX_AGE_HOURS * 3_600_000).toISOString();
  const oddsData = [];
  const ODDS_PAGE = 1000;
  for (let from = 0; ; from += ODDS_PAGE) {
    const { data, error: oddsError } = await supabase
      .from('odds')
      .select('match_id, bookmaker, market, market_line, home_odds, draw_odds, away_odds, fetched_at')
      .gte('fetched_at', freshCutoff)
      .order('id', { ascending: true })
      .range(from, from + ODDS_PAGE - 1);
    if (oddsError) throw new Error(`fetchMatchesForComputation[odds]: ${oddsError.message}`);
    if (!data?.length) break;
    for (const o of data) if (matchIds.has(o.match_id)) oddsData.push(o);
    if (data.length < ODDS_PAGE) break;
  }

  const oddsByMatch = {};
  for (const o of oddsData) {
    if (!oddsByMatch[o.match_id]) oddsByMatch[o.match_id] = [];
    oddsByMatch[o.match_id].push(o);
  }

  return matchData
    .map(m => ({ ...m, odds: oddsByMatch[m.id] ?? [] }))
    .filter(m => m.odds.length > 0);
}

function formatBookName(key) {
  if (!key) return null;
  const names = {
    betfair_ex_uk: 'Betfair Exch', betfair_sb_uk: 'Betfair SB',
    smarkets: 'Smarkets', matchbook: 'Matchbook', bet365: 'Bet365',
    skybet: 'Sky Bet', williamhill: 'William Hill', paddypower: 'Paddy Power',
    coral: 'Coral', ladbrokes_uk: 'Ladbrokes', betfred_uk: 'Betfred',
    betway: 'Betway', betvictor: 'BetVictor', boylesports: 'BoyleSports',
    unibet_uk: 'Unibet', virginbet: 'Virgin Bet', sport888: '888sport',
    leovegas: 'LeoVegas', casumo: 'Casumo', grosvenor: 'Grosvenor',
    livescorebet: 'LiveScore Bet', pinnacle: 'Pinnacle', unibet: 'Unibet',
    betsson: 'Betsson', betano: 'Betano', marathonbet: 'MarathonBet',
    '1xbet': '1xBet', sbo: 'SBO', '888sport': '888sport', '10bet': '10bet',
  };
  return names[key] ?? key;
}

/**
 * MARKET-ANCHORED PRICING. Replaced the consensus on 6 Aug 2026.
 *
 * WHAT THIS USED TO DO. It averaged the vig-inclusive implied probability
 * across every book on the row — typically ~15 of them — de-vigged the average
 * and shaved 2%, and called that fair. The panel it averaged is mostly the SOFT
 * BOOKS the comparison is supposed to beat, so the reference point drifted
 * toward the very prices being evaluated. Over 198 settled selections that
 * produced -47.0% yield at -24.94% CLV, and the de-vigged consensus scored
 * Brier 0.3051 against the market's own 0.3050 — zero information added. It was
 * not a weak signal. It was an inverted one.
 *
 * WHAT IT DOES NOW. Fair value is PINNACLE ALONE, Shin-de-vigged. Pinnacle is
 * the sharpest liquid book on the panel, it moves on money rather than on
 * liability, and it is the reference every published closing-line-value study
 * uses. Best price is the highest among books a UK subscriber can realistically
 * hold — Pinnacle excluded, because taking the best price from the book that
 * defines fair value compares a number with itself and returns the vig as edge.
 *
 * Measured 6 Aug 2026: +6.58% CLV on flagged selections against -3.52% on
 * unflagged, with a monotone gradient in edge size.
 *
 * IT FAILS CLOSED. No Pinnacle price on a fixture means no fair value, which
 * means no signal — `null`, not a fallback to the old consensus. A fallback is
 * how the inverted signal would quietly survive on exactly the fixtures where
 * the anchor is thinnest.
 *
 * THE 2% SHAVE IS GONE. `DEVIG_MARGIN` existed to buy back some of the error in
 * the consensus. There is nothing to buy back from a Shin-de-vigged sharp line,
 * and a shave would mean fair value is no longer the anchor — it would be the
 * anchor plus an arbitrary constant. The 2% MIN_EDGE gate in lib/marketAnchor.js
 * does the job the shave was reaching for, explicitly and in one place.
 *
 * The returned SHAPE is unchanged, so every downstream consumer keeps working;
 * only what fills it has changed.
 */
function computeConsensus(oddsRows) {
  const h2hRows = oddsRows.filter(r => (r.market ?? 'h2h') === 'h2h');
  if (!h2hRows.length) return null;

  const byBook = new Map();
  for (const row of h2hRows) {
    const existing = byBook.get(row.bookmaker);
    if (!existing || row.fetched_at > existing.fetched_at) {
      byBook.set(row.bookmaker, row);
    }
  }

  if (byBook.size < MIN_BOOKMAKERS) return null;

  const deduped = [...byBook.values()];
  // The book count that matters is the number of BETTABLE books competing for
  // best price — not every row on the fixture. The anchor, the synthetic `best`
  // row and the exchanges are all excluded, so this is the number the
  // six-book floor is actually about.
  const bettableRows = deduped.filter(r => BETTABLE_SET.has(r.bookmaker));
  const bookmakerCount = bettableRows.length;

  const latestFetchedAt = deduped.reduce(
    (best, r) => (!best || r.fetched_at > best ? r.fetched_at : best), null
  );

  const oddsAgeMs = latestFetchedAt
    ? Date.now() - new Date(latestFetchedAt).getTime()
    : Infinity;
  if (oddsAgeMs > ODDS_MAX_AGE_HOURS * 3_600_000) return null;

  const OUTCOMES = ['home', 'draw', 'away'];
  const FIELDS   = { home: 'home_odds', draw: 'draw_odds', away: 'away_odds' };

  const result = { bookmakerCount, latestFetchedAt };

  // ── The anchor. Fair value comes from here and nowhere else. ──────────────
  const anchorRow = byBook.get(ANCHOR_BOOK);
  const anchorOdds = anchorRow
    ? OUTCOMES.map(o => parseFloat(anchorRow[FIELDS[o]]))
    : null;
  const anchor = anchorOdds ? shinDevig(anchorOdds) : { probs: null, reason: 'no Pinnacle price' };

  if (anchor.probs === null) {
    // Fail closed. Without the anchor there is no fair value, and without fair
    // value there is no edge to claim. Returning the old consensus here is how
    // the inverted signal would survive on the fixtures with the thinnest
    // sharp coverage — precisely the ones least safe to guess on.
    return null;
  }
  const anchorProb = {};
  OUTCOMES.forEach((o, i) => { anchorProb[o] = anchor.probs[i]; });

  result.anchor = {
    book: ANCHOR_BOOK,
    devig: 'shin',
    overround: anchor.overround,
    z: anchor.z,
  };

  // ── Pass 1: best BETTABLE price per outcome ──────────────────────────────
  const raw = {};
  for (const outcome of OUTCOMES) {
    const field = FIELDS[outcome];

    // Only books the reader can actually hold an account with. A signal is a
    // claim that this price is available to them; a price at a book they
    // cannot open makes the claim false.
    const validRows = bettableRows.filter(r => {
      const v = parseFloat(r[field]);
      return Number.isFinite(v) && v > 1.0 && v < 1000;
    });

    if (!validRows.length) { result[outcome] = null; continue; }

    // Collect prices, then drop palpable outliers (see OUTLIER_MULT).
    const priced = validRows
      .map(r => ({ v: parseFloat(r[field]), name: formatBookName(r.bookmaker) }))
      .filter(p => Number.isFinite(p.v) && p.v > 1);
    let kept = priced;
    if (priced.length >= 3) {
      const s = priced.map(p => p.v).sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
      const hi = median * OUTLIER_MULT, lo = median / OUTLIER_MULT;
      const filtered = priced.filter(p => p.v <= hi && p.v >= lo);
      if (filtered.length) kept = filtered;   // never drop everyone
    }

    const allOdds = {};
    let max_odds = 0, max_book = null;
    for (const p of kept) {
      if (p.name) allOdds[p.name] = p.v;
      if (p.v > max_odds) { max_odds = p.v; max_book = p.name; }
    }

    // No consensus probability is computed any more. The books on this list are
    // the ones we are trying to BEAT — averaging them was the bug.
    raw[outcome] = { max_odds, max_book, allOdds };
  }

  // ── The market's own probability, margin removed. ────────────────────────
  // `market_prob` on a signal is what the market a reader can actually bet into
  // believes, and raw `1/best_odds` is not that: across the live 1X2 board those
  // three reciprocals sum to ~1.0348 even at best prices across 15+ books, so
  // each one overstates its outcome by roughly the residual margin. De-vig the
  // complete best-price vector once, here, and hand the result to
  // `scoreSignal`. It is also the SAME vector the frontend de-vigs for its
  // "Fair %" column, so the board and the ledger cannot describe one bet two
  // ways.
  const bestVector = {};
  for (const o of OUTCOMES) bestVector[o] = raw[o]?.max_odds;
  const bestDevig = ma.devigProbs(bestVector, OUTCOMES);

  // ── Edge: the best bettable price against the Shin-de-vigged anchor. ──────
  const present = OUTCOMES.filter(o => raw[o]);

  for (const outcome of present) {
    const r         = raw[outcome];
    // `p_cons` and `p_adj` keep their names for the downstream consumers that
    // read them, but both are now the anchor's probability — there is no
    // consensus and no shave, so the two are equal by construction.
    const p_novig   = anchorProb[outcome];
    const p_adj     = p_novig;
    const fair_odds = 1 / p_adj;
    let has_edge = r.max_odds > fair_odds;
    let edge     = has_edge ? parseFloat((p_adj * r.max_odds - 1).toFixed(6)) : 0;

    // Reject implausible edges: a lone stale/outlier price masquerading as value.
    if (edge > MAX_PLAUSIBLE_EDGE) {
      console.warn(
        `[engine] dropped implausible edge ${(edge * 100).toFixed(0)}% on ${outcome} ` +
        `(best ${r.max_odds} @ ${r.max_book} vs fair ${fair_odds.toFixed(2)}) — likely stale/outlier price`
      );
      has_edge = false;
      edge = 0;
    }

    result[outcome] = {
      p_cons: p_novig, p_adj, fair_odds,
      max_odds: r.max_odds, max_book: r.max_book,
      has_edge, edge, allOdds: r.allOdds,
      // The de-vigged probability of THIS outcome across the bettable panel —
      // the market side of every score written off this row. Null when the
      // panel was not a complete market, which makes the row unscorable rather
      // than scored against a margin-carrying number.
      p_mkt_devig: bestDevig.fair?.[outcome] ?? null,
    };
  }

  return result;
}

function computeMatch(match) {
  const consensus = computeConsensus(match.odds);
  if (!consensus) return { skipped: true };

  const { home, draw, away, bookmakerCount, latestFetchedAt } = consensus;

  const best_home_odds = home?.max_odds ?? null;
  const best_draw_odds = draw?.max_odds ?? null;
  const best_away_odds = away?.max_odds ?? null;
  const best_home_book = home?.max_book ?? null;
  const best_draw_book = draw?.max_book ?? null;
  const best_away_book = away?.max_book ?? null;

  const fair_home_odds = home?.fair_odds != null ? String(home.fair_odds.toFixed(4)) : null;
  const fair_draw_odds = draw?.fair_odds != null ? String(draw.fair_odds.toFixed(4)) : null;
  const fair_away_odds = away?.fair_odds != null ? String(away.fair_odds.toFixed(4)) : null;

  const home_edge = home?.has_edge ? home.edge : 0;
  const draw_edge = draw?.has_edge ? draw.edge : 0;
  const away_edge = away?.has_edge ? away.edge : 0;

  // THE GATE, applied here and not only in lib/marketAnchor.js.
  //
  // Swapping fair value to the Shin-de-vigged anchor without also applying the
  // gate produced precisely the board the architecture exists to prevent. On
  // the first live run the top four picks by EV were:
  //
  //   Harrogate v Solihull   away 5.75  fair prob 21.1%  +21.5%
  //   Bristol City v Walsall away 8.50  fair prob 13.4%  +13.7%
  //   NEC v Telstar          away 6.75  fair prob 16.1%   +9.0%
  //   Burnley v Notts County away 7.00  fair prob 15.5%   +8.2%
  //
  // Four longshots, every one of them outside the gate on BOTH the price
  // ceiling and the probability floor. That is the 49-flagged-longshots /
  // 1-winner / -70% book, reproduced live. A better fair value makes the
  // longshot edges MORE precise, not less frequent — the thing that removes
  // them is the gate, and the gate was still sitting in a module nobody on
  // this path called.
  //
  // `gate()` is imported rather than reimplemented so the engine, the match
  // card API and the backtest cannot drift. It returns every failure, and the
  // reasons are kept on the row so "why is the board empty" has an answer.
  const gateFor = (o) => ma.gate({
    edge: o?.has_edge ? o.edge : null,
    fairProb: o?.p_adj,
    bestPrice: o?.max_odds,
    booksQuoting: bookmakerCount,
  });
  const homeGate = gateFor(home), drawGate = gateFor(draw), awayGate = gateFor(away);

  // EV_THRESHOLD is kept as a floor beneath the gate rather than replaced by
  // it: the gate's MIN_EDGE is 2%, EV_THRESHOLD defaults to 0.5%, so the gate
  // is strictly the tighter of the two and the env var can only tighten
  // further, never loosen past it.
  const home_value = !!(homeGate.pass && home.edge >= EV_THRESHOLD);
  const draw_value = !!(drawGate.pass && draw.edge >= EV_THRESHOLD);
  const away_value = !!(awayGate.pass && away.edge >= EV_THRESHOLD);

  // best_outcome ranks only outcomes that PASSED. Ranking on raw edge across
  // all three is how a 13.4%-probability longshot became the headline pick.
  const edgeMap = {
    home: home_value ? home_edge : -Infinity,
    draw: draw_value ? draw_edge : -Infinity,
    away: away_value ? away_edge : -Infinity,
  };
  const best_outcome = Object.entries(edgeMap).reduce(
    (best, [k, v]) => (v > edgeMap[best] ? k : best), 'home'
  );
  const max_edge_val = Math.max(edgeMap.home, edgeMap.draw, edgeMap.away);

  // Score out of 100: 1% edge = 10 pts, 5% = 50 pts, 10% = 100 pts
  const max_edge_score   = max_edge_val > 0 ? Math.min(100, Math.round(max_edge_val * 1000)) : 0;
  const confidence_score = Math.min(100, Math.round(bookmakerCount * 5));

  const mes_breakdown = {
    home: { edge: home_edge, has_value: home_value, p_adj: home?.p_adj ?? null, fair_odds: home?.fair_odds ?? null },
    draw: { edge: draw_edge, has_value: draw_value, p_adj: draw?.p_adj ?? null, fair_odds: draw?.fair_odds ?? null },
    away: { edge: away_edge, has_value: away_value, p_adj: away?.p_adj ?? null, fair_odds: away?.fair_odds ?? null },
    bookmaker_count: bookmakerCount,
    score: max_edge_score,
  };

  const row = {
    match_id: match.id,
    best_home_odds, best_draw_odds, best_away_odds,
    best_home_book, best_draw_book, best_away_book,
    fair_home_odds, fair_draw_odds, fair_away_odds,
    home_edge, draw_edge, away_edge,
    home_value, draw_value, away_value,
    // MARKET_ANCHORED, not MARKET_CONSENSUS: these rows are now priced against
    // Shin-de-vigged Pinnacle, not against an average of the panel. The name
    // change is load-bearing — MARKET_CONSENSUS is barred from publishing by
    // lib/publication.js on the strength of the consensus's measured record,
    // and a row priced a different way must not inherit that verdict in either
    // direction. It carries its own name so it can earn its own.
    model_architecture: 'MARKET_ANCHORED',
    odds_fetched_at:    latestFetchedAt,
    computed_at:        new Date().toISOString(),
    best_outcome:  max_edge_val > 0 ? best_outcome : null,
    ev_per_unit:   max_edge_val > 0 ? parseFloat(max_edge_val.toFixed(6)) : null,
    max_edge_score, confidence_score, mes_breakdown,
    all_home_odds: home?.allOdds ?? null,
    all_draw_odds: draw?.allOdds ?? null,
    all_away_odds: away?.allOdds ?? null,
    over_edge: null, under_edge: null, over_value: false, under_value: false,
    btts_yes_edge: null, btts_no_edge: null, btts_yes_value: false, btts_no_value: false,
    bookings_over_edge: null, bookings_under_edge: null,
    bookings_over_value: false, bookings_under_value: false,
    corners_over_edge: null, corners_under_edge: null,
    corners_over_value: false, corners_under_value: false,
    _kickoff_at:     match.kickoff_at,
    _bookmakerCount: bookmakerCount,
    // Carried, not stored: `computed_values` has no column for it, but the
    // signal insert needs the market side of the score for the outcome it
    // picks. Underscore-prefixed like the other passthroughs so the column
    // filter below drops it before the upsert.
    _mktDevig: {
      home: home?.p_mkt_devig ?? null,
      draw: draw?.p_mkt_devig ?? null,
      away: away?.p_mkt_devig ?? null,
    },
  };

  return { skipped: false, row, hasValue: home_value || draw_value || away_value, match, consensus };
}

async function upsertComputedValues(supabase, rows) {
  if (!rows.length) return;

  const dbRows = rows.map(row => {
    const clean = {};
    for (const [k, v] of Object.entries(row)) {
      if (!k.startsWith('_') && k !== 'signals_written') clean[k] = v;
    }
    return clean;
  });

  const { error } = await supabase
    .from('computed_values')
    .upsert(dbRows, { onConflict: 'match_id,model_architecture' });

  if (error) throw new Error(`upsertComputedValues: ${error.message}`);
}

/**
 * @param architecture which model these signals are attributed to. The consensus
 *   path passes the default; the learning model passes 'SUPERMODEL' with its own
 *   edge fields, because a signal has to say WHICH machine made its claim — the
 *   frontend buckets market-vs-market against model-vs-market on exactly this.
 * @param fields  per-outcome column names, so the supermodel can supply its own
 *   edge/value columns without pretending to be the consensus.
 */
async function insertValueSignals(
  supabase, rows, phase = 'prematch',
  architecture = 'MARKET_ANCHORED',
  fields = { edge: o => `${o}_edge`, value: o => `${o}_value` },
) {
  const candidates = [];

  // THE DATA-QUALITY GATE (§2.6, lib/dataQuality.js). Nothing is scored against
  // a price we cannot date, that only one book is showing, or that sits far off
  // the pack. Until now odds_drift_pct and is_volatile were recorded and then
  // ignored, so part of every published edge was a measurement of data
  // freshness. Rejections are counted and reported, never silent — a run that
  // drops everything must look different from a quiet fixture list.
  const dq = thresholdsFromEnv();
  const rejected = new Map();

  for (const row of rows) {
    for (const outcome of ['home', 'draw', 'away']) {
      if (!row[fields.value(outcome)]) continue;
      const edge = row[fields.edge(outcome)];

      const quality = checkQuality({
        bestOdds:       row[`best_${outcome}_odds`],
        allOdds:        row[`all_${outcome}_odds`],
        booksInMarket:  row._bookmakerCount,
        oddsFetchedAt:  row.odds_fetched_at,
      }, dq);
      if (!quality.ok) {
        rejected.set(quality.reason, (rejected.get(quality.reason) ?? 0) + 1);
        continue;
      }

      candidates.push({
        match_id:           row.match_id,
        outcome,
        detected_odds:      row[`best_${outcome}_odds`],
        detected_edge:      edge,
        // Dead on arrival — the insert below overwrites this with null so
        // the frontend's computeMes() is the only implementation. Left as an
        // explicit null rather than a value nothing reads (§2.4).
        detected_mes:       null,
        bookmaker:          row[`best_${outcome}_book`],
        kickoff_at:         row._kickoff_at ?? null,
        model_architecture: architecture,
        phase,
        // The market side of the score: this outcome's probability with the
        // panel's margin removed. Null here means the row cannot be scored, and
        // `scoreSignal` will return a null verdict rather than fall back to the
        // margin-carrying `1/odds`.
        market_prob:        row._mktDevig?.[outcome] ?? null,
        _edge:              edge,
        _odds:              row[`best_${outcome}_odds`],
      });
    }
  }

  // THE DATA-QUALITY REPORT BELONGS HERE, and lived in insertSecondarySignals
  // from 218d017 until 6 Aug 2026 — a function where `rejected` is not in
  // scope, so the FIRST secondary-market candidate of every run threw
  // `ReferenceError: rejected is not defined` before a single row was written.
  // Production shows the signature exactly: h2h signals kept flowing all day
  // and totals/BTTS/corners/cards stopped dead at 08:18 UTC, when the commit
  // landed. Moving it back fixes the crash and restores the reporting the
  // commit intended, which no run has printed since.
  if (rejected.size) {
    const total = [...rejected.values()].reduce((a, b) => a + b, 0);
    console.log(`[values] data-quality gate rejected ${total} candidate(s) before scoring:`);
    for (const [reason, count] of [...rejected.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`         ${String(count).padStart(4)} × ${reason}`);
    }
  }

  if (!candidates.length) {
    console.log('[value_signals] no value outcomes');
    return 0;
  }

  const matchIds    = [...new Set(candidates.map(c => c.match_id))];
  const dedupCutoff = new Date(Date.now() - SIGNAL_DEDUP_MINUTES * 60 * 1000).toISOString();

  const { data: recent, error: selErr } = await supabase
    .from('value_signals')
    .select('match_id, outcome, detected_odds')
    .eq('model_architecture', architecture)
    .in('match_id', matchIds)
    .gte('detected_at', dedupCutoff);
  if (selErr) throw new Error(`insertValueSignals(select): ${selErr.message}`);

  const recentOdds = new Map();
  for (const r of (recent ?? [])) {
    recentOdds.set(`${r.match_id}|${r.outcome}`, parseFloat(r.detected_odds));
  }

  // value_signals_selection_price_unique is a PERMANENT unique index on
  // (match_id, market, outcome, model_architecture, detected_odds) — unlike the
  // SIGNAL_DEDUP_MINUTES window above, it never expires. Once a match's odds sit
  // unchanged for longer than that window, the recentOdds check above no longer
  // catches the repeat, and re-inserting the same (match, outcome, price) tuple
  // crashes the whole compute cycle with a duplicate-key error — aborting before
  // secondary signals / bet-of-day ever run. Pre-filter against full signal
  // history for these matches, the same pattern insertSecondarySignals uses
  // just below. The window above still controls is_mover tagging / spam
  // suppression; this set is what actually has to satisfy the DB constraint.
  const { data: everSignalled, error: histErr } = await supabase
    .from('value_signals')
    .select('match_id, market, outcome, model_architecture, detected_odds')
    .in('match_id', matchIds);
  if (histErr) throw new Error(`insertValueSignals(history select): ${histErr.message}`);

  const priceKey = (matchId, market, outcome, modelArch, odds) =>
    `${matchId}|${market ?? 'h2h'}|${outcome}|${modelArch ?? 'MARKET_CONSENSUS'}|${parseFloat(odds).toFixed(3)}`;

  const seenPrices = new Set(
    (everSignalled ?? []).map(r => priceKey(r.match_id, r.market, r.outcome, r.model_architecture, r.detected_odds))
  );

  const toInsert = [];
  let skippedSamePrice = 0;
  let skippedExisting = 0;

  for (const c of candidates) {
    const key      = `${c.match_id}|${c.outcome}`;
    const lastOdds = recentOdds.get(key);
    const curOdds  = parseFloat(c._odds);

    if (lastOdds != null && Math.abs(lastOdds - curOdds) < 0.001) {
      skippedSamePrice++;
      continue;
    }

    const candidateKey = priceKey(c.match_id, c.market, c.outcome, c.model_architecture, curOdds);
    if (seenPrices.has(candidateKey)) {
      skippedExisting++;
      continue;
    }
    seenPrices.add(candidateKey);

    // Conviction tier comes from the canonical odds+edge ladder; a re-detection
    // at a shifted price is an orthogonal event carried by is_mover.
    const is_mover = lastOdds != null;
    const signal_category = categoryFor({ odds: curOdds, edge: c._edge });

    const { _edge, _odds, ...signalRow } = c;
    // THE VERDICT, FROZEN AT DETECTION (migration 048's four columns, plus the
    // two probabilities from 039). Nothing wrote any of these until 6 Aug 2026,
    // so every row detected after 048's backfill carried a NULL score and the
    // product had to infer a rung from whatever number a surface happened to
    // hold. Storing it here is also the more correct of the two options: this is
    // what the signal was actually judged against, and the market moves.
    const scored = scoreSignal({ ...signalRow, detected_odds: curOdds, detected_edge: c._edge });
    toInsert.push({ ...signalRow, ...scored, signal_category, is_mover });
  }

  console.log(
    `[value_signals] candidates=${candidates.length}` +
    ` skipped_same_price=${skippedSamePrice} skipped_existing=${skippedExisting} to_insert=${toInsert.length}`
  );

  if (!toInsert.length) return 0;

  const { error: insErr } = await supabase.from('value_signals').insert(toInsert);
  if (insErr) throw new Error(`insertValueSignals(insert): ${insErr.message}`);

  const mv = toInsert.filter(r => r.is_mover).length;
  const pr = toInsert.filter(r => r.signal_category === 'Prime').length;
  const va = toInsert.filter(r => r.signal_category === 'Value').length;
  const ls = toInsert.filter(r => r.signal_category === 'Longshot').length;
  console.log(`[value_signals] inserted ${toInsert.length} (Prime=${pr} Value=${va} Longshot=${ls} movers=${mv})`);
  return toInsert.length;
}

const normTeam = s => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** team_elo lookup keyed by the SAME normalised name as team_statistics. */
async function fetchEloLookup(supabase) {
  const map = new Map();
  const { data, error } = await supabase.from('team_elo').select('team_name, elo, games');
  if (error) { console.warn('[ensemble] team_elo read failed:', error.message); return map; }
  for (const r of data ?? []) map.set(normTeam(r.team_name), r);
  return map;
}

/** Load team_statistics (by normalised name) and referee_stats for these matches. */
async function fetchStatsLookups(supabase, matches) {
  const statsByName = new Map();
  const { data: teamStats } = await supabase.from('team_statistics').select('*');
  for (const t of teamStats ?? []) statsByName.set(normTeam(t.team_name), t);

  const refs = [...new Set(matches.map(m => m.referee).filter(Boolean))];
  const refByName = new Map();
  if (refs.length) {
    const { data } = await supabase.from('referee_stats').select('*').in('referee_name', refs);
    for (const r of data ?? []) refByName.set(r.referee_name, r);
  }
  return { statsByName, refByName };
}

/**
 * Insert secondary-market signals (O/U, BTTS, corners, cards). Pre-filters
 * against existing (match, market, outcome, model) keys so we never violate the
 * dedup unique index — first signal per key wins, matching the 1X2 path.
 */
async function insertSecondarySignals(supabase, candidates, phase = 'prematch') {
  if (!candidates.length) return 0;
  const matchIds = [...new Set(candidates.map(c => c.match_id))];

  const { data: existing, error } = await supabase
    .from('value_signals')
    .select('match_id, market, outcome, model_architecture')
    .in('match_id', matchIds);
  if (error) throw new Error(`insertSecondarySignals(select): ${error.message}`);

  const key  = r => `${r.match_id}|${r.market ?? 'h2h'}|${r.outcome}|${r.model_architecture ?? ''}`;
  const seen = new Set((existing ?? []).map(key));

  const toInsert = [];
  for (const c of candidates) {
    if (seen.has(key(c))) continue;
    seen.add(key(c));
    // `model_prob` IS a column, and has been since migration 039. This line
    // read `const { model_prob, ...rest } = c;  // model_prob is internal, not a
    // column` — so the engine computed the model's own probability, asserted in
    // a comment that there was nowhere to put it, and dropped it on every
    // secondary signal ever written. That is why migration 048 found
    // model_prob/market_prob "NULL on all rows since inception" and had to
    // recover them arithmetically. Verified against production on 6 Aug 2026:
    // model_prob and market_prob are numeric(6,4), and prob_gap / model_sigma /
    // mxs / mxs_band all exist.
    toInsert.push({
      ...c,
      ...scoreSignal(c),
      phase,
      detected_mes:    null,             // frontend computes risk-adjusted MES
      signal_category: categoryFor({ odds: c.detected_odds, edge: c.detected_edge }),
    });
  }

  if (!toInsert.length) { console.log('[secondary] no new signals'); return 0; }

  const { error: insErr } = await supabase.from('value_signals').insert(toInsert);
  if (insErr) throw new Error(`insertSecondarySignals(insert): ${insErr.message}`);

  const byMkt = toInsert.reduce((m, r) => ((m[r.market] = (m[r.market] || 0) + 1), m), {});
  console.log(`[secondary] inserted ${toInsert.length}:`, byMkt);
  return toInsert.length;
}

async function updateBetOfDay(supabase, rows) {
  await supabase.from('matches').update({ is_bet_of_day: false }).eq('is_bet_of_day', true);
  const candidates = rows.filter(r =>
    Math.max(r.home_edge ?? 0, r.draw_edge ?? 0, r.away_edge ?? 0) > 0
  );
  if (!candidates.length) return null;
  const best = candidates.reduce((top, r) => {
    const e    = Math.max(r.home_edge ?? 0, r.draw_edge ?? 0, r.away_edge ?? 0);
    const topE = Math.max(top.home_edge ?? 0, top.draw_edge ?? 0, top.away_edge ?? 0);
    return e > topE ? r : top;
  });
  await supabase.from('matches').update({ is_bet_of_day: true }).eq('id', best.match_id);
  return best.match_id;
}

async function withPool(items, fn, concurrency) {
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    throw new RangeError(`COMPUTE_CONCURRENCY must be >= 1, got ${concurrency}`);
  }
  const results = [];
  for (let start = 0; start < items.length; start += concurrency) {
    const batch   = items.slice(start, start + concurrency);
    const settled = await Promise.allSettled(batch.map(fn));
    for (const s of settled) {
      results.push(s.status === 'fulfilled' ? s.value : null);
      if (s.status === 'rejected') console.error('[engine] match error:', s.reason?.message);
    }
  }
  return results;
}

async function main() {
  const { getClient } = require('./lib/supabaseClient'); // lazy — see top-of-file note
  const supabase = getClient();

  console.log('[engine] computeValues v7 — Market Consensus (Kaunitz) + price-change signals');
  console.log(
    `[engine] alpha=${USE_UNIFORM_ALPHA ? `uniform(${ALPHA_UNIFORM})` : 'directional'}` +
    ` min_books=${MIN_BOOKMAKERS} ev_threshold=${EV_THRESHOLD}` +
    ` dedup_window=${SIGNAL_DEDUP_MINUTES}min pool=${COMPUTE_CONCURRENCY}`
  );

  const allScheduled = await fetchMatchesForComputation(supabase);
  // Belt-and-braces CLV guard: a match whose kickoff has passed is in-play even
  // if its status row still says 'scheduled' (the live-status updater can lag).
  // Excluding it here guarantees no edge detected after kickoff is ever stamped
  // phase='prematch'. computeInplayValues.js picks these up instead.
  const now = Date.now();
  const matches = allScheduled.filter(m =>
    !m.kickoff_at || new Date(m.kickoff_at).getTime() > now
  );
  const droppedLive = allScheduled.length - matches.length;
  if (droppedLive > 0) {
    console.log(`[engine] skipped ${droppedLive} match(es) already past kickoff (handled by in-play engine)`);
  }
  if (!matches.length) {
    console.log('[engine] no scheduled matches with odds — done');
    return;
  }

  console.log(`[engine] processing ${matches.length} match(es)`);

  const results = await withPool(matches, computeMatch, COMPUTE_CONCURRENCY);

  let computed = 0, skipped = 0, value = 0;
  const computedRows = [];
  const valueRows    = [];

  for (const res of results) {
    if (!res || res.skipped) { skipped++; continue; }
    computed++;
    computedRows.push(res.row);
    if (res.hasValue) { value++; valueRows.push(res.row); }
  }

  console.log(`[engine] computed=${computed} skipped=${skipped} value=${value}`);

  if (!computedRows.length) return;

  // Secondary markets (O/U, BTTS, corners, cards) via Dixon-Coles + data-driven
  // corners/cards models. Price them, MERGE the prices/edges into each match's
  // computed_values row (so the feed, detail tabs and suggested-bets see them),
  // and collect +EV signal candidates. Non-fatal: never lose the 1X2 work.
  let secondaryCandidates = [];
  try {
    const live = results.filter(r => r && !r.skipped);
    const { statsByName, refByName } = await fetchStatsLookups(supabase, live.map(r => r.match));
    for (const r of live) {
      const hs = statsByName.get(normTeam(r.match.home_team?.name));
      const as = statsByName.get(normTeam(r.match.away_team?.name));
      const rs = r.match.referee ? refByName.get(r.match.referee) : null;
      Object.assign(r.row, sm.secondaryComputedValues(r.match, r.consensus, hs, as, rs));
      for (const c of sm.buildSecondarySignals(r.match, r.consensus, hs, as, rs)) {
        secondaryCandidates.push({ ...c, kickoff_at: r.match.kickoff_at ?? null });
      }
    }
  } catch (err) {
    console.error('[secondary] pricing failed (1X2 unaffected):', err.message);
  }

  // Independent pre-match model probabilities. The market-consensus block above
  // is derived FROM the bookmakers; this is a separate opinion held against them,
  // written to ensemble_*_prob for the feed's Model Certainty. Non-fatal and
  // gated by lib/halftimeFeatures.buildPrematchVector: it fills a row only where
  // the retrained supermodel is in distribution (known league incl. Allsvenskan/
  // MLS, warm ELO, real form) — otherwise the columns stay null, never guessed.
  try {
    const infer = require('./ensemble/inference');
    if (infer.ensembleAvailable?.()) {
      const live = results.filter(r => r && !r.skipped);
      const [{ statsByName }, eloByName] = await Promise.all([
        fetchStatsLookups(supabase, live.map(r => r.match)),
        fetchEloLookup(supabase),
      ]);
      let filled = 0;
      for (const r of live) {
        const hKey = normTeam(r.match.home_team?.name);
        const aKey = normTeam(r.match.away_team?.name);
        const { vector } = buildPrematchVector({
          league:    r.match.league?.name,
          homeStats: statsByName.get(hKey),
          awayStats: statsByName.get(aKey),
          homeElo:   eloByName.get(hKey),
          awayElo:   eloByName.get(aKey),
          h2hHomeWinRate: undefined, // last-5 H2H not materialised → builder prior
        });
        if (!vector) continue;
        const probs = await infer.supermodelPrematchInference(vector);
        if (!probs) continue;
        r.row.ensemble_home_prob = probs.home;
        r.row.ensemble_draw_prob = probs.draw;
        r.row.ensemble_away_prob = probs.away;
        filled++;

        // ── The learning model now PUBLISHES ────────────────────────────────
        // Until now these probabilities were written and never used: they drove
        // no signal, no edge and no conviction, and reached the product only as
        // a "model certainty" readout on the match page. The most sophisticated
        // thing in the stack was decorative.
        //
        // They are written and they stop there. Under the ruling of 6 Aug 2026
        // a model probability is DISPLAY ONLY: it may sit beside the market's
        // number on a match card, and it may never be turned into an edge, a
        // value flag or a score. The block that used to do that
        // (supermodelEdge, and the _sm_* transport columns) is deleted — see
        // the note where it used to live.
        //
        // "Decorative" is the right description of this data and is no longer
        // a criticism. The measured record says the model's disagreement with
        // the market is anti-predictive, so a decorative model is the only
        // honest kind we currently have.
      }
      console.log(`[ensemble] pre-match model probs written for ${filled}/${live.length} match(es)`);
    }
  } catch (err) {
    console.error('[ensemble] pre-match model failed (1X2 unaffected):', err.message);
  }

  await upsertComputedValues(supabase, computedRows);

  if (valueRows.length) {
    await insertValueSignals(supabase, valueRows);
  }
  // The supermodel signal insert used to sit here. It is deleted, not disabled:
  // a model publisher behind a flag is a model publisher someone turns on.
  // Its probabilities are still written to computed_values as display-only
  // columns; nothing turns them into a signal.
  if (secondaryCandidates.length) {
    try { await insertSecondarySignals(supabase, secondaryCandidates); }
    catch (err) { console.error('[secondary] signal insert failed:', err.message); }
  } else {
    console.log('[secondary] no signal candidates this cycle');
  }

  await updateBetOfDay(supabase, computedRows);
}

if (require.main === module) {
  main().catch(err => {
    console.error('[engine] fatal:', err.message);
    process.exit(1);
  });
}

// Exported so computeInplayValues.js can reuse the consensus core and the
// signal-insert helpers (with phase='inplay') instead of duplicating them.
module.exports = {
  // supermodelEdge is deliberately absent — see the note where it was deleted.
  fetchMatchesForComputation,
  computeConsensus,
  computeMatch,
  upsertComputedValues,
  insertValueSignals,
  insertSecondarySignals,
  fetchStatsLookups,
  updateBetOfDay,
  withPool,
  formatBookName,
};
