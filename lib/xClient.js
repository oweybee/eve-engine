'use strict';

/**
 * lib/xClient — the X transport, and nothing else.
 *
 * It knows how to sign a request and how to tell two kinds of failure apart.
 * It knows nothing about signals, bands, compliance or what may be posted;
 * those live in xCompose, xGuard and lib/publication, and keeping them out of
 * here is what stops this file growing a second opinion about what to post.
 *
 * ── THE ONE DISTINCTION THAT MATTERS ────────────────────────────────────────
 *
 * The Telegram adapter's release rule is narrower than "on any error" on
 * purpose, and the same reasoning applies here without change:
 *
 *   A REJECTION — a well-formed HTTP answer carrying an error (400, 401, 403,
 *   429) — is PROOF nothing was posted. `xRejected` is set, the caller
 *   releases the claim, and the signal is reconsidered next run.
 *
 *   A TRANSPORT FAILURE — a timeout, a dropped socket, an unparseable body —
 *   is proof of NOTHING. The post may have landed and only the answer was
 *   lost. `xRejected` is NOT set, the claim stands, and the signal is never
 *   reconsidered. One withheld post is a smaller harm than one duplicate post
 *   on a channel whose readers cannot tell them apart, and duplicates are the
 *   exact thing X's automation rules action accounts for.
 *
 * ── OAUTH 1.0a, NOT A BEARER TOKEN ──────────────────────────────────────────
 *
 * Posting is a user-context action: an app-only bearer token can read and
 * cannot write. The signature base string carries only the oauth_* parameters
 * because the payload is JSON — X excludes a non-form body from the base
 * string, and including it produces a 401 that looks exactly like a bad key.
 *
 * CREDENTIALS ARE READ FROM THE ENVIRONMENT AND NEVER LOGGED. Four values are
 * needed and all four are secrets: they belong in the workflow's secret store
 * beside SUPABASE_SERVICE_ROLE_KEY, not in a file in this repo.
 */

const https = require('https');
const crypto = require('crypto');

const ENDPOINT = 'https://api.x.com/2/tweets';
const TIMEOUT_MS = 15_000;

/** RFC 3986, which is stricter than encodeURIComponent about these four. */
function pct(v) {
  return encodeURIComponent(String(v))
    .replace(/[!*()']/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
}

function getXConfig(env = process.env) {
  const cfg = {
    consumerKey:    env.X_API_KEY,
    consumerSecret: env.X_API_SECRET,
    token:          env.X_ACCESS_TOKEN,
    tokenSecret:    env.X_ACCESS_TOKEN_SECRET,
  };
  const missing = Object.entries(cfg).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    // Names only. Never the values, and never a prefix of them.
    throw new Error(`Missing X credentials: ${missing.join(', ')}`);
  }
  return cfg;
}

/** The OAuth 1.0a Authorization header for a JSON POST to `url`. */
function authHeader(cfg, url, { nonce, timestamp } = {}) {
  const oauth = {
    oauth_consumer_key: cfg.consumerKey,
    oauth_nonce: nonce ?? crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_token: cfg.token,
    oauth_version: '1.0',
  };

  const params = Object.keys(oauth).sort().map(k => `${pct(k)}=${pct(oauth[k])}`).join('&');
  const base = ['POST', pct(url), pct(params)].join('&');
  const key = `${pct(cfg.consumerSecret)}&${pct(cfg.tokenSecret)}`;
  oauth.oauth_signature = crypto.createHmac('sha1', key).update(base).digest('base64');

  return 'OAuth ' + Object.keys(oauth).sort()
    .map(k => `${pct(k)}="${pct(oauth[k])}"`).join(', ');
}

/**
 * Post one item. Resolves `{ message_id }` so the caller's `confirmPost` takes
 * it unchanged, the same shape the Telegram adapter returns.
 */
function postTweet(text, { cfg = getXConfig(), endpoint = ENDPOINT, request = https.request } = {}) {
  const payload = JSON.stringify({ text });

  return new Promise((resolve, reject) => {
    const req = request(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': authHeader(cfg, endpoint),
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => {
        let body;
        try { body = JSON.parse(raw); }
        catch {
          // An unparseable body is NOT proof of rejection. See the header.
          return reject(new Error(`X: unreadable response (HTTP ${res.statusCode})`));
        }
        if (res.statusCode >= 200 && res.statusCode < 300 && body?.data?.id) {
          return resolve({ message_id: body.data.id });
        }
        const detail = body?.detail || body?.title || body?.errors?.[0]?.message || `HTTP ${res.statusCode}`;
        const err = new Error(`X rejected the post: ${detail}`);
        err.xRejected = true;        // a well-formed refusal: nothing was sent
        err.status = res.statusCode;
        reject(err);
      });
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('X timeout')));
    req.on('error', reject);        // transport: proof of nothing
    req.write(payload);
    req.end();
  });
}

module.exports = { postTweet, authHeader, getXConfig, pct, ENDPOINT };
