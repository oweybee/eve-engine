/**
 * lib/teamNames.js — one club, one key, across every source.
 *
 * WHAT THIS FIXES, AND IT IS BIGGER THAN THE BRIEF SAID
 *
 * §2.3 asks for a mapping from football-data team names to feed names, because
 * the two spell clubs differently — "Man City" against "Manchester City". True,
 * and measured against production on 2026-08-05: 164 distinct names in
 * `match_results`, 134 in `teams` for English competitions, and only 89 match
 * exactly. Without a mapping, nothing can be joined across the two sources.
 *
 * But the audit of those two lists turned up a second problem that is worse,
 * because it needs no second source to bite. THE FEED'S OWN `teams` TABLE HOLDS
 * THE SAME CLUB TWICE, under two spellings:
 *
 *     Leeds / Leeds United          Hull / Hull City
 *     Derby / Derby County          Ipswich / Ipswich Town
 *     Bolton / Bolton Wanderers     Newcastle / Newcastle United
 *     Wolves / Wolverhampton Wanderers, and a dozen more
 *
 * `teams.name` is UNIQUE and planDay upserts on it, so each spelling is a
 * SEPARATE ROW WITH A SEPARATE ID, and a club's fixtures are split across two
 * of them. Migration 051's `mx_team_form` partitions by `lower(trim(name))`, so
 * that club gets two rolling windows instead of one — and since the corners and
 * cards models require 20 prior matches per team per venue, splitting a club in
 * half is often the difference between a prediction and silence. The mapping is
 * therefore many-to-one WITHIN a source as well as across sources.
 *
 * WHY A TABLE AND NOT A FUNCTION EVERYONE CALLS
 * `ensemble/scrapers/names.py` already implements this idea in Python for the
 * research corpus. Reimplementing it here in JavaScript would give two matchers
 * that must agree forever and will not — the same class of failure as three
 * copies of a publication rule. So this module runs ONCE, writes its answer to
 * `team_alias`, and everything else reads the table. The two implementations
 * never have to agree because only one of them decides.
 *
 * IT REFUSES RATHER THAN GUESSES
 * `bestMatch` returns null below the similarity floor, and the job reports every
 * unmatched name instead of forcing a join. A wrong mapping is worse than a
 * missing one: a missing mapping leaves a club short of history and it stays
 * silent, which is the correct behaviour; a wrong mapping silently attributes
 * one club's corners to another and every downstream number inherits it.
 */
'use strict';

// Common club-name noise, stripped before comparison. Mirrors the list in
// ensemble/scrapers/names.py so the two at least SEE names the same way, even
// though only this one decides.
const SUFFIXES = new Set([
  'fc', 'afc', 'cf', 'sc', 'ac', 'as', 'ss', 'ssd', 'ssc', 'us', 'ud', 'cd',
  'sv', 'vfb', 'vfl', 'tsv', 'fsv', 'bsc', 'rc', 'sd', 'if', 'bk', 'ff', 'aik',
  'calcio', 'club', 'the',
]);

/**
 * NO LIST OF "WORDS THAT MEAN NOTHING" — THE DATA DECIDES.
 *
 * The first version of this file dropped a fixed set of generic words —
 * united, city, athletic, wanderers — so that "Leeds" and "Leeds United"
 * collapsed to one club. Measured against the real name lists it worked for 15
 * clubs and then produced a FALSE match: football-data carries both `Oxford`
 * (i.e. Oxford United) and `Oxford City`, which are two different clubs, and
 * dropping "City" merged them. One club's corners would have been attributed to
 * another, invisibly, forever.
 *
 * So there is no such list. A short name is merged into a longer one only when
 * the longer one is the ONLY name it could be short for, across the union of
 * every name from every source. "Harrogate" merges into "Harrogate Town"
 * because nothing else begins with Harrogate. "Oxford" merges into nothing,
 * because both "Oxford City" and "Oxford United" begin with it — so it is
 * reported as ambiguous and waits for a human to put it in ALIAS.
 *
 * That is the asymmetry the whole audit is about, applied to names: a missed
 * match leaves a club short of history and it stays silent, which is correct.
 * A false match is silent and wrong.
 */

/**
 * Names that are not clubs.
 *
 * `teams` holds 222 rows named `team_home_1490361` / `team_away_1490361` — 18%
 * of the table. planDay mints one whenever a fixture arrives without a resolvable
 * team name (`home_${fixtureId}`), and they are the E3 placeholder defect the
 * blueprint's engine work order already lists. They must never be aliased: each
 * is unique, so each would become its own "club", and a fuzzy pass would happily
 * score `team_home_1490361` against `team_home_1490362` at 0.94 and merge two
 * unrelated fixtures into one team's history.
 */
const PLACEHOLDER = /^team_(home|away)_\d+$/i;

/** True when a name is a planDay placeholder rather than a club. */
function isPlaceholder(name) {
  return PLACEHOLDER.test(String(name ?? '').trim());
}

function stripAccents(s) {
  return String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

/**
 * Canonical comparison key, before aliasing. Lowercase, accent-free,
 * punctuation-free, with the generic suffixes and distinguishing-nothing words
 * removed and the remainder concatenated.
 */
function tokens(name) {
  if (name == null) return [];
  let s = stripAccents(name).toLowerCase().replace(/&/g, ' and ');
  s = s.replace(/[^a-z0-9 ]+/g, ' ');
  let toks = s.split(/\s+/).filter(Boolean);
  // Corporate noise only — never a word that could distinguish two clubs.
  toks = toks.filter(t => !SUFFIXES.has(t));
  if (toks[0] === '1') toks = toks.slice(1);
  return toks;
}

/** Canonical comparison key: every meaningful token, in order, concatenated. */
function normalize(name) {
  return tokens(name).join('');
}

/**
 * Curated overrides, raw-lowercased name → canonical key. Only for names the
 * normaliser cannot reach: abbreviations, possessives and nicknames. Every
 * entry here is a claim that two names are the same club, so grow it from the
 * job's unmatched report rather than from memory.
 */
const ALIAS = {
  // Abbreviations the token rules cannot reach — "Man City" shares no token
  // with "Manchester City", so no amount of prefixing or fuzzing finds it.
  'man city':       'manchestercity',
  'man united':     'manchesterunited',
  'man utd':        'manchesterunited',
  'sheffield weds': 'sheffieldwednesday',
  'bristol rvs':    'bristolrovers',
  'peterboro':      'peterborough',
  'accrington':     'accringtonst',
  'accrington st':  'accringtonst',
  "nott'm forest": 'nottinghamforest',
  'nottm forest': 'nottinghamforest',
  'west brom': 'westbromwich',
  'west bromwich albion': 'westbromwich',
  'spurs': 'tottenham',
  'qpr': 'queensparkrangers',
  'wolves': 'wolverhampton',
  'dag and red': 'dagenhamandredbridge',
  'peterboro': 'peterborough',
  'rushden & d': 'rushdenanddiamonds',
  'sutton': 'sutton',
  'sutton utd': 'sutton',
  'telford united': 'telford',
  'afc telford united': 'telford',
  'boston utd': 'boston',
  'boston united': 'boston',
  'fylde': 'fylde',
  'afc fylde': 'fylde',
  'halifax': 'halifax',
  'fc halifax town': 'halifax',
  'kings lynn': 'kingslynn',
  'milton keynes dons': 'mkdons',
  'wimbledon': 'wimbledon',
  'afc wimbledon': 'afcwimbledon',
};

/** Alias-aware canonical key for one raw name. */
function canonicalKey(name) {
  const raw = String(name ?? '').trim().toLowerCase();
  if (!raw) return '';
  if (ALIAS[raw]) return ALIAS[raw];
  const n = normalize(name);
  return ALIAS[n] ?? n;
}

/**
 * Similarity in [0, 1].
 *
 * Levenshtein-based rather than Python's SequenceMatcher, and deliberately not
 * claimed to be identical to it: this module writes the answer to a table and
 * `names.py` does not, so the two never have to agree on a borderline pair.
 * Pretending to parity we had not verified would be its own small version of
 * naming a column after something it is not.
 */
function similarity(a, b) {
  const s = String(a ?? ''), t = String(b ?? '');
  if (!s.length && !t.length) return 1;
  if (!s.length || !t.length) return 0;
  if (s === t) return 1;
  const prev = new Array(t.length + 1);
  const cur = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= t.length; j++) prev[j] = cur[j];
  }
  return 1 - prev[t.length] / Math.max(s.length, t.length);
}

/**
 * Best fuzzy match among candidates, or null below the floor.
 *
 * The floor is high on purpose. A missed match leaves a club short of history
 * and therefore silent, which is the behaviour the whole audit argues for. A
 * false match attributes one club's corners to another and every number
 * downstream inherits it without a trace.
 *
 * @returns {{match: string|null, score: number}}
 */
function bestMatch(name, candidates, floor = 0.92) {
  const k = canonicalKey(name);
  let best = null, bestScore = 0;
  for (const c of candidates ?? []) {
    const s = similarity(k, canonicalKey(c));
    if (s > bestScore) { best = c; bestScore = s; }
  }
  return bestScore >= floor ? { match: best, score: bestScore } : { match: null, score: bestScore };
}

/**
 * Cluster every raw name from every source into canonical clubs.
 *
 * Three passes, each refusing where it cannot be sure:
 *
 *  1. EXACT canonical key. "Sheffield Utd" and "Sheffield United" both reduce
 *     to `sheffieldunited`, so they are one club with no judgement required.
 *  2. UNAMBIGUOUS PREFIX. A short name folds into a longer one only when
 *     exactly one longer name begins with its tokens. "Harrogate" folds into
 *     "Harrogate Town"; "Oxford" folds into nothing, because "Oxford City" and
 *     "Oxford United" both begin with it and picking one would be a guess.
 *  3. FUZZY, at a high floor, for what is left — typos and transliterations,
 *     not abbreviations.
 *
 * Everything unresolved comes back in `unmatched` with the reason, so the ALIAS
 * map is grown from evidence rather than from memory.
 *
 * @param {{source: string, name: string}[]} rows
 * @param {{floor?: number}} [opts]
 */
function buildCanonicalMap(rows, { floor = 0.92 } = {}) {
  const cleaned = (rows ?? [])
    .map(r => ({ source: String(r.source ?? ''), name: String(r.name ?? '').trim() }))
    .filter(r => r.name && r.source && !isPlaceholder(r.name));

  // ── Pass 1: exact canonical key ──────────────────────────────────────────
  const membersByKey = new Map();
  const tokensByKey = new Map();
  for (const r of cleaned) {
    const k = canonicalKey(r.name);
    if (!k) continue;
    if (!membersByKey.has(k)) {
      membersByKey.set(k, []);
      tokensByKey.set(k, ALIAS[r.name.toLowerCase()] ? [k] : tokens(r.name));
    }
    membersByKey.get(k).push(r);
  }

  // Where each key ends up. Starts as itself; passes 2 and 3 may redirect it.
  const resolvesTo = new Map([...membersByKey.keys()].map(k => [k, k]));
  const reasonByKey = new Map();
  const follow = (k) => {
    let cur = k, hops = 0;
    while (resolvesTo.get(cur) !== cur && hops++ < 8) cur = resolvesTo.get(cur);
    return cur;
  };

  const allKeys = [...membersByKey.keys()];

  // ── Pass 2: unambiguous prefix ───────────────────────────────────────────
  // A key is a candidate to be folded when its tokens are a strict prefix of
  // exactly ONE other key's tokens. Two candidates means the short name is
  // ambiguous and must not be resolved by this code.
  // MERGE on a token PREFIX. Refuse on token CONTAINMENT anywhere. The two
  // tests are deliberately different, and it took a false merge in production
  // data to work out why neither alone is enough:
  //
  //   PREFIX ALONE merged AC Ajaccio into Ajaccio GFCO. "AC Ajaccio" loses its
  //   corporate "AC" and becomes `ajaccio`; the only key STARTING with it is
  //   `ajacciogfco`, so the rule saw exactly one candidate and folded. It could
  //   not see `gazelecajaccio`, which is the same club as Ajaccio GFCO under
  //   another name, because the shared token is not at the front. Two different
  //   Corsican clubs, merged.
  //
  //   CONTAINMENT ALONE is worse. `milan` (from "AC Milan") is contained in
  //   `intermilan`, and nothing else, so it would fold AC Milan into Inter
  //   Milan — the two clubs that share a stadium and nothing else.
  //
  // So: a short key may only fold into a longer one that it PREFIXES, and only
  // when no OTHER key contains its tokens at all. Ajaccio is contained by two
  // keys, so it is refused. Milan prefixes nothing, so it never moves. Leeds
  // prefixes exactly one key and is contained by exactly that one, so it folds.
  const isPrefix = (short, long) =>
    short.length < long.length && short.every((t, i) => t === long[i]);
  const contains = (short, long) =>
    short.length < long.length && short.every(t => long.includes(t));

  const ambiguous = new Set();
  for (const k of allKeys) {
    const kt = tokensByKey.get(k) ?? [];
    if (!kt.length) continue;
    const prefixed  = allKeys.filter(o => o !== k && isPrefix(kt, tokensByKey.get(o) ?? []));
    const contained = allKeys.filter(o => o !== k && contains(kt, tokensByKey.get(o) ?? []));
    if (prefixed.length === 1 && contained.length === 1) {
      resolvesTo.set(k, prefixed[0]);
      reasonByKey.set(k, 'prefix');
    } else if (prefixed.length + contained.length > 0) {
      ambiguous.add(k);
      reasonByKey.set(k,
        `ambiguous: prefixes ${prefixed.length}, contained by ${contained.length} — ` +
        `${[...new Set([...prefixed, ...contained])].join(', ')}`);
    }
  }

  // ── Pass 3: fuzzy, only for keys still standing alone in one source ──────
  const sourcesOf = (k) => new Set(
    allKeys.filter(o => follow(o) === k).flatMap(o => membersByKey.get(o).map(m => m.source)));

  const settled = allKeys.filter(k => follow(k) === k && sourcesOf(k).size > 1);
  const solo = allKeys.filter(k => follow(k) === k && sourcesOf(k).size <= 1 && !ambiguous.has(k));

  for (const k of solo) {
    let best = null, bestScore = 0;
    for (const other of [...settled, ...solo]) {
      if (other === k) continue;
      const sc = similarity(k, other);
      if (sc > bestScore) { best = other; bestScore = sc; }
    }
    if (best && bestScore >= floor) {
      resolvesTo.set(k, best);
      reasonByKey.set(k, `fuzzy ${bestScore.toFixed(3)}`);
    } else {
      reasonByKey.set(k, `no match (best ${bestScore.toFixed(3)})`);
    }
  }

  // ── Emit ─────────────────────────────────────────────────────────────────
  const aliases = [];
  const unmatched = [];
  for (const k of allKeys) {
    const canonical = follow(k);
    const method = canonical === k ? 'exact' : (reasonByKey.get(k) ?? 'exact').split(' ')[0];
    const joined = sourcesOf(canonical).size > 1;
    for (const m of membersByKey.get(k)) {
      aliases.push({ source: m.source, name: m.name, canonical_key: canonical, method });
      if (!joined) {
        unmatched.push({ source: m.source, name: m.name, key: k,
                         reason: reasonByKey.get(k) ?? 'only source with this club' });
      }
    }
  }
  return { aliases, unmatched };
}

module.exports = {
  stripAccents, tokens, normalize, canonicalKey, similarity, bestMatch, isPlaceholder,
  buildCanonicalMap, ALIAS, SUFFIXES,
};
