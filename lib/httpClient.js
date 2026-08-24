'use strict';

/**
 * Shared HTTP client for all engine scripts.
 *
 * Replaces four divergent copy-paste httpGet/httpPost implementations across
 * planDay.js, ingestOdds.js, gradeResults.js, and betfairIngest.js — each
 * with no retry, no timeout, and 429 → immediate crash semantics.
 *
 * Guarantees:
 *  - Exponential backoff with jitter on 429 / 5xx / network errors
 *  - Retry-After header respected (both seconds and HTTP-date formats)
 *  - Hard 30-second socket timeout (prevents GitHub Actions job hangs)
 *  - Typed error classes so callers can distinguish retryable from fatal
 *  - Never swallows errors silently
 */

const https = require('https');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_RETRY_CONFIG = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  jitterMs: 200,
  socketTimeoutMs: 30_000,
};

// HTTP status codes worth retrying. 429 = rate-limited, 5xx = server error.
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {boolean} retryable
   */
  constructor(status, message, retryable) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.retryable = retryable;
  }
}

class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParseError';
    this.retryable = false;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse a Retry-After header value into milliseconds.
 * The header can be either a number of seconds or an HTTP-date string.
 * Returns null if the header is absent or unparseable.
 *
 * @param {string|undefined} headerValue
 * @returns {number|null}
 */
function parseRetryAfterMs(headerValue) {
  if (!headerValue) return null;

  // Numeric seconds (may be a float per RFC 7231)
  const seconds = parseFloat(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }

  // HTTP-date: "Mon, 23 Jun 2026 05:00:00 GMT"
  const date = new Date(headerValue);
  if (!Number.isNaN(date.getTime())) {
    const waitMs = date.getTime() - Date.now();
    return waitMs > 0 ? waitMs : 0;
  }

  return null;
}

/**
 * Compute how long to wait before the next attempt.
 * Retry-After always wins if present; otherwise exponential backoff + jitter.
 *
 * @param {number} attempt - zero-indexed attempt number that just failed
 * @param {string|undefined} retryAfterHeader
 * @param {typeof DEFAULT_RETRY_CONFIG} config
 * @returns {number} milliseconds to wait
 */
function waitMs(attempt, retryAfterHeader, config) {
  const retryAfter = parseRetryAfterMs(retryAfterHeader);
  if (retryAfter !== null) return Math.min(retryAfter, config.maxDelayMs);

  const base = Math.min(
    config.baseDelayMs * Math.pow(2, attempt),
    config.maxDelayMs,
  );
  const jitter = Math.random() * config.jitterMs;
  return Math.floor(base + jitter);
}

/**
 * Sleep for `ms` milliseconds.
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fire a single HTTPS request. Returns the parsed JSON body.
 * Throws HttpError or ParseError — never resolves on non-2xx.
 *
 * @param {'GET'|'POST'} method
 * @param {import('https').RequestOptions} options
 * @param {string|null} body  - raw request body string, or null for GET
 * @param {number} timeoutMs
 * @returns {Promise<unknown>}
 */
function rawRequest(method, options, body, timeoutMs, parseAs = 'json') {
  return new Promise((resolve, reject) => {
    const reqOptions = { ...options, method };
    if (body) {
      reqOptions.headers = {
        ...reqOptions.headers,
        'Content-Length': Buffer.byteLength(body),
      };
    }

    const req = https.request(reqOptions, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        const retryable = RETRYABLE_STATUS_CODES.has(status);

        if (status < 200 || status >= 300) {
          const err = new HttpError(
            status,
            `HTTP ${status}: ${raw.slice(0, 300)}`,
            retryable,
          );
          err.retryAfterHeader = res.headers['retry-after'];
          // THE MESSAGE IS TRUNCATED AND THE BODY IS NOT. 300 characters is the
          // right length for a log line and the wrong length for a diagnosis:
          // Apache's 300 Multiple Choices page states the problem in its first
          // 300 bytes and lists the ALTERNATIVES after them, so a caller
          // reading `message` sees "we found" and nothing it found. Callers
          // that need to act on the body read this instead.
          err.body = raw;
          return reject(err);
        }

        if (parseAs === 'text') return resolve(raw);

        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new ParseError(`JSON parse failed: ${e.message} — body: ${raw.slice(0, 200)}`));
        }
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new HttpError(0, `Request timed out after ${timeoutMs}ms`, true));
    });

    req.on('error', err => {
      // Treat network-level errors (ECONNRESET, ETIMEDOUT, etc.) as retryable
      const wrapped = new HttpError(0, `Network error: ${err.message}`, true);
      reject(wrapped);
    });

    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * GET a JSON endpoint with automatic retry.
 *
 * @param {import('https').RequestOptions} options  - host, path, headers, etc.
 * @param {Partial<typeof DEFAULT_RETRY_CONFIG>} [retryConfig]
 * @returns {Promise<unknown>}
 */
async function httpGet(options, retryConfig = {}, parseAs = 'json') {
  const config = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
  let lastErr;

  for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
    try {
      return await rawRequest('GET', options, null, config.socketTimeoutMs, parseAs);
    } catch (err) {
      lastErr = err;

      const isRetryable = err.retryable !== false; // ParseError.retryable = false
      const hasMoreAttempts = attempt + 1 < config.maxAttempts;

      if (!isRetryable || !hasMoreAttempts) break;

      const delay = waitMs(attempt, err.retryAfterHeader, config);
      console.warn(
        `[httpClient] GET ${options.path} → ${err.message} — retry ${attempt + 1}/${config.maxAttempts - 1} in ${delay}ms`,
      );
      await sleep(delay);
    }
  }

  throw lastErr;
}

/**
 * POST a JSON body to an HTTPS endpoint with automatic retry.
 *
 * @param {import('https').RequestOptions} options
 * @param {unknown} payload   - will be JSON-serialised
 * @param {Partial<typeof DEFAULT_RETRY_CONFIG>} [retryConfig]
 * @returns {Promise<unknown>}
 */
async function httpPost(options, payload, retryConfig = {}) {
  const config = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
  const body = JSON.stringify(payload);
  let lastErr;

  for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
    try {
      return await rawRequest('POST', options, body, config.socketTimeoutMs);
    } catch (err) {
      lastErr = err;

      const isRetryable = err.retryable !== false;
      const hasMoreAttempts = attempt + 1 < config.maxAttempts;

      if (!isRetryable || !hasMoreAttempts) break;

      const delay = waitMs(attempt, err.retryAfterHeader, config);
      console.warn(
        `[httpClient] POST ${options.path} → ${err.message} — retry ${attempt + 1}/${config.maxAttempts - 1} in ${delay}ms`,
      );
      await sleep(delay);
    }
  }

  throw lastErr;
}

/**
 * GET a plain-text endpoint with the same retry behaviour as httpGet.
 *
 * Exists because football-data.co.uk serves CSV, and the alternative was a
 * fifth copy-pasted https.request with its own idea of what a retry is — which
 * is the exact thing this module was written to end. The retry ladder, the
 * socket timeout and the Retry-After handling are shared; only the parse
 * differs.
 *
 * @param {import('https').RequestOptions} options
 * @param {Partial<typeof DEFAULT_RETRY_CONFIG>} [retryConfig]
 * @returns {Promise<string>}
 */
async function httpGetText(options, retryConfig = {}) {
  return httpGet(options, retryConfig, 'text');
}

module.exports = { httpGet, httpGetText, httpPost, HttpError, ParseError, DEFAULT_RETRY_CONFIG };
