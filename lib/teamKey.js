'use strict';

/**
 * lib/teamKey.js — the ONE normalisation that decides whether two team rows are
 * the same club.
 *
 * WHY THIS FILE EXISTS. The key was `s.toLowerCase().replace(/[^a-z0-9]/g,'')`,
 * copied into computeElo.js, computeValues.js and the stats lookups. It strips
 * any character outside a-z0-9, and an accented letter is outside a-z — so
 * "Bayern München" keys as `bayernmnchen` while "Bayern Munich" keys as
 * `bayernmunich`, and the ladder built two ratings for one club. Measured on
 * 19 Aug 2026 that split TWENTY clubs across two rows apiece, including
 * Atlético Madrid (1,040 appearances), Saint-Étienne (893) and Borussia
 * Mönchengladbach (174).
 *
 * TRANSLITERATE, DO NOT DELETE. `ö` becomes `o`, not nothing. That is a RULE,
 * so it fixes every accent pair at once and cannot go stale the way a list of
 * known aliases does. The list that remains — `team_aliases` in migration 076 —
 * is only for the pairs no rule could ever join: "Wolves" and "Wolverhampton
 * Wanderers" are the same club and no amount of character folding says so.
 *
 * Keep this in step with migration 076's `elo_corpus` view, which applies the
 * same folding in SQL. A key computed two ways is two keys.
 */

// Latin-1/Latin-2 letters that appear in the feeds' team names, mapped to the
// ASCII letter they are. Digraphs (ß, æ, œ) expand and so cannot live in a
// character-for-character table.
const FOLD = {
  à:'a', á:'a', â:'a', ã:'a', ä:'a', å:'a', ā:'a', ă:'a', ą:'a',
  è:'e', é:'e', ê:'e', ë:'e', ē:'e', ĕ:'e', ė:'e', ę:'e', ě:'e',
  ì:'i', í:'i', î:'i', ï:'i', ī:'i', į:'i', ı:'i',
  ò:'o', ó:'o', ô:'o', õ:'o', ö:'o', ø:'o', ō:'o', ő:'o',
  ù:'u', ú:'u', û:'u', ü:'u', ū:'u', ů:'u', ű:'u',
  ý:'y', ÿ:'y',
  ñ:'n', ń:'n', ň:'n',
  ç:'c', ć:'c', č:'c',
  š:'s', ś:'s', ş:'s',
  ž:'z', ź:'z', ż:'z',
  ď:'d', đ:'d', ð:'d',
  ğ:'g', ģ:'g',
  ķ:'k', ļ:'l', ł:'l',
  ř:'r', ŕ:'r',
  ť:'t', ţ:'t',
  þ:'t',
};
const EXPAND = { ß:'ss', æ:'ae', œ:'oe' };

/**
 * The ladder key for a team name.
 *
 * Lower-cases, folds accents to ASCII, expands digraphs, then drops everything
 * that is not a-z0-9. Returns '' for a missing name — callers must treat '' as
 * "no team", never as a key.
 *
 * @param {string|null|undefined} name
 * @returns {string}
 */
function teamKey(name) {
  const s = (name ?? '').toString().toLowerCase();
  let out = '';
  for (const ch of s) {
    if (ch >= 'a' && ch <= 'z') { out += ch; continue; }
    if (ch >= '0' && ch <= '9') { out += ch; continue; }
    const e = EXPAND[ch];
    if (e) { out += e; continue; }
    const f = FOLD[ch];
    if (f) { out += f; continue; }
    // Anything else (punctuation, spaces, scripts we do not fold) is dropped —
    // the same behaviour the old key had for everything.
  }
  return out;
}

/**
 * A resolver that turns a RAW FEED NAME into the canonical club key that
 * `team_elo` is keyed by — the same answer the SQL view `team_key_map` gives.
 *
 * WHY A LOADER AND NOT JUST teamKey(). Folding accents by rule joins
 * "Atlético Madrid" to "Atletico Madrid", but no rule joins "Wolves" to
 * "Wolverhampton Wanderers" or "Tottenham" to "Tottenham Hotspur". Those live
 * in `team_alias`, so a caller that only folds will miss them — and it will
 * miss them SILENTLY, as a lookup that returns undefined.
 *
 * That is not hypothetical. `computeElo` writes the canonical key, so the
 * moment it started reading `elo_corpus` every accented and aliased club in
 * `team_elo` stopped matching the raw name its readers looked up with. This
 * function is what keeps the writer and the readers on one key.
 *
 * Fails OPEN to the fold: if `team_alias` cannot be read, names still resolve
 * by rule, which is strictly better than resolving to nothing. It says so in
 * the log rather than degrading quietly.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{source?: string}} [opts]
 * @returns {Promise<(name: string) => string>}
 */
async function loadTeamKeyResolver(supabase, { source = 'live_feed' } = {}) {
  const alias = new Map();
  const { data, error } = await supabase
    .from('team_alias').select('raw_name, canonical_key').eq('source', source);
  if (error) {
    console.warn(`[teamKey] team_alias read failed (${error.message}) — `
      + 'falling back to accent folding alone; aliased clubs will not resolve');
  } else {
    for (const r of data ?? []) {
      if (r.raw_name && r.canonical_key) alias.set(r.raw_name, r.canonical_key);
    }
  }
  return (name) => alias.get(name) ?? teamKey(name);
}

// ---------------------------------------------------------------------------
// The shared instance
// ---------------------------------------------------------------------------
// ONE resolver per process, because the modules that need it share functions
// across files: computeInplayValues imports fetchStatsLookups FROM
// computeValues, so a resolver held as module state in each would leave one of
// them keying with the other's. That is the same class of bug as two copies of
// a normalisation — it just hides one import deeper.

let shared = null;
let warned = false;

/** Load the alias table once and install it as the process-wide resolver. */
async function initTeamKeyResolver(supabase, opts) {
  shared = await loadTeamKeyResolver(supabase, opts);
  return shared;
}

/**
 * The canonical club key for a raw feed name.
 *
 * Falls back to accent folding alone if nobody has initialised it, and SAYS SO
 * once — a caller that forgot would otherwise miss every aliased club with a
 * lookup that returns undefined rather than throwing.
 */
function resolveTeamKey(name) {
  if (shared) return shared(name);
  if (!warned) {
    warned = true;
    console.warn('[teamKey] resolveTeamKey used before initTeamKeyResolver — '
      + 'accent folding only, aliased clubs will not resolve');
  }
  return teamKey(name);
}

/** Testing seam: install a resolver directly, or clear it with null. */
function setTeamKeyResolver(fn) { shared = fn; warned = false; }

module.exports = {
  teamKey, loadTeamKeyResolver, initTeamKeyResolver, resolveTeamKey, setTeamKeyResolver,
  FOLD, EXPAND,
};
