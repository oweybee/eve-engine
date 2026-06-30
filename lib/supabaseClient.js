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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Transient failures worth retrying: network blips, timeouts, and the
// upstream 429/5xx responses Supabase surfaces. Deterministic failures
// (constraint violations, auth errors, bad SQL) are NOT retried — re-running
// them just delays the inevitable, so they propagate immediately.
const TRANSIENT_RE =
  /(fetch failed|network|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|timeout|timed out|\b(429|502|503|504)\b|too many requests|service unavailable|gateway)/i;

function isTransient(err) {
  return err != null && TRANSIENT_RE.test(err.message || String(err));
}

/**
 * Runs an async DB operation, retrying only on transient errors with
 * exponential backoff (default 4 attempts: ~1s, 2s, 4s between tries).
 * A momentary network blip during a critical write no longer crashes the run.
 *
 * @template T
 * @param {() => Promise<T>} fn      The operation to run.
 * @param {string}          label    Short name for logging.
 * @param {{ attempts?: number, baseDelayMs?: number }} [opts]
 * @returns {Promise<T>}
 */
async function withRetry(fn, label, opts = {}) {
  const attempts = opts.attempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 1000;

  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !isTransient(err)) throw err;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      console.warn(
        `[retry] ${label} → ${err.message} — attempt ${attempt}/${attempts - 1} failed, retrying in ${delay}ms`,
      );
      await sleep(delay);
    }
  }
  throw lastErr; // unreachable, satisfies the type checker
}

module.exports = { getClient, withRetry };
