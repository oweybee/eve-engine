'use strict';

/**
 * lib/discordClient — one webhook POST, with the error contract `deliver` needs.
 *
 * `deliver` in postToX.js releases a ledger claim ONLY on proof nothing was
 * sent. Discord gives that proof as a well-formed HTTP 4xx (bad payload,
 * unknown webhook, 429 rate limit): those set `discordRejected`. A timeout or
 * dropped socket proves nothing, the message may have landed, so it sets no
 * flag and the claim stands. One withheld post beats one duplicate.
 *
 * Webhook URLs are secrets (anyone holding one can post as the bot). They are
 * read from the environment only and never logged.
 */

const https = require('https');

const TIMEOUT_MS = 15000;

/**
 * POST a payload to a webhook. `?wait=true` makes Discord return the created
 * message, whose id the ledger stores. For a FORUM channel, pass `threadName`
 * and a new post (thread) is created; its starter message id equals the thread
 * id, which is how a result is later posted back into the same thread.
 */
function postWebhook(webhookUrl, payload, { threadName = null, threadId = null } = {}) {
  if (!webhookUrl) return Promise.reject(new Error('postWebhook: no webhook URL'));
  const url = new URL(webhookUrl);
  url.searchParams.set('wait', 'true');
  if (threadId) url.searchParams.set('thread_id', String(threadId));
  const body = JSON.stringify(threadName ? { ...payload, thread_name: threadName } : payload);

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: TIMEOUT_MS,
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          let json = {};
          try { json = JSON.parse(raw); } catch { /* 204 has no body */ }
          return resolve({ message_id: json.id ?? null, channel_id: json.channel_id ?? null });
        }
        const err = new Error(`discord webhook HTTP ${res.statusCode}`);
        err.status = res.statusCode;
        // 4xx is a well-formed refusal: proof nothing was delivered.
        if (res.statusCode >= 400 && res.statusCode < 500) err.discordRejected = true;
        try { err.retryAfter = JSON.parse(raw).retry_after; } catch { /* ignore */ }
        reject(err);
      });
    });
    req.on('timeout', () => req.destroy(new Error('discord webhook timeout')));
    req.on('error', reject);   // transport failure: no flag, claim stands
    req.write(body);
    req.end();
  });
}

/** Fails closed: anything other than exactly "1" means off. */
function channelEnabled() {
  return process.env.DISCORD_POSTING_ENABLED === '1';
}

module.exports = { postWebhook, channelEnabled };
