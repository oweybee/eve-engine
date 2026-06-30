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
// corners, cards → "awaiting prices"). Page past the cap so every match sees
// its full odds set. Mirrors the pagination already used in computeElo.js.
const ODDS_PAGE_SIZE = 1000;

/**
 * Fetch ALL odds rows for the given match IDs, paging past PostgREST's
 * default 1000-row response cap.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string[]} matchIds
 * @param {string} [columns] — explicit select list for the odds rows.
 * @returns {Promise<Array<object>>}
 */
async function fetchOddsForMatches(supabase, matchIds, columns = '*') {
  if (!matchIds?.length) return [];
  const all = [];
  for (let from = 0; ; from += ODDS_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('odds')
      .select(columns)
      .in('match_id', matchIds)
      // Stable ordering is REQUIRED for correct pagination — without it
      // PostgREST may repeat or skip rows across pages.
      .order('id', { ascending: true })
      .range(from, from + ODDS_PAGE_SIZE - 1);
    if (error) throw new Error(`fetchOddsForMatches: ${error.message}`);
    const page = data ?? [];
    all.push(...page);
    if (page.length < ODDS_PAGE_SIZE) break;
  }
  return all;
}

module.exports = { getClient, fetchOddsForMatches };
