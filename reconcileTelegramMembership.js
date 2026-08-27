'use strict';

/**
 * reconcileTelegramMembership.js — kick or flag a lapsed member out of the
 * Telegram channels, on a schedule.
 *
 * Owner request, 27 Aug 2026: every trialling or paying member gets offered
 * both channels on signup (eve-frontend's half, over the `telegram_links`
 * table migration 112 creates); when a subscription lapses this script either
 * removes them or tells the owner who to remove by hand. Nothing in this repo
 * has ever managed Telegram MEMBERSHIP before — `postToX.js` only ever posts
 * one-way into a channel.
 *
 * PER ROW, PER CHANNEL, INDEPENDENTLY. `signals_status` and `inplay_status`
 * are asked and acted on separately, because a member can be `joined` on one
 * channel and `invited`-but-never-joined on the other, and because a channel
 * whose chat id or bot isn't configured must not stop the other one working.
 *
 *   joined   + unentitled  -> kick: ban, then unban with only_if_banned, as
 *                             TWO SEPARATE steps (see below) -> status =
 *                             'kicked'. A ban failure leaves the row `joined`
 *                             and adds it to the owner-notify list — it is
 *                             still IN the channel, which the owner needs to
 *                             know. A ban SUCCESS followed by an unban
 *                             FAILURE still marks the row 'kicked' (they are
 *                             genuinely out) but the owner-notify reason
 *                             explicitly says they are now permanently banned
 *                             and names the telegram_user_id to unban by
 *                             hand — see the note on the kick branch below
 *                             for why this has to be a distinct message.
 *   invited  + unentitled  -> best-effort revokeChatInviteLink -> status =
 *                             'revoked' regardless of whether the revoke call
 *                             itself succeeded (nobody joined on this link, so
 *                             a failed revoke is low-stakes and only logged —
 *                             not owner-notify-worthy).
 *   anything else          -> skipped: 'none'/'kicked'/'revoked'/'left', or
 *                             still entitled.
 *
 * A `joined` row with no `*_telegram_user_id` on file can never be kicked
 * (there is nothing to call Telegram with) and goes straight to the
 * owner-notify list rather than being silently skipped. It most likely means
 * the member joined via a path that bypassed eve-frontend's webhook, and a
 * row this script cannot act on has to be surfaced, not swallowed.
 *
 * WHY BAN AND UNBAN ARE TWO TRY/CATCHES, NOT ONE. A Telegram channel ban is
 * PERMANENT until explicitly lifted — it is not a timed kick. `unbanChatMember`
 * with `only_if_banned: true` is what turns "removed" into "removed, and free
 * to rejoin on a future invite link". If the two calls shared one try/catch,
 * a ban that succeeds followed by an unban that merely fails (a network blip,
 * a rate limit) left the row's status at 'joined' — which is not just wrong
 * bookkeeping. `planChannel()` returns `{action:'none'}` for any entitled row,
 * so if that member later resubscribed nothing in this product would ever
 * call `unbanChatMember` for them again: a paying customer locked out of the
 * channel forever by one transient API error, and an owner-notify message
 * that read only "kick failed: <error>" — which undersold what had actually
 * happened, since the ban itself had already landed. Splitting the two calls
 * means a ban failure and an unban-after-successful-ban failure are reported
 * as the different situations they are, and the status update always reflects
 * what Telegram actually did, not what this script hoped it did.
 *
 * ENTITLEMENT comes from `public.is_plus_entitled(uuid)` (migration 112),
 * which mirrors `current_tier()`'s own trial/tier case logic rather than
 * re-typing it here — see that migration's header for why a second hand-copy
 * of that logic is exactly the shape that has already gone wrong twice in
 * this product (MODEL_SIGMA, twice).
 *
 * GATED BEHIND `TELEGRAM_MEMBERSHIP_ENABLED`, the same shape as
 * `INPLAY_BROADCAST_ENABLED` in lib/publication.js: unset or anything other
 * than the literal string 'true' (case-insensitively) is a DRY RUN. A dry run
 * still reads `telegram_links` and calls `is_plus_entitled` for every row
 * that needs a decision (those are reads, and the plan cannot be computed or
 * logged without them) but makes ZERO Telegram API calls and writes NO status
 * change to the database — every action is logged as "would kick" / "would
 * revoke" instead. This mirrors `backfillTeamCrests.js --dry-run`'s intent
 * (match and report, write nothing) even though the switch here is an env var
 * rather than a CLI flag, because this runs on a fixed schedule rather than by
 * hand.
 *
 * FAILS CLOSED: no `TELEGRAM_BOT_TOKEN` (or no `TELEGRAM_CHAT_ID`, which
 * `getTelegramConfig()` in postToX.js already treats as "no config") means
 * there is no channel to act on at all — the script logs why and exits 0
 * without ever calling Supabase.
 *
 * Usage:
 *   node reconcileTelegramMembership.js              # dry run unless
 *                                                     # TELEGRAM_MEMBERSHIP_ENABLED=true
 *   TELEGRAM_MEMBERSHIP_ENABLED=true node reconcileTelegramMembership.js
 */

const { getClient } = require('./lib/supabaseClient');
const telegramBotDefault = require('./lib/telegramBot');
const { getTelegramConfig, postTargetFor } = require('./postToX');

const CHANNELS = ['signals', 'inplay'];

function membershipEnabled() {
  return (process.env.TELEGRAM_MEMBERSHIP_ENABLED || '').toLowerCase() === 'true';
}

/**
 * Pure: what to do for ONE row's ONE channel, given whether the user is
 * currently entitled. No I/O, no env reads — this is the unit the tests drive
 * directly, separate from the async orchestration below.
 *
 * @returns {{action:'none'|'kick'|'revoke'|'notify_owner'|'skip_log', reason?:string, telegramUserId?:number, inviteLink?:string}}
 */
function planChannel(row, channel, entitled) {
  if (entitled) return { action: 'none' };

  const status = row[`${channel}_status`];
  const telegramUserId = row[`${channel}_telegram_user_id`];
  const inviteLink = row[`${channel}_invite_link`];

  if (status === 'joined') {
    if (telegramUserId == null) {
      return {
        action: 'notify_owner',
        reason: `joined but no ${channel}_telegram_user_id on file — cannot kick automatically; they likely joined via a path that bypassed the webhook`,
      };
    }
    return { action: 'kick', telegramUserId };
  }

  if (status === 'invited') {
    if (!inviteLink) {
      return { action: 'skip_log', reason: `invited but no ${channel}_invite_link on file — nothing to revoke` };
    }
    return { action: 'revoke', inviteLink };
  }

  // 'none' | 'kicked' | 'revoked' | 'left' — nothing to do.
  return { action: 'none' };
}

/** Pure: both channels for one row. */
function planFor(row, entitled) {
  const plan = {};
  for (const channel of CHANNELS) plan[channel] = planChannel(row, channel, entitled);
  return plan;
}

/** A row needs an entitlement check at all only if some channel could act on it. */
function needsEntitlementCheck(row) {
  return CHANNELS.some(ch => ['joined', 'invited'].includes(row[`${ch}_status`]));
}

async function isEntitled(supabase, userId) {
  const { data, error } = await supabase.rpc('is_plus_entitled', { p_user_id: userId });
  if (error) throw new Error(`is_plus_entitled(${userId}): ${error.message}`);
  return data === true;
}

function targetsFor(telegram) {
  const targets = {};
  for (const channel of CHANNELS) {
    targets[channel] = postTargetFor(telegram, { phase: channel === 'inplay' ? 'inplay' : 'prematch' });
  }
  return targets;
}

/**
 * Sends (or, dry-run/unconfigured, logs) the "owner should manually remove
 * these" summary. Never throws — this is a notification path, and CLAUDE.md's
 * own rule for the alerting shape this repo already has is that a failure
 * here must not become the thing that fails the run.
 */
async function notifyOwner(telegramBot, entries, { dryRun }) {
  if (!entries.length) return;

  const lines = entries.map(e =>
    `• user_id=${e.user_id} channel=${e.channel} telegram_user_id=${e.telegram_user_id ?? '(none)'} — ${e.reason}`);
  const text = `[MaxEdge] ${entries.length} Telegram membership row(s) need manual attention:\n\n${lines.join('\n')}`;

  if (dryRun) {
    console.log(`[telegram-membership] DRY RUN — would notify owner:\n${text}`);
    return;
  }

  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!ownerChatId || !token) {
    console.error(`[telegram-membership] TELEGRAM_OWNER_CHAT_ID not set — logging instead of notifying:\n${text}`);
    return;
  }

  try {
    await telegramBot.sendMessage(token, ownerChatId, text);
  } catch (err) {
    console.error(`[telegram-membership] owner notification failed (${err.message}) — logging instead:\n${text}`);
  }
}

/**
 * @param {{supabase?: object, telegramBot?: object}} [deps] — injectable for
 *   tests. Defaults to the real Supabase client and the real Telegram Bot API.
 */
async function run(deps = {}) {
  const supabase = deps.supabase ?? getClient();
  const telegramBot = deps.telegramBot ?? telegramBotDefault;

  const dryRun = !membershipEnabled();
  console.log(`[telegram-membership] ${new Date().toISOString()}${dryRun ? ' [DRY RUN]' : ''}`);

  // Fails closed: no bot token (or no main chat id, which getTelegramConfig
  // already folds into "no config") -> nothing to act on, log why, exit 0.
  const telegram = getTelegramConfig();
  if (!telegram) {
    console.log('[telegram-membership] no Telegram config (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID unset) — nothing to do');
    return { checked: 0, kicked: 0, revoked: 0, skipped: 0, ownerNotify: [] };
  }
  const targets = targetsFor(telegram);

  const { data: rows, error } = await supabase.from('telegram_links').select('*');
  if (error) throw new Error(`telegram_links read: ${error.message}`);

  let checked = 0, kicked = 0, revoked = 0, skipped = 0;
  const ownerNotify = [];

  for (const row of rows ?? []) {
    if (!needsEntitlementCheck(row)) { skipped++; continue; }

    checked++;
    const entitled = await isEntitled(supabase, row.user_id);
    const plan = planFor(row, entitled);

    for (const channel of CHANNELS) {
      const action = plan[channel];
      const target = targets[channel];

      if (action.action === 'none') continue;

      if (action.action === 'skip_log') {
        console.log(`[telegram-membership] user_id=${row.user_id} channel=${channel}: ${action.reason}`);
        continue;
      }

      if (action.action === 'notify_owner') {
        ownerNotify.push({
          user_id: row.user_id, channel,
          telegram_user_id: row[`${channel}_telegram_user_id`] ?? null,
          reason: action.reason,
        });
        continue;
      }

      if (action.action === 'kick') {
        if (dryRun) {
          console.log(`[telegram-membership] DRY RUN would kick user_id=${row.user_id} channel=${channel} telegram_user_id=${action.telegramUserId}`);
          continue;
        }
        if (!target) {
          ownerNotify.push({
            user_id: row.user_id, channel, telegram_user_id: action.telegramUserId,
            reason: `${channel} channel is not configured (chat id / bot token missing) — cannot kick`,
          });
          continue;
        }

        // Ban and unban are deliberately TWO try/catches, not one — see the
        // file header. A ban failure means nothing happened; an unban
        // failure AFTER a successful ban means the member is genuinely out
        // of the channel but Telegram now considers them permanently
        // banned, which is a materially different — and more urgent —
        // thing to tell the owner than "kick failed".
        try {
          await telegramBot.banChatMember(target.token, target.chatId, action.telegramUserId);
        } catch (err) {
          console.error(`[telegram-membership] kick FAILED (ban) user_id=${row.user_id} channel=${channel}: ${err.message}`);
          ownerNotify.push({
            user_id: row.user_id, channel, telegram_user_id: action.telegramUserId,
            reason: `kick failed: ${err.message}`,
          });
          continue;
        }

        let unbanFailed = null;
        try {
          await telegramBot.unbanChatMember(target.token, target.chatId, action.telegramUserId, { only_if_banned: true });
        } catch (err) {
          unbanFailed = err;
        }

        const { error: upErr } = await supabase
          .from('telegram_links')
          .update({ [`${channel}_status`]: 'kicked' })
          .eq('user_id', row.user_id);
        if (upErr) throw new Error(`status update: ${upErr.message}`);
        kicked++;

        if (unbanFailed) {
          console.error(`[telegram-membership] unban FAILED after a successful ban — user_id=${row.user_id} channel=${channel} telegram_user_id=${action.telegramUserId} is now PERMANENTLY BANNED until manually unbanned: ${unbanFailed.message}`);
          ownerNotify.push({
            user_id: row.user_id, channel, telegram_user_id: action.telegramUserId,
            reason: `banned successfully but the unban call failed — they are PERMANENTLY BANNED from ${channel} and cannot rejoin on any future invite link until you manually unban telegram_user_id ${action.telegramUserId} in Telegram: ${unbanFailed.message}`,
          });
        } else {
          console.log(`[telegram-membership] kicked user_id=${row.user_id} channel=${channel}`);
        }
        continue;
      }

      if (action.action === 'revoke') {
        if (dryRun) {
          console.log(`[telegram-membership] DRY RUN would revoke invite user_id=${row.user_id} channel=${channel}`);
          continue;
        }
        if (target) {
          try {
            await telegramBot.revokeChatInviteLink(target.token, target.chatId, action.inviteLink);
          } catch (err) {
            // Low-stakes: nobody joined on this link. Log only, per spec.
            console.log(`[telegram-membership] revoke failed (non-fatal) user_id=${row.user_id} channel=${channel}: ${err.message}`);
          }
        } else {
          console.log(`[telegram-membership] cannot revoke — ${channel} channel not configured; skipping (low stakes, nobody joined)`);
        }
        const { error: upErr } = await supabase
          .from('telegram_links')
          .update({ [`${channel}_status`]: 'revoked' })
          .eq('user_id', row.user_id);
        if (upErr) {
          console.error(`[telegram-membership] status update failed user_id=${row.user_id} channel=${channel}: ${upErr.message}`);
        } else {
          revoked++;
        }
      }
    }
  }

  await notifyOwner(telegramBot, ownerNotify, { dryRun });

  console.log('[telegram-membership] done —', { checked, kicked, revoked, skipped, notify: ownerNotify.length });
  return { checked, kicked, revoked, skipped, ownerNotify };
}

if (require.main === module) {
  run().catch(err => { console.error('[telegram-membership] fatal:', err.message); process.exit(1); });
}

module.exports = {
  run, planChannel, planFor, needsEntitlementCheck, membershipEnabled, CHANNELS, notifyOwner,
};
