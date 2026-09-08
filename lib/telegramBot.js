'use strict';

/**
 * lib/telegramBot.js — the Telegram Bot API calls membership management
 * needs, none of which `postToX.js` makes today (it only ever sends a
 * message; there is no ban/unban/revoke anywhere else in this repo).
 *
 * Each function is a thin POST to `api.telegram.org` — the same shape as
 * `postToX.js`'s own `telegramPost`, kept separate rather than exported from
 * there so `reconcileTelegramMembership.js` can take this whole module as an
 * injectable dependency and its tests can swap in a fake one with zero real
 * network calls, the same way every other engine test mocks pure functions
 * rather than touching `https` or Supabase directly.
 *
 * All five reject on a non-`ok` Telegram response, carrying `errorCode` and
 * `retryAfterSec` (from `parameters.retry_after` on a 429) the way
 * `postToX.js`'s `telegramPost` already does, so a caller can tell a
 * rate-limit apart from a real failure without re-parsing the message.
 */

const https = require('https');

function telegramRequest(token, method, params) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(params);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(raw); }
        catch (e) { return reject(new Error(`Telegram ${method}: response not JSON: ${raw.slice(0, 200)}`)); }
        if (json.ok) {
          resolve(json.result);
        } else {
          const err = new Error(`Telegram ${method} error ${json.error_code}: ${json.description}`);
          err.errorCode = json.error_code ?? null;
          err.retryAfterSec = json.parameters?.retry_after ?? null;
          reject(err);
        }
      });
    });
    req.setTimeout(15_000, () => req.destroy(new Error(`Telegram ${method} timeout`)));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Removes a member from a channel WITHOUT a permanent ban: ban then
 * immediately unban with `only_if_banned: true`, exactly the pair the task
 * asked for. Telegram has no plain "kick" call — `banChatMember` alone leaves
 * them permanently banned and unable to rejoin via a future invite link even
 * after they re-subscribe, which is not what a lapsed-then-renewed member
 * should get.
 */
async function banChatMember(token, chatId, telegramUserId) {
  return telegramRequest(token, 'banChatMember', { chat_id: chatId, user_id: telegramUserId });
}

async function unbanChatMember(token, chatId, telegramUserId, opts = {}) {
  return telegramRequest(token, 'unbanChatMember', {
    chat_id: chatId,
    user_id: telegramUserId,
    only_if_banned: opts.only_if_banned !== false,
  });
}

/** Best-effort: pulls a still-unused invite link so it can no longer be joined. */
async function revokeChatInviteLink(token, chatId, inviteLink) {
  return telegramRequest(token, 'revokeChatInviteLink', { chat_id: chatId, invite_link: inviteLink });
}

async function sendMessage(token, chatId, text) {
  return telegramRequest(token, 'sendMessage', { chat_id: chatId, text });
}

module.exports = { telegramRequest, banChatMember, unbanChatMember, revokeChatInviteLink, sendMessage };
