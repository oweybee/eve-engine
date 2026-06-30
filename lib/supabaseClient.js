'use strict';

/**
 * Singleton Supabase client.
 *
 * All engine scripts import from here rather than calling createClient()
 * directly, so a single connection is reused across the process lifetime.
 * Module-level caching means this is effectively a singleton within a
 * single Node.js process even if getClient() is called multiple times.
 */

const { createClient } = require('@supabase/supabase-js');

/** @type {import('@supabase/supabase-js').SupabaseClient | null} */
let _client = null;

/**
 * Returns the shared Supabase client. Throws immediately if the required
 * environment variables are absent so misconfigured runs fail fast at startup,
 * not mid-run.
 *
 * @returns {import('@supabase/supabase-js').SupabaseClient}
 */
function getClient() {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error('Missing env var: SUPABASE_URL');
  if (!key) throw new Error('Missing env var: SUPABASE_SERVICE_ROLE_KEY');

  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return _client;
}

// PostgREST hard-caps a single response at 1000 rows. A plain
// `.from('odds').in('match_id', ids)` therefore returns only the first 1000
// odds rows across ALL requested matches — silently dropping matches whose
// rows fall beyond the cap (no odds → not computed → stale computed_values)
// and starving others of their newer secondary-market rows (O/U, BTTS,
// corners, cards → "awaiting prices"). EVERY multi-match read of a high-volume
// table (odds, odds_snapshots) MUST page past the cap. Use fetchAllPaged below
// rather than re-deriving the loop. Mirrors the pagination in computeElo.js.
const PAGE_SIZE = 1000;

/**
 * Run a paged query past PostgREST's 1000-row response cap and concatenate
 * every page. The caller supplies a builder that returns a fresh query for a
 * given [from,to] window — it MUST include a stable `.order()` (e.g. by `id`,
 * or by a sort column with `id` as a tiebreaker) or PostgREST may repeat/skip
 * rows across pages.
 *
 * @param {(from:number, to:number) => PromiseLike<{data:any[]|null, error:any}>} buildPage
 * @param {string} [label] — context for error messages.
 * @returns {Promise<Array<object>>}
 */
async function fetchAllPaged(buildPage, label = 'fetchAllPaged') {
  const all = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await buildPage(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    const page = data ?? [];
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return all;
}

/**
 * Fetch ALL odds rows for the given match IDs, paging past the 1000-row cap.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string[]} matchIds
 * @param {string} [columns] — explicit select list for the odds rows.
 * @returns {Promise<Array<object>>}
 */
function fetchOddsForMatches(supabase, matchIds, columns = '*') {
  if (!matchIds?.length) return Promise.resolve([]);
  return fetchAllPaged((from, to) =>
    supabase
      .from('odds')
      .select(columns)
      .in('match_id', matchIds)
      .order('id', { ascending: true })
      .range(from, to),
  'fetchOddsForMatches');
}

module.exports = { getClient, fetchAllPaged, fetchOddsForMatches, PAGE_SIZE };
