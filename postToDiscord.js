'use strict';

/**
 * MaxEdge — the Discord channel.
 *
 * ── AN ADAPTER ON THE BROADCAST CORE, LIKE postToXChannel.js ────────────────
 *
 * Nothing here decides WHICH signals may be published. The gate
 * (`isBroadcastable`), the fetch with its publication filter
 * (`fetchRecentSignals`), the rung word (`rungOf`) and the claim/send/confirm
 * ledger (`deliver`) all come from postToX.js unchanged. This file owns three
 * things: which Discord channel a post goes to, when, and how it is worded
 * (lib/discordCompose).
 *
 * ── THREE MODES ─────────────────────────────────────────────────────────────
 *
 *   node postToDiscord.js signals   PRIME/EDGE to #plus-early at once, and to
 *                                   the public #signals forum after a delay.
 *   node postToDiscord.js results   Every settled signal that went out, win or
 *                                   loss, to #results and back into its thread.
 *   node postToDiscord.js weekly    The record card from performance_band.
 *
 * ── LEDGER CHANNELS (posted_signals.channel) ────────────────────────────────
 *
 *   discord-plus     the immediate Plus post
 *   discord          the delayed public forum post (external_msg_id = thread id)
 *   discord-result   the settlement post
 *
 * UNIQUE (signal_id, channel) on posted_signals means each happens once per
 * signal however many times the job runs.
 *
 * ── WHY RESULTS READ THE LEDGER ─────────────────────────────────────────────
 *
 * A result is posted for every signal Discord readers were SHOWN, and only
 * those. Reading the ledger rather than re-applying the gate means a later
 * change to the ladder cannot quietly drop a loss from #results.
 *
 * Env:
 *   DISCORD_POSTING_ENABLED=1            kill switch, fails closed
 *   DISCORD_WEBHOOK_SIGNALS              public #signals (a FORUM channel)
 *   DISCORD_WEBHOOK_PLUS                 #plus-early (optional)
 *   DISCORD_WEBHOOK_RESULTS              #results
 *   DISCORD_WEBHOOK_RECORD               #weekly-record
 *   DISCORD_FREE_DELAY_MIN   default 30  public delay after detection
 *   DISCORD_DAILY_CAP        default 12  signal posts per channel per UTC day
 *   DRY_RUN=1                            compose and print, never send or claim
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const {
  fetchRecentSignals, deliver, isBroadcastable, isMover, isInplay, rungOf,
} = require('./postToX');
const { dedupeConflicts } = require('./lib/signalTier');
const {
  signalPost, resultPost, weeklyRecordPost, threadName, ComposeRefusal,
} = require('./lib/discordCompose');
const { postWebhook, channelEnabled } = require('./lib/discordClient');

const DRY_RUN = process.env.DRY_RUN === '1';
// An unset GitHub `vars.X` arrives as an EMPTY STRING, and Number('') is 0:
// a 0 cap would silence the channel and a 0 delay would hand the public feed
// to everyone at once. So blank and non-numeric both mean "use the default".
function numEnv(name, fallback) {
  const v = Number(process.env[name]);
  return process.env[name]?.trim() && Number.isFinite(v) ? v : fallback;
}
const FREE_DELAY_MIN = numEnv('DISCORD_FREE_DELAY_MIN', 30);
const DAILY_CAP = numEnv('DISCORD_DAILY_CAP', 12);
const MIN_LEAD_MIN = 10;    // never post a public signal inside 10 min of kick-off

const LEDGER = { PLUS: 'discord-plus', FREE: 'discord', RESULT: 'discord-result' };

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key);
}

const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const minutesAgo = iso => (Date.now() - new Date(iso).getTime()) / 60000;
const minutesUntil = iso => (new Date(iso).getTime() - Date.now()) / 60000;

/** Pre-match, backed, priced, one per (match, market, line). Same filter as Telegram. */
function eligibleSignals(signals) {
  return dedupeConflicts(signals.filter(s =>
    !isInplay(s) && !isMover(s) && isBroadcastable(s) &&
    Number(s.detected_odds) > 1 && Number.isFinite(Number(s.detected_edge))));
}

/** Which signals each audience gets on this run. Pure, so it can be tested. */
function plan(signals, now = Date.now()) {
  const eligible = eligibleSignals(signals)
    .filter(s => (new Date(s.kickoff_at).getTime() - now) / 60000 > MIN_LEAD_MIN);
  return {
    plus: eligible,
    free: eligible.filter(s => (now - new Date(s.detected_at).getTime()) / 60000 >= FREE_DELAY_MIN),
  };
}

async function postedToday(supabase, channel) {
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  const { count, error } = await supabase.from('posted_signals')
    .select('id', { count: 'exact', head: true })
    .eq('channel', channel).gte('posted_at', start.toISOString());
  if (error) throw new Error(`postedToday: ${error.message}`);
  return count ?? 0;
}

async function sendBatch(supabase, rows, { channel, webhook, delayed, forum }) {
  if (!rows.length) return 0;
  if (!webhook) { console.log(`[postToDiscord] ${channel}: no webhook set, skipping`); return 0; }
  let sent = 0;
  let today = DRY_RUN ? 0 : await postedToday(supabase, channel);
  for (const s of rows) {
    if (today >= DAILY_CAP) { console.log(`[postToDiscord] ${channel}: daily cap ${DAILY_CAP} reached`); break; }
    let payload;
    try { payload = signalPost(s, rungOf(s), { delayed }); }
    catch (err) {
      if (err instanceof ComposeRefusal) { console.warn(`[postToDiscord] ${s.id}: ${err.message}`); continue; }
      throw err;
    }
    const body = JSON.stringify(payload);
    if (DRY_RUN) { console.log(`\n[${channel}] ${forum ? `thread "${threadName(s)}"\n` : ''}${body}\n`); continue; }
    const opts = forum ? { threadName: threadName(s) } : {};
    const res = await deliver(supabase, s, hash(body), () => postWebhook(webhook, payload, opts), true, channel);
    if (res.outcome === 'sent') { sent++; today++; }
    else if (res.outcome !== 'already_published') console.log(`[postToDiscord] ${channel} ${s.id}: ${res.outcome}`);
  }
  return sent;
}

async function runSignals(supabase) {
  const signals = await fetchRecentSignals(supabase);
  const { plus, free } = plan(signals);
  console.log(`[postToDiscord] ${signals.length} fetched · ${plus.length} for Plus · ${free.length} due public`);
  const a = await sendBatch(supabase, plus, {
    channel: LEDGER.PLUS, webhook: process.env.DISCORD_WEBHOOK_PLUS, delayed: false, forum: false,
  });
  const b = await sendBatch(supabase, free, {
    channel: LEDGER.FREE, webhook: process.env.DISCORD_WEBHOOK_SIGNALS,
    delayed: Boolean(process.env.DISCORD_WEBHOOK_PLUS), forum: process.env.DISCORD_SIGNALS_FORUM !== '0',
  });
  return { posted: a + b };
}

/** Settled signals that Discord readers were shown and that have no result post yet. */
async function settledToAnnounce(supabase) {
  const since = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const { data: shown, error: e1 } = await supabase.from('posted_signals')
    .select('signal_id, channel, external_msg_id')
    .in('channel', [LEDGER.PLUS, LEDGER.FREE, LEDGER.RESULT])
    .gte('posted_at', since);
  if (e1) throw new Error(`settledToAnnounce ledger: ${e1.message}`);

  const byId = new Map();
  for (const r of shown ?? []) {
    const e = byId.get(r.signal_id) ?? { shown: false, done: false, thread: null };
    if (r.channel === LEDGER.RESULT) e.done = true;
    else if (r.external_msg_id) e.shown = true;
    if (r.channel === LEDGER.FREE && r.external_msg_id) e.thread = r.external_msg_id;
    byId.set(r.signal_id, e);
  }
  const ids = [...byId].filter(([, e]) => e.shown && !e.done).map(([id]) => id);
  if (!ids.length) return [];

  const { data, error } = await supabase.from('value_signals')
    .select(`id, market, market_line, outcome, detected_odds, detected_edge, mxs, mxs_band, gap_basis,
      model_prob, market_prob, prob_gap, closing_odds, result, kickoff_at,
      match:matches ( goals_home, goals_away,
        home_team:teams!matches_home_team_id_fkey ( name ),
        away_team:teams!matches_away_team_id_fkey ( name ),
        league:leagues ( name ) )`)
    .in('id', ids)
    .in('result', ['win', 'loss', 'void', 'push']);
  if (error) throw new Error(`settledToAnnounce signals: ${error.message}`);
  return (data ?? []).map(s => ({ ...s, _thread: byId.get(s.id).thread }));
}

async function runResults(supabase) {
  const webhook = process.env.DISCORD_WEBHOOK_RESULTS;
  const rows = await settledToAnnounce(supabase);
  console.log(`[postToDiscord] ${rows.length} result(s) to announce`);
  let sent = 0;
  for (const s of rows) {
    const payload = resultPost(s, rungOf(s));
    const body = JSON.stringify(payload);
    if (DRY_RUN) { console.log(`\n[result] ${body}\n`); continue; }
    if (!webhook) { console.log('[postToDiscord] no DISCORD_WEBHOOK_RESULTS, skipping'); break; }
    const res = await deliver(supabase, s, hash(body), () => postWebhook(webhook, payload), false, LEDGER.RESULT);
    if (res.outcome !== 'sent') continue;
    sent++;
    // Best effort, after the ledgered post: the thread reply is a courtesy,
    // #results is the record.
    if (s._thread && process.env.DISCORD_WEBHOOK_SIGNALS) {
      try { await postWebhook(process.env.DISCORD_WEBHOOK_SIGNALS, payload, { threadId: s._thread }); }
      catch (err) { console.warn(`[postToDiscord] thread reply failed for ${s.id}: ${err.message}`); }
    }
  }
  return { posted: sent };
}

async function runWeekly(supabase) {
  const { data, error } = await supabase.from('performance_band')
    .select('band_key, band_label, sort_order, published, record_role, settled_fixtures, wins, losses, win_rate, breakeven_strike, yield, units, insufficient, insufficient_reason, headline_scope_note, calculated_at');
  if (error) throw new Error(`performance_band: ${error.message}`);
  const payload = weeklyRecordPost(data);
  if (DRY_RUN) { console.log(JSON.stringify(payload, null, 2)); return { posted: 0 }; }
  const webhook = process.env.DISCORD_WEBHOOK_RECORD;
  if (!webhook) { console.log('[postToDiscord] no DISCORD_WEBHOOK_RECORD, skipping'); return { posted: 0 }; }
  await postWebhook(webhook, payload);
  return { posted: 1 };
}

async function run(mode = process.argv[2] ?? 'signals') {
  console.log(`\n[postToDiscord] ${new Date().toISOString()} mode=${mode}${DRY_RUN ? ' [DRY RUN]' : ''}`);
  if (!channelEnabled() && !DRY_RUN) {
    console.log('[postToDiscord] channel disabled (DISCORD_POSTING_ENABLED != 1)');
    return { posted: 0, reason: 'channel-disabled' };
  }
  const supabase = getSupabase();
  if (mode === 'signals') return runSignals(supabase);
  if (mode === 'results') return runResults(supabase);
  if (mode === 'weekly') return runWeekly(supabase);
  throw new Error(`unknown mode "${mode}"`);
}

if (require.main === module) {
  run().then(r => console.log(`[postToDiscord] done ${JSON.stringify(r)}`))
    .catch(err => { console.error(`[postToDiscord] ${err.message}`); process.exit(1); });
}

module.exports = { run, numEnv, plan, eligibleSignals, settledToAnnounce, LEDGER };
