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

module.exports = { getClient };
