/**
 * lib/lambdaBoard.js — live "model vs market" inference for the λ goals-model.
 *
 * Loads the production λ-model exported by ensemble/train_lambda_prod.py:
 *   ensemble/models/lambda_home.onnx / lambda_away.onnx   (float32[1,20] → λ)
 *   ensemble/models/lambda_bundle.json                    (feature contract +
 *       per-club current state + league stats/tags + ranking weights)
 *
 * Given a fixture (home name, away name, league key, current 1X2 odds), it:
 *   1. normalizes club names → looks up each club's state (elo, form, xG, squad)
 *   2. assembles the exact feature vector (market anchor = de-vigged live odds)
 *   3. runs the two ONNX regressors → (λ_home, λ_away)
 *   4. prices every market via lib/dixonColes.priceSheet
 *   5. scores each candidate edge by CREDIBILITY (segment × league weights,
 *      stale-price cap) — the backtest evidence, encoded.
 *
 * Pure lookup + inference: no walk-forward at runtime. The bundle carries each
 * club's state as of its last played match and is refreshed on every retrain.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { priceSheet, devig } = require('./dixonColes');

const MODEL_DIR = path.join(__dirname, '..', 'ensemble', 'models');

// ── Club-name normalization — MUST mirror ensemble/scrapers/names.py ─────────
const SUFFIXES = new Set([
  'fc', 'afc', 'cf', 'sc', 'ac', 'as', 'ss', 'ssd', 'ssc', 'us', 'ud', 'cd',
  'sv', 'vfb', 'vfl', 'tsv', 'fsv', 'bsc', 'rc', 'sd', 'if', 'bk', 'ff', 'aik',
  'calcio', 'club', 'the',
]);
const ALIAS = {
  'man city': 'manchestercity', 'man united': 'manchesterunited',
  'man utd': 'manchesterunited', "nott'm forest": 'nottinghamforest',
  'wolves': 'wolverhampton', 'sheffield weds': 'sheffieldwednesday',
  'west brom': 'westbromwichalbion', 'spurs': 'tottenham',
  'qpr': 'queensparkrangers', 'west ham': 'westham',
  'manchester city': 'manchestercity', 'manchester united': 'manchesterunited',
  'tottenham hotspur': 'tottenham', 'wolverhampton wanderers': 'wolverhampton',
  'bayern munich': 'bayernmunchen', 'bayern munchen': 'bayernmunchen',
  'fc bayern munich': 'bayernmunchen', 'borussia dortmund': 'dortmund',
  'inter milan': 'inter', 'internazionale': 'inter', 'ac milan': 'milan',
  'paris saint-germain': 'parissaintgermain', 'psg': 'parissaintgermain',
  'atletico madrid': 'atleticomadrid', 'atletico de madrid': 'atleticomadrid',
  'sporting cp': 'sporting', 'sporting lisbon': 'sporting',
};

/**
 * Letters NFKD CANNOT decompose, folded before the ASCII strip.
 *
 * ── WHY (measured, 22 Aug 2026) ─────────────────────────────────────────────
 * `ł`, `ı`, `ø`, `ß` and `đ` are distinct LETTERS, not a base plus a combining
 * mark, so NFKD leaves them whole — and the `[^a-z0-9 ]` strip below then turns
 * each one into a SPACE. Tokens are joined with '', so the letter does not
 * become `l`, it DISAPPEARS:
 *
 *     Wisła Płock       -> wisapock      (not wislaplock)
 *     Zagłębie Lubin    -> zagebielubin  (not zaglebielubin)
 *     Kasımpaşa         -> kasmpasa      (not kasimpasa)
 *
 * That is not cosmetic, because the two sides of the match spell them
 * differently. Our `teams` rows are ASCII — `Wisla Plock`, `Zaglebie Lubin` —
 * while The Odds API sends the diacritic form, so ONE club produced TWO keys
 * and `resolveMatch` could never join them. Six of the 61 NAME_MISMATCH events
 * in the 23:38 audit are this, across poland_ekstraklasa alone.
 *
 * THIS IS NOT A LOOSENED THRESHOLD. `MATCH_WINDOW_MIN`, the similarity floor
 * and the exact-key join are all untouched; this makes two spellings of the
 * SAME LETTER agree, which is a character identity and cannot bring two
 * DIFFERENT clubs together — the failure mode a lowered floor has, where a
 * live price prints under the wrong game.
 *
 * The table covers the standard Latin set rather than only the letters our
 * data happens to hold today: these are properties of the alphabet, not of
 * this week's fixtures. Same ruling eve-frontend's `lib/search.fold` records.
 */
const UNDECOMPOSABLE = {
  'ł': 'l', 'ı': 'i', 'ø': 'o', 'ß': 'ss', 'đ': 'd', 'ð': 'd',
  'þ': 'th', 'æ': 'ae', 'œ': 'oe', 'ħ': 'h', 'ŋ': 'n', 'ŧ': 't', 'ĸ': 'k',
};

function clubKey(name) {
  const raw = String(name ?? '').trim().toLowerCase();
  if (ALIAS[raw]) return ALIAS[raw];
  let s = raw.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/[łıøßđðþæœħŋŧĸ]/g, ch => UNDECOMPOSABLE[ch] ?? ch);
  s = s.replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ');
  let toks = s.split(/\s+/).filter(t => t && !SUFFIXES.has(t));
  if (toks[0] === '1') toks = toks.slice(1);
  const k = toks.join('');
  return ALIAS[k] ?? k;
}

// ── Bundle + ONNX sessions (lazy singletons) ─────────────────────────────────
let bundle = null;
let sessions = null;

function loadBundle() {
  if (bundle) return bundle;
  const p = path.join(MODEL_DIR, 'lambda_bundle.json');
  bundle = JSON.parse(fs.readFileSync(p, 'utf8'));
  // clubs whose key differs from stored key (bundle is keyed by python club_key,
  // which this file mirrors — direct lookup).
  return bundle;
}

// onnxruntime-node is an OPTIONAL dependency and its postinstall DOWNLOADS a
// native binary, so `npm install` reports success with the package absent —
// which is what happens behind an egress block. Mirrors ensemble/inference.js.
let ort = null;
function getOrt() {
  if (ort) return ort;
  try { ort = require('onnxruntime-node'); } catch { ort = null; }
  return ort;
}

async function loadSessions() {
  if (sessions) return sessions;
  const ort = getOrt();
  if (!ort) throw new Error(`lambda board: ${unavailableReason()}`);
  const [home, away] = await Promise.all([
    ort.InferenceSession.create(path.join(MODEL_DIR, 'lambda_home.onnx')),
    ort.InferenceSession.create(path.join(MODEL_DIR, 'lambda_away.onnx')),
  ]);
  sessions = { home, away, ort };
  return sessions;
}

const ARTIFACTS = ['lambda_home.onnx', 'lambda_away.onnx', 'lambda_bundle.json'];

function missingArtifacts() {
  return ARTIFACTS.filter(f => !fs.existsSync(path.join(MODEL_DIR, f)));
}

function runtimePresent() {
  return getOrt() !== null;
}

/**
 * Why the board cannot price, or null if it can. The artifacts are only HALF of
 * "available" — a runtime is the other half, and `available()` used to check
 * the files alone, so on a machine with no onnxruntime it said yes and
 * priceFixture threw MODULE_NOT_FOUND several frames later. The two causes are
 * different (a retrain that never shipped vs a dependency that never
 * installed) and must not read the same, so this NAMES which one.
 */
function unavailableReason() {
  const missing = missingArtifacts();
  if (missing.length) return `model artifacts missing: ${missing.join(', ')}`;
  if (!runtimePresent()) return 'onnxruntime-node is not installed (optional dependency; its postinstall fetches a native binary)';
  return null;
}

function available() {
  return unavailableReason() === null;
}

// ── Feature assembly ─────────────────────────────────────────────────────────
function clubState(b, name) {
  return b.clubs[clubKey(name)] ?? null;
}

function buildVector(b, { homeName, awayName, leagueKey, mp }) {
  const h = clubState(b, homeName);
  const a = clubState(b, awayName);
  const d = b.defaults;
  const lg = b.league_stats[leagueKey] ?? b.league_global;
  const hv = h ?? { elo: d.elo, gf: d.gf_home, ga: d.gf_away, xg: d.gf_home, sv: d.sv, sv_has: 0 };
  const av = a ?? { elo: d.elo, gf: d.gf_away, ga: d.gf_home, xg: d.gf_away, sv: d.sv, sv_has: 0 };
  const values = {
    m_home: mp[0], m_draw: mp[1], m_away: mp[2],
    elo_home: hv.elo, elo_away: av.elo, elo_diff: hv.elo - av.elo,
    h_gf: hv.gf, h_ga: hv.ga, a_gf: av.gf, a_ga: av.ga,
    h_xg: hv.xg, a_xg: av.xg, has_xg: h && a ? 1 : 0,
    lg_home_gf: lg.home_gf, lg_away_gf: lg.away_gf, lg_draw: lg.draw,
    sv_home: hv.sv, sv_away: av.sv,
    sv_diff: (hv.sv_has && av.sv_has) ? hv.sv - av.sv : 0,
    sv_has: (hv.sv_has && av.sv_has) ? 1 : 0,
  };
  const vec = b.feature_order.map(f => {
    if (!(f in values)) throw new Error(`lambdaBoard: bundle feature '${f}' not implemented`);
    return values[f];
  });
  return { vec, matched: { home: !!h, away: !!a } };
}

// ── Credible-edge scoring (the backtest evidence, encoded) ───────────────────
function segOf(marketP) {
  if (marketP >= 0.5) return 'fav';
  if (marketP >= 0.25) return 'mid';
  return 'longshot';
}

function credibleScore(b, edge, marketP, leagueKey) {
  const tag = b.league_tags[leagueKey] ?? 'neutral';
  const seg = segOf(marketP);
  return {
    seg, tag,
    score: edge * (b.seg_weights[seg] ?? 0.5) * (b.tag_weights[tag] ?? 0.75),
  };
}

/**
 * Price one fixture and rank its model-vs-market disagreements.
 *
 * @param {object} fx
 *   homeName, awayName   — team names as they appear in production
 *   leagueKey            — corpus league slug ('epl', 'e1', …) or null
 *   odds: { home, draw, away }             — best/consensus current 1X2 prices
 *   totals?: { line, over, under }         — optional O/U prices
 * @returns { lambdaHome, lambdaAway, sheet, opportunities[], matched } | null
 */
async function priceFixture(fx) {
  if (!available()) return null;
  const b = loadBundle();
  const { odds } = fx;
  if (!(odds?.home > 1 && odds?.draw > 1 && odds?.away > 1)) return null;

  const mp = devig([1 / odds.home, 1 / odds.draw, 1 / odds.away]);
  const { vec, matched } = buildVector(b, {
    homeName: fx.homeName, awayName: fx.awayName,
    leagueKey: fx.leagueKey, mp,
  });

  const { home, away, ort } = await loadSessions();
  const tensor = new ort.Tensor('float32', Float32Array.from(vec), [1, vec.length]);
  const [oh, oa] = await Promise.all([
    home.run({ float_input: tensor }), away.run({ float_input: tensor })]);
  const firstVal = o => Number(o[Object.keys(o)[0]].data[0]);
  const lambdaHome = Math.min(Math.max(firstVal(oh), 0.05), 6);
  const lambdaAway = Math.min(Math.max(firstVal(oa), 0.05), 6);

  const line = fx.totals?.line ?? 2.5;
  const sheet = priceSheet(lambdaHome, lambdaAway, { totalsLines: [line] });

  const cands = [
    { market: '1X2', outcome: 'home', p: sheet.pHome, odds: odds.home, marketP: mp[0] },
    { market: '1X2', outcome: 'draw', p: sheet.pDraw, odds: odds.draw, marketP: mp[1] },
    { market: '1X2', outcome: 'away', p: sheet.pAway, odds: odds.away, marketP: mp[2] },
  ];
  if (fx.totals?.over > 1 && fx.totals?.under > 1) {
    const [pOverMkt] = devig([1 / fx.totals.over, 1 / fx.totals.under]);
    cands.push(
      { market: `OU${line}`, outcome: 'over', p: sheet.pOver[line], odds: fx.totals.over, marketP: pOverMkt },
      { market: `OU${line}`, outcome: 'under', p: sheet.pUnder[line], odds: fx.totals.under, marketP: 1 - pOverMkt },
    );
  }

  const opportunities = [];
  for (const c of cands) {
    const edge = c.p * c.odds - 1;
    if (!(edge > 0) || edge > b.max_plausible_edge) continue;
    const { seg, tag, score } = credibleScore(b, edge, c.marketP, fx.leagueKey);
    opportunities.push({
      ...c,
      modelP: Number(c.p.toFixed(4)),
      fairOdds: Number((1 / c.p).toFixed(3)),
      edge: Number(edge.toFixed(4)),
      seg, leagueTag: tag,
      credibleScore: Number(score.toFixed(4)),
    });
  }
  opportunities.sort((x, y) => y.credibleScore - x.credibleScore);

  return { lambdaHome, lambdaAway, sheet, opportunities, matched };
}

module.exports = { clubKey, available, unavailableReason, missingArtifacts,
                   runtimePresent, loadBundle, buildVector, priceFixture,
                   credibleScore, segOf };
