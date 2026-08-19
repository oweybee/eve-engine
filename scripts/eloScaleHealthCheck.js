'use strict';

/**
 * scripts/eloScaleHealthCheck.js — the ELO scale invariants, checked rather
 * than checkable.
 *
 * Five views in the database each answer a question that must always have the
 * same answer. A view nobody queries is documentation, not a control — the
 * publication gate, the anon write grants and the closing-line label were all
 * "obviously fine" right up until somebody measured them. This runs them.
 *
 *   team_alias_false_merges    two clubs that have PLAYED each other share one
 *                              canonical key. Found four (LAFC/LA Galaxy,
 *                              Dundee/Dundee Utd, FC Tokyo/Tokyo Verdy,
 *                              Paris FC/PSG) that were already in team_alias.
 *   team_alias_cross_country   one canonical key plays domestic league football
 *                              in two countries. Found four more, 1,166 games,
 *                              and they were why the first league-strength fit
 *                              returned Liga MX as stronger than the Premier
 *                              League.
 *   team_scale_stale_league    a club scaled by a division it is not the one it
 *                              is next scheduled to play in. Caught three
 *                              promoted clubs being scaled 108 points low in a
 *                              League Cup tie six days out.
 *   league_strength_staleness  cross-league evidence has landed since the last
 *                              fit. Not a defect — a prompt to refit.
 *   fixture_placement          fixtures that will get no ELO forecast. Also not
 *                              a defect: it is the VISIBLE form of a withheld
 *                              one, and each row names the club. Reported, never
 *                              failed on.
 *
 * RED on the first three, which are contradictions. AMBER on the last two,
 * which are information. Exit 1 only on red, so this can run hourly without
 * crying wolf about a fixture nobody can rate.
 */

const { getClient } = require('../lib/supabaseClient');

/** A contradiction: the answer must be zero. */
const INVARIANTS = [
  ['team_alias_false_merges',
    'two clubs that have played each other resolve to one canonical key'],
  ['team_alias_cross_country',
    'one canonical key plays domestic league football in two countries'],
  ['team_scale_stale_league',
    'a club is scaled by a division it is not next scheduled to play in'],
];

/** Information: reported, never failed on. */
const NOTICES = [
  ['league_strength_staleness',
    'league(s) have new cross-league evidence since the last fit — consider refitting'],
];

async function countOf(supabase, view) {
  const { count, error } = await supabase.from(view).select('*', { count: 'exact', head: true });
  if (error) throw new Error(`${view}: ${error.message}`);
  return count ?? 0;
}

async function sample(supabase, view, columns, limit = 5) {
  const { data } = await supabase.from(view).select(columns).limit(limit);
  return data ?? [];
}

async function run() {
  const supabase = getClient();
  console.log(`ELO scale health — ${new Date().toISOString()}\n`);

  let red = 0;

  for (const [view, description] of INVARIANTS) {
    const n = await countOf(supabase, view);
    if (n === 0) {
      console.log(`  OK    ${view}`);
      continue;
    }
    red++;
    console.log(`  RED   ${view}: ${n} row(s) — ${description}`);
    for (const row of await sample(supabase, view, '*')) {
      console.log(`          ${JSON.stringify(row)}`);
    }
  }

  for (const [view, description] of NOTICES) {
    const n = await countOf(supabase, view);
    if (n === 0) { console.log(`  OK    ${view}`); continue; }
    console.log(`  NOTE  ${view}: ${n} ${description}`);
    for (const row of await sample(supabase, view, 'league, new_since_fit, pct_new')) {
      console.log(`          ${JSON.stringify(row)}`);
    }
  }

  // Withheld forecasts. Not a defect — the visible form of a refusal. Printed
  // so the count is watched and a sudden jump is noticed.
  const { data: placement } = await supabase
    .from('fixture_placement')
    .select('status, basis')
    .lte('kickoff_at', new Date(Date.now() + 30 * 864e5).toISOString());
  if (placement?.length) {
    const tally = new Map();
    for (const r of placement) {
      const k = `${r.status}/${r.basis ?? '-'}`;
      tally.set(k, (tally.get(k) ?? 0) + 1);
    }
    const parts = [...tally].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`);
    console.log(`  INFO  fixture_placement (30d): ${parts.join(' ')}`);
    for (const row of await sample(supabase, 'fixture_placement', 'home_name, away_name, unplaced_reason', 5)) {
      if (row.unplaced_reason) {
        console.log(`          ${row.home_name} v ${row.away_name} — ${row.unplaced_reason}`);
      }
    }
  }

  console.log(red ? `\nRED: ${red} invariant(s) broken` : '\nAll invariants hold.');
  process.exitCode = red ? 1 : 0;
}

if (require.main === module) {
  run().catch(err => { console.error('fatal:', err.message); process.exit(1); });
}

module.exports = { INVARIANTS, NOTICES };
