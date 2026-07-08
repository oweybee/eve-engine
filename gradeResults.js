/**
 * Max Edge — Result grading (settles recommendations → unlocks ROI / Yield / Win Rate)
 *
 * For every unsettled recommendation whose match kicked off long enough ago to
 * be finished, fetch the final score, decide the outcome (home/draw/away),
 * mark settled + won, and capture the closing price if still missing. ROI and
 * Yield in the Model Performance dashboard derive from these settled rows.
 *
 * Results source: The Odds API /scores (needs ODDS_API_KEY). Matched to our
 * fixtures by team name + kickoff date, so it works regardless of whether the
 * match record originated from The Odds API or Betfair.
 *
 * Usage: export $(cat .env | xargs) && node gradeResults.js
 */

'use strict';

const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FINISHED_AFTER_MIN = 130; // a match is assumed final ~2h10m after kickoff

// The Odds API sport keys for every graded competition. Keep in sync with the
// league coverage in planDay.js (LEAGUE_CATALOG).
const SPORT_KEYS = [
  'soccer_epl',                 // Premier League
  'soccer_spain_la_liga',       // La Liga
  'soccer_germany_bundesliga',  // Bundesliga
  'soccer_italy_serie_a',       // Serie A
  'soccer_france_ligue_one',    // Ligue 1
  'soccer_efl_champ',           // EFL Championship
  'soccer_england_league1',     // EFL League One
  'soccer_england_league2',     // EFL League Two
  'soccer_fifa_world_cup',      // FIFA World Cup (in-flight 2026 tournament)
];

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 120)}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

const norm = s => (s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

/** Fetches finished scores from The Odds API and indexes by team-pair + date. */
async function fetchScores() {
  const index = new Map();
  for (const sport of SPORT_KEYS) {
    const url = `https://api.the-odds-api.com/v4/sports/${sport}/scores/?daysFrom=3&apiKey=${ODDS_API_KEY}`;
    let events;
    try { events = await httpGet(url); }
    catch (e) { console.warn(`  [warn] scores fetch failed for ${sport}: ${e.message}`); continue; }
    for (const ev of events ?? []) {
      if (!ev.completed || !ev.scores) continue;
      const find = name => ev.scores.find(s => norm(s.name) === norm(name));
      const h = find(ev.home_team), a = find(ev.away_team);
      if (!h || !a) continue;
      const date = (ev.commence_time ?? '').slice(0, 10);
      const key = `${norm(ev.home_team)}|${norm(ev.away_team)}|${date}`;
      index.set(key, { home: +h.score, away: +a.score });
    }
  }
  return index;
}

/**
 * P0-4 fix: guard against NaN scores before comparison.
 * Previously, NaN > NaN = false and NaN < NaN = false, so any parse failure
 * silently returned 'draw' regardless of actual result.
 *
 * @param {number} hs - home score
 * @param {number} as_ - away score
 * @returns {'home'|'draw'|'away'|null}
 */
function outcomeFromScore(hs, as_) {
  if (!Number.isFinite(hs) || !Number.isFinite(as_)) return null;
  if (hs > as_) return 'home';
  if (hs < as_) return 'away';
  return 'draw';
}

async function run() {
  if (!ODDS_API_KEY) {
    console.error('[grade] ODDS_API_KEY not set — cannot fetch results. Set it to enable grading.');
    process.exit(1);
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  const { data: recs, error } = await supabase
    .from('recommendations')
    .select(`
      id, match_id, selection, recommended_odds, settled,
      match:matches (
        kickoff_at,
        home_team:teams!matches_home_team_id_fkey ( name ),
        away_team:teams!matches_away_team_id_fkey ( name )
      )
    `)
    .eq('settled', false);

  if (error) { console.error('[grade] fetch failed:', error.message); process.exit(1); }

  const due = (recs ?? []).filter(r => {
    const k = r.match?.kickoff_at ? new Date(r.match.kickoff_at).getTime() : null;
    return k != null && (Date.now() - k) / 60000 >= FINISHED_AFTER_MIN;
  });

  console.log(`[grade] ${recs?.length ?? 0} unsettled, ${due.length} past full-time`);
  // P1-4 fix: fetchScores() moved to AFTER the due.length guard.
  // Previously it fired unconditionally, burning one Odds API credit on every
  // engine run even when there was nothing to grade.
  if (!due.length) return;

  const scores = await fetchScores();
  let settled = 0, unmatched = 0;

  for (const r of due) {
    const home = r.match?.home_team?.name, away = r.match?.away_team?.name;
    const date = (r.match?.kickoff_at ?? '').slice(0, 10);
    const score = scores.get(`${norm(home)}|${norm(away)}|${date}`);
    if (!score) { unmatched++; continue; }

    const result = outcomeFromScore(score.home, score.away);
    if (result === null) {
      console.warn(`  [grade] skip ${home} vs ${away} — unparseable scores: ${JSON.stringify(score)}`);
      unmatched++;
      continue;
    }
    const won = r.selection === result;

    const { error: uErr } = await supabase.from('recommendations')
      .update({ settled: true, won }).eq('id', r.id);
    if (!uErr) { settled++; console.log(`  ${home} ${score.home}-${score.away} ${away} → ${result} | ${r.selection} ${won ? 'WON' : 'lost'}`); }
  }

  console.log(`[grade] done: settled=${settled} unmatched=${unmatched}`);
}

if (require.main === module) {
  run().catch(e => { console.error('[grade] fatal:', e.message); process.exit(1); });
}

module.exports = { run, outcomeFromScore };
