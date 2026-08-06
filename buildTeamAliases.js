/**
 * buildTeamAliases.js — resolve every club name, from every source, to one key.
 *
 * §2.3 of the 2026-08-05 brief. See migrations/053_team_alias.sql for what this
 * writes and why it is not `fixture_mapping` (that table is an Odds API →
 * API-Football FIXTURE bridge; the brief describes something else).
 *
 * WHAT IT FIXES, measured against production on 2026-08-05:
 *
 *   • `match_results` holds 164 distinct team names, `teams` holds 134 for
 *     English competitions, and only 89 match exactly. Nothing can be joined
 *     across the corpus and the feed for the other 46%.
 *
 *   • AND the feed contradicts itself: `teams` holds 17 clubs TWICE, under two
 *     spellings each — Leeds / Leeds United, Hull / Hull City, Wolves /
 *     Wolverhampton Wanderers. `teams.name` is UNIQUE and planDay upserts on
 *     it, so those are separate rows with separate ids, and `mx_team_form`
 *     partitions each of those clubs into two rolling windows. The corners and
 *     cards models need 20 prior matches per team per venue; halving a club's
 *     history is often the difference between a prediction and silence.
 *
 * After mapping: 114 of 164 corpus names join the feed (70%), and the feed's
 * 134 English names resolve to 117 clubs.
 *
 * FULLY AUDITED across both sources on 2026-08-05 — 1,248 `teams` rows, 222 of
 * them PLACEHOLDERS (`team_home_1490361`, the E3 defect) which are excluded,
 * leaving 1,065 distinct clubs. 57 short names merge, 33 are refused.
 *
 * That audit found THREE FALSE MERGES in the matcher's first version, which
 * folded a short name into the one longer name that started with it:
 * AC Ajaccio into Ajaccio GFCO, Guinea into Guinea-Bissau, Virtus into Virtus
 * Entella. Merging and refusing now use different tests — see lib/teamNames.js.
 *
 * IT REPORTS WHAT IT WOULD NOT GUESS. `Oxford` is left unmapped because the
 * corpus carries both `Oxford City` and `Oxford` (i.e. Oxford United) and the
 * feed carries `Oxford United` — a short name that could be short for two
 * different clubs. Every such case is printed, so the ALIAS map in
 * lib/teamNames.js grows from evidence. A missed mapping leaves a club short of
 * history and it stays silent, which is correct behaviour. A false mapping
 * attributes one club's corners to another and every number downstream inherits
 * it without a trace.
 *
 * MANUAL ROWS ARE NEVER OVERWRITTEN. A row written with method='manual' is a
 * human decision and survives every re-run.
 *
 * Usage:
 *   node buildTeamAliases.js               # write
 *   node buildTeamAliases.js --dry-run     # report only
 *   node buildTeamAliases.js --floor 0.95  # tighten the fuzzy pass
 */
'use strict';

const { getClient } = require('./lib/supabaseClient');
const { buildCanonicalMap } = require('./lib/teamNames');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const flag = (n, fb) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : fb; };
const FLOOR = parseFloat(flag('--floor', '0.92'));
const PAGE = 1000;
const CHUNK = 500;

/** Every page of a select, so a name list is never silently capped at 1,000. */
async function selectAll(query, describe) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query().range(from, from + PAGE - 1);
    if (error) throw new Error(`${describe}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

/**
 * How a manual row is recognised. Case- and whitespace-insensitive, because
 * `mx_canonical_team()` matches on `lower(trim(raw_name))` — so a human who
 * typed "Man City" must shield the row the job would write as "man city".
 * Anything else lets the job silently overwrite a human decision.
 */
function manualKey(source, rawName) {
  return `${String(source ?? '').trim()}|${String(rawName ?? '').trim().toLowerCase()}`;
}

/**
 * The rows to upsert. Pure, so the two rules that matter can be tested without
 * a database: a manual row is never overwritten, and every row carries the
 * columns `team_alias` actually has.
 */
function planAliasWrites(aliases, manualKeys, stampedAt) {
  const shield = manualKeys instanceof Set ? manualKeys : new Set(manualKeys ?? []);
  return (aliases ?? [])
    .filter(a => a && a.source && a.name && a.canonical_key)
    .filter(a => !shield.has(manualKey(a.source, a.name)))
    .map(a => ({
      source:        a.source,
      raw_name:      a.name,
      canonical_key: a.canonical_key,
      method:        a.method === 'manual' ? 'exact' : a.method,
      updated_at:    stampedAt,
    }));
}

/**
 * Upsert in chunks, on the table's own primary key.
 *
 * `onConflict: 'source,raw_name'` must match the PRIMARY KEY in migration 053
 * exactly, or PostgREST returns a 42P10 and the whole run fails — which is the
 * good outcome. The bad one, before this was extracted and tested, was the
 * counter: it added `min(CHUNK, remaining)` per iteration whether or not the
 * upsert touched anything, so a partial write still reported a full one.
 * It now counts the rows the database says it wrote.
 */
async function writeAliases(supabase, rows, chunk = CHUNK) {
  let written = 0;
  for (let i = 0; i < (rows?.length ?? 0); i += chunk) {
    const batch = rows.slice(i, i + chunk);
    const { data, error } = await supabase
      .from('team_alias')
      .upsert(batch, { onConflict: 'source,raw_name' })
      .select('source');
    if (error) throw new Error(`teamAliases[upsert @${i}]: ${error.message}`);
    written += (data ?? []).length;
  }
  return written;
}

async function main() {
  const supabase = getClient();

  // ── The two name universes ───────────────────────────────────────────────
  const feedRows = await selectAll(
    () => supabase.from('teams').select('name'), 'teamAliases[teams]');
  const corpusRows = await selectAll(
    () => supabase.from('match_results').select('home_team, away_team'),
    'teamAliases[match_results]');

  const rows = [];
  const seen = new Set();
  const push = (source, name) => {
    const n = String(name ?? '').trim();
    if (!n) return;
    const k = `${source}|${n.toLowerCase()}`;
    if (seen.has(k)) return;
    seen.add(k);
    rows.push({ source, name: n });
  };
  for (const r of feedRows) push('live_feed', r.name);
  for (const r of corpusRows) { push('football_data', r.home_team); push('football_data', r.away_team); }

  const bySource = rows.reduce((m, r) => ((m[r.source] = (m[r.source] ?? 0) + 1), m), {});
  console.log(`[aliases] ${rows.length} distinct name(s): ` +
              Object.entries(bySource).map(([s, n]) => `${s} ${n}`).join(' · '));

  // ── Resolve ──────────────────────────────────────────────────────────────
  const { aliases, unmatched } = buildCanonicalMap(rows, { floor: FLOOR });

  const clubs = new Set(aliases.map(a => a.canonical_key));
  const sourcesByClub = new Map();
  for (const a of aliases) {
    if (!sourcesByClub.has(a.canonical_key)) sourcesByClub.set(a.canonical_key, new Set());
    sourcesByClub.get(a.canonical_key).add(a.source);
  }
  const joined = [...sourcesByClub.values()].filter(s => s.size > 1).length;

  const byMethod = aliases.reduce((m, a) => ((m[a.method] = (m[a.method] ?? 0) + 1), m), {});
  console.log(`[aliases] ${rows.length} name(s) → ${clubs.size} club(s) · ` +
              `${joined} club(s) known to more than one source`);
  console.log(`[aliases] by method: ` +
              Object.entries(byMethod).map(([k, n]) => `${k} ${n}`).join(' · '));

  // The collapses inside a single source are the live defect, so name them.
  const dupes = [];
  for (const [club, srcs] of sourcesByClub) {
    for (const src of srcs) {
      const names = aliases.filter(a => a.canonical_key === club && a.source === src).map(a => a.name);
      if (names.length > 1) dupes.push({ club, source: src, names });
    }
  }
  if (dupes.length) {
    console.log(`\n[aliases] ${dupes.length} club(s) held under MORE THAN ONE NAME within a single`);
    console.log(`          source — each of these was two rolling-form windows until now:`);
    for (const d of dupes.slice(0, 40)) {
      console.log(`          ${d.source.padEnd(14)} ${d.club.padEnd(26)} ${d.names.join(' / ')}`);
    }
    if (dupes.length > 40) console.log(`          … and ${dupes.length - 40} more`);
  }

  // ── What it refused ──────────────────────────────────────────────────────
  const ambiguous = unmatched.filter(u => String(u.reason).startsWith('ambiguous'));
  if (ambiguous.length) {
    console.log(`\n[aliases] REFUSED as ambiguous — these need an ALIAS entry, not a guess:`);
    for (const u of [...new Map(ambiguous.map(a => [a.key, a])).values()]) {
      console.log(`          ${u.key.padEnd(26)} ${u.reason}`);
    }
  }
  const orphans = unmatched.filter(u => !String(u.reason).startsWith('ambiguous'));
  console.log(`\n[aliases] ${orphans.length} name(s) known to one source only. Most are real — a`);
  console.log(`          non-league club the feed does not cover is not a mapping failure.`);
  for (const u of orphans.slice(0, 25)) {
    console.log(`          ${u.source.padEnd(14)} ${u.name.padEnd(26)} ${u.reason}`);
  }
  if (orphans.length > 25) console.log(`          … and ${orphans.length - 25} more`);

  if (DRY) {
    console.log(`\n[aliases] --dry-run: nothing written.`);
    return;
  }

  // ── Write, preserving human decisions ────────────────────────────────────
  const manual = await selectAll(
    () => supabase.from('team_alias').select('source, raw_name').eq('method', 'manual'),
    'teamAliases[manual]');
  const manualKeys = new Set(manual.map(m => manualKey(m.source, m.raw_name)));
  if (manualKeys.size) {
    console.log(`\n[aliases] preserving ${manualKeys.size} manual row(s) — a human decided those.`);
  }

  const toWrite = planAliasWrites(aliases, manualKeys, new Date().toISOString());
  const written = await writeAliases(supabase, toWrite);
  console.log(`\n[aliases] wrote ${written} row(s) to team_alias.`);
  console.log(`[aliases] next: select * from public.mx_refresh_team_match();`);
  console.log(`          refresh materialized view public.mx_team_form;`);
  console.log(`          select * from public.mx_coverage;`);
}

if (require.main === module) {
  main().catch(err => { console.error('[aliases] FATAL:', err.message); process.exit(1); });
}

module.exports = { main, planAliasWrites, writeAliases, manualKey };
