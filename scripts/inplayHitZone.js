#!/usr/bin/env node
'use strict';

/**
 * scripts/inplayHitZone.js — is there live match state the price gets wrong?
 *
 * Reads the corpus, joins it to what actually happened, and prints the report.
 * Every decision it makes is in lib/hitZone.js so it can be tested without a
 * database; this file is the IO and the printing.
 *
 * READ THE CONTROL FIRST. The report opens with the market's own calibration
 * curve, because a broken join and a real edge look identical in a zone table
 * and completely different in a calibration curve. If the de-vigged price does
 * not predict the result, stop — the join is wrong, not the market.
 *
 * Usage:
 *   node scripts/inplayHitZone.js                    the last 30 days
 *   node scripts/inplayHitZone.js --days=7
 *   node scripts/inplayHitZone.js --explore=0.5      holdout split (default 0.5)
 *   node scripts/inplayHitZone.js --json
 *
 * WHAT IT CANNOT DO YET, and it says so rather than printing a small number as
 * though it were an answer: `inplay_momentum` starts empty on 26 Aug 2026.
 * Projected at full loop coverage the corpus grows by ~65 matches a day, so a
 * week is ~450 matches — enough to detect a 5pp miss, not a 3pp one, and the
 * holdout halves it again. The report prints the sample it had and the bar it
 * had to clear; it does not soften either.
 */

const { getClient } = require('../lib/supabaseClient');
const hz = require('../lib/hitZone');

const arg = (name, dflt) => {
  const m = process.argv.find(a => a.startsWith(`--${name}=`));
  return m ? m.split('=').slice(1).join('=') : dflt;
};
const DAYS = parseFloat(arg('days', '30'));
const EXPLORE = parseFloat(arg('explore', '0.5'));
const JSON_OUT = process.argv.includes('--json');
const PAGE = 1000;

/**
 * Paged read. PostgREST caps a response at 1000 rows WHATEVER `.limit()` says,
 * and an unpaged read looks completely successful while silently losing the
 * tail — which here would be the busiest matchdays. Dedupes by id rather than
 * trusting page length, because a layer that answers the URL and ignores the
 * Range header returns the same page for ever.
 */
async function pagedRead(supabase, table, columns, apply) {
  const rows = [];
  const seen = new Set();
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(table).select(columns).order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    q = apply ? apply(q) : q;
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data?.length) break;
    let fresh = 0;
    for (const r of data) {
      if (r.id != null && seen.has(r.id)) continue;
      if (r.id != null) seen.add(r.id);
      rows.push(r); fresh++;
    }
    if (data.length < PAGE || fresh === 0) break;
  }
  return rows;
}

async function build(supabase) {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();

  const matches = await pagedRead(supabase, 'matches',
    'id, kickoff_at, status, goals_home, goals_away',
    q => q.eq('status', 'completed').gte('kickoff_at', since));
  const byMatch = new Map(matches.map(m => [m.id, m]));

  const series = await pagedRead(supabase, 'inplay_market_series',
    'id, match_id, captured_at, minute, goals_home, goals_away, selection, market, best_odds',
    q => q.gte('captured_at', since));

  const momentum = await pagedRead(supabase, 'inplay_momentum',
    'id, match_id, captured_at, minute, goals_home, goals_away, shots_home, shots_away, ' +
    'sot_home, sot_away, inside_home, inside_away, corners_home, corners_away, ' +
    'poss_home, poss_away, xg_home, xg_away, saves_home, saves_away, reds_home, reds_away',
    q => q.gte('captured_at', since));

  const momByMatch = new Map();
  for (const m of momentum) {
    if (!momByMatch.has(m.match_id)) momByMatch.set(m.match_id, []);
    momByMatch.get(m.match_id).push(m);
  }

  const ticks = hz.pivotTicks(series.filter(r => byMatch.has(r.match_id)));
  const observations = [];
  let noProbs = 0, noMomentum = 0;

  for (const tick of ticks) {
    const match = byMatch.get(tick.matchId);
    const probs = hz.marketProbs(tick);
    if (!probs) { noProbs++; continue; }
    const mom = hz.nearestMomentum(momByMatch.get(tick.matchId), tick.capturedAt);
    if (!mom) noMomentum++;
    for (const selection of ['home', 'away']) {
      const won = hz.didWin(selection, match.goals_home, match.goals_away);
      if (won == null) continue;
      observations.push({
        matchId: tick.matchId,
        kickoffAt: match.kickoff_at,
        capturedAt: tick.capturedAt,
        minute: tick.minute,
        selection,
        pMarket: probs[selection],
        odds: Number(tick.legs[selection].best_odds),
        won,
        features: mom ? hz.orientFeatures(mom, selection, tick) : null,
      });
    }
  }

  return {
    matches: matches.length, ticks: ticks.length,
    momentumRows: momentum.length,
    observations, noProbs, noMomentum,
    withFeatures: observations.filter(o => o.features).length,
  };
}

const pct = v => (v == null ? '   —  ' : `${(v * 100).toFixed(2)}%`.padStart(7));
const num = (v, d = 2) => (v == null ? '  —  ' : v.toFixed(d).padStart(6));

function report(built) {
  const { observations } = built;
  console.log(`\nIN-PLAY HIT ZONE — last ${DAYS} days`);
  console.log('='.repeat(72));
  console.log(`corpus            ${built.matches} completed matches · ${built.ticks} priced ticks · ` +
              `${built.momentumRows} momentum rows`);
  console.log(`observations      ${observations.length} (home/away legs), ` +
              `${built.withFeatures} carry match state`);
  if (built.noProbs) console.log(`ticks unpriceable ${built.noProbs} (a leg missing — the vector is de-vigged whole)`);
  if (built.noMomentum) console.log(`ticks with no state within 90s: ${built.noMomentum}`);

  // ── THE CONTROL ───────────────────────────────────────────────────────────
  console.log('\nCONTROL — does the de-vigged price predict the result?');
  console.log('Read this first. A broken join and a real edge look identical in a');
  console.log('zone table and completely different here.\n');
  console.log('  band          n   expected  realised       z');
  let worst = 0, controlN = 0;
  for (const b of hz.calibrationCurve(observations)) {
    if (!b.n) continue;
    controlN += b.n;
    if (Number.isFinite(b.z)) worst = Math.max(worst, Math.abs(b.z));
    console.log(`  ${b.lo.toFixed(1)}-${b.hi.toFixed(1)}  ${String(b.n).padStart(7)}   ` +
                `${pct(b.expected)}   ${pct(b.realised)}  ${num(b.z)}`);
  }
  if (!controlN) {
    console.log('  no priced observations — nothing to check, and nothing below means anything');
    return;
  }
  console.log(`\n  worst band |z| = ${worst.toFixed(2)}. Above ~3 with a healthy sample, SUSPECT THE`);
  console.log('  JOIN before believing any zone: an inverted away leg, a mismatched');
  console.log('  tick or a completed flag that lied all present exactly like this.');

  // ── THE ZONES ─────────────────────────────────────────────────────────────
  const k = hz.HYPOTHESES.length;
  const bar = hz.bonferroniZ(k);
  const split = hz.splitByTime(observations, EXPLORE);
  console.log(`\nZONES — ${k} pre-registered hypotheses`);
  console.log(`Corrected bar |z| >= ${bar.toFixed(2)} (Bonferroni over ${k}); uncorrected 1.96 would`);
  console.log(`admit ${hz.expectedFalsePositives(k).toFixed(2)} by chance. Split by kickoff: ` +
              `${split.exploreMatches} explore / ${split.holdoutMatches} holdout matches.\n`);

  for (const half of [['EXPLORE', split.explore], ['HOLDOUT', split.holdout]]) {
    console.log(`  ${half[0]}`);
    console.log('    zone                        n   expected  realised       z    return');
    for (const h of hz.HYPOTHESES) {
      const obs = hz.firstEntryPerMatch(half[1], h);
      const s = hz.zoneStats(obs);
      const flag = (s.z != null && Math.abs(s.z) >= bar) ? ' *' : '';
      console.log(`    ${h.key.padEnd(20)}${String(s.n).padStart(7)}   ${pct(s.expected)}   ` +
                  `${pct(s.realised)}  ${num(s.z)}  ${pct(s.flatReturn)}${flag}`);
    }
    console.log('');
  }

  console.log('  * clears the corrected bar. A zone that clears it on EXPLORE and');
  console.log('    fails on HOLDOUT is a description of the past, not a hit zone.');
  console.log('    `return` is flat-stake at the best price and is far noisier than');
  console.log('    the calibration miss — it will rarely clear anything at this n.\n');

  for (const h of hz.HYPOTHESES) console.log(`  ${h.key.padEnd(20)} ${h.label} — ${h.why}`);
  console.log('');
}

(async () => {
  const built = await build(getClient());
  if (JSON_OUT) {
    console.log(JSON.stringify({
      days: DAYS, matches: built.matches, ticks: built.ticks,
      momentumRows: built.momentumRows, observations: built.observations.length,
      bar: hz.bonferroniZ(hz.HYPOTHESES.length),
      control: hz.calibrationCurve(built.observations),
      zones: Object.fromEntries(hz.HYPOTHESES.map(h => {
        const split = hz.splitByTime(built.observations, EXPLORE);
        return [h.key, {
          explore: hz.zoneStats(hz.firstEntryPerMatch(split.explore, h)),
          holdout: hz.zoneStats(hz.firstEntryPerMatch(split.holdout, h)),
        }];
      })),
    }, null, 2));
    return;
  }
  report(built);
})().catch(err => { console.error('[hitzone] FATAL:', err.message); process.exit(1); });
