/**
 * MaxEdge — Automated Signal Posting (Telegram)
 *
 * Two-tier broadcast, routed by conviction (see lib/signalTier.js):
 *
 *   PRIME  → PAID channel (TELEGRAM_PRIME_CHAT_ID). The back-tested sweet spot:
 *            odds 1.40–3.00 AND edge 4–10%. Suggested + tracked.
 *   VALUE + LONGSHOT → FREE channel (TELEGRAM_FREE_CHAT_ID). Shown for
 *            information only — never suggested, never tracked — but broadcast
 *            to the free channel so it always has a live feed.
 *   ODDS MOVEMENT → follows its underlying tier (a Prime mover → paid, a
 *            value/longshot mover → free).
 *   IN-PLAY → dedicated in-play channel (TELEGRAM_INPLAY_CHAT_ID).
 *
 * A channel that isn't configured means its tier is recorded but not posted
 * (below-floor edges are never posted at all). If TELEGRAM_PRIME_CHAT_ID is
 * unset, Prime falls back to the legacy TELEGRAM_CHAT_ID so an un-migrated
 * deploy keeps posting Prime exactly where it used to.
 */
'use strict';

const https  = require('https');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { formatLiveState } = require('./lib/inplay');
const { classifyTier, dedupeConflicts } = require('./lib/signalTier');

const DRY_RUN = process.env.DRY_RUN === '1';
const CHANNEL = 'telegram';
const RUN_ID  = process.env.GITHUB_RUN_ID ?? 'local';

// Optional upsell link shown on FREE-channel (Value/Longshot) posts, pointing
// subscribers to the paid Prime channel. Unset ⇒ no footer.
const PRIME_INVITE_URL = process.env.TELEGRAM_PRIME_INVITE_URL || null;

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key);
}

function getTelegramConfig() {
  const token        = process.env.TELEGRAM_BOT_TOKEN;
  // Legacy single-channel id — the fallback destination for Prime if the paid
  // channel hasn't been provisioned yet.
  const chatId       = process.env.TELEGRAM_CHAT_ID || null;
  // Paid channel (Prime). Falls back to the legacy chat so nothing goes dark
  // before the split is wired up.
  const primeChatId  = process.env.TELEGRAM_PRIME_CHAT_ID || chatId;
  // Free channel (Value + Longshot). Unset ⇒ those tiers are recorded, not posted.
  const freeChatId   = process.env.TELEGRAM_FREE_CHAT_ID || null;
  const inplayChatId = process.env.TELEGRAM_INPLAY_CHAT_ID || null;
  if (!token || !primeChatId) return null;
  return { token, chatId, primeChatId, freeChatId, inplayChatId };
}

/**
 * Which chat a signal goes to, by tier:
 *   in-play  → the dedicated in-play channel (null ⇒ not posted, never leaked)
 *   prime    → the paid channel
 *   value / longshot → the free channel
 *   below-floor (tier null) → null (never broadcast)
 *
 * A null return means "no destination" — the caller records the signal as
 * handled but sends nothing. Legacy configs that only carry `chatId` still
 * work: `primeChatId` falls back to it in getTelegramConfig, and callers may
 * also pass a bare `{ chatId }` (Prime → chatId, free tiers → null).
 */
function chatIdForSignal(telegram, signal) {
  if (signal.phase === 'inplay') return telegram.inplayChatId ?? null; // null ⇒ skip
  const legacy = telegram.chatId ?? null;
  const prime  = telegram.primeChatId ?? legacy;
  const free   = telegram.freeChatId ?? null;
  const { tier } = classifyTier(signal);
  if (tier === 'prime') return prime ?? null;
  if (tier === 'value' || tier === 'longshot') return free;
  return null; // below the visibility floor ⇒ never broadcast
}

async function loadPostedIds(supabase) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('posted_signals')
    .select('signal_id')
    .eq('channel', CHANNEL)
    .gte('posted_at', since);
  if (error) throw new Error(`loadPostedIds: ${error.message}`);
  return new Set((data ?? []).map(r => r.signal_id));
}

async function markPosted(supabase, signalId, messageHash, externalMsgId) {
  const { error } = await supabase
    .from('posted_signals')
    .upsert(
      { signal_id: signalId, channel: CHANNEL, posted_at: new Date().toISOString(),
        message_hash: messageHash, external_msg_id: externalMsgId ? String(externalMsgId) : null,
        run_id: RUN_ID },
      { onConflict: 'signal_id,channel' },
    );
  if (error) throw new Error(`markPosted: ${error.message}`);
}

async function fetchRecentSignals(supabase) {
  const kickoffFloor = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('value_signals')
    .select(`
      id, match_id, market, market_line, outcome, detected_odds, detected_edge, detected_mes, bookmaker,
      kickoff_at, detected_at, signal_category, is_mover, phase,
      match:matches (
        goals_home, goals_away, minute,
        home_team:teams!matches_home_team_id_fkey ( name ),
        away_team:teams!matches_away_team_id_fkey ( name ),
        league:leagues ( name )
      )
    `)
    .eq('result', 'pending')
    .gte('kickoff_at', kickoffFloor)
    .order('kickoff_at', { ascending: true });
  if (error) throw new Error(`fetchRecentSignals: ${error.message}`);
  return data ?? [];
}

function isMover(signal) { return signal.is_mover === true; }
function isInplay(signal) { return signal.phase === 'inplay'; }
/** Pre-match signals we actually suggest (and broadcast): the Prime tier. */
function isSuggested(signal) { return classifyTier(signal).suggested; }

function formatKickoff(isoStr) {
  if (!isoStr) return 'TBC';
  const d = new Date(isoStr);
  const days   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const hh = String(d.getUTCHours()).padStart(2,'0');
  const mm = String(d.getUTCMinutes()).padStart(2,'0');
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${hh}:${mm} UTC`;
}

function buildMessage(signal) {
  const home    = signal.match?.home_team?.name ?? 'Home';
  const away    = signal.match?.away_team?.name ?? 'Away';
  const league  = signal.match?.league?.name ?? '';
  // Underscores in outcomes (e.g. BTTS_YES) are Markdown italic delimiters and
  // break Telegram's parser — render them as spaces ("BTTS YES").
  const outcome = signal.outcome.toUpperCase().replace(/_/g, ' ');
  const odds    = signal.detected_odds.toFixed(2);
  const edgePct = (signal.detected_edge * 100).toFixed(1);
  const mes     = signal.detected_mes != null ? ` | MES: ${signal.detected_mes}/100` : '';
  const book    = signal.bookmaker ?? 'Best price';
  const kickoff = formatKickoff(signal.kickoff_at);

  // In-play signals are a separate tier: live score/minute instead of kickoff,
  // and a distinct header so the dedicated channel reads unmistakably "live".
  if (isInplay(signal)) {
    const liveState = formatLiveState(
      signal.match?.goals_home, signal.match?.goals_away, signal.match?.minute
    );
    return [
      `🔴 *IN-PLAY VALUE*`, ``,
      `*${home} vs ${away}*`,
      league ? `_${league}_` : null,
      `Live: ${liveState}`,
      `${outcome} @ ${odds} (${book})`,
      `Edge: +${edgePct}%${mes}`,
      ``,
      `[View on MaxEdge](https://maxedge.live/feed)`,
      `#MaxEdge #InPlay #LiveValue`,
    ].filter(l => l !== null).join('\n');
  }

  let header, hashtags, note = null;
  // Free-channel tiers (value/longshot) carry an upsell to the paid Prime
  // channel when a link is configured. Prime and mover posts never do.
  const { tier: signalTier } = classifyTier(signal);
  const upsell = (PRIME_INVITE_URL && !isMover(signal) &&
    (signalTier === 'value' || signalTier === 'longshot'))
    ? `🔓 _Prime signals are members-only._ [Go Prime →](${PRIME_INVITE_URL})`
    : null;
  if (isMover(signal)) {
    header   = `>> *ODDS MOVEMENT*`;
    hashtags = `#MaxEdge #OddsMove`;
  } else {
    const { tier, notable } = classifyTier(signal);
    if (tier === 'prime') {
      header   = `🟢 *PRIME SIGNAL*`;
      note     = `_High conviction — our only highly-suggested tier_`;
      hashtags = `#MaxEdge #Prime #ValueBet`;
    } else if (tier === 'longshot') {
      header   = notable ? `🎯 *LONGSHOT · NOTABLE EDGE*` : `🎯 *LONGSHOT*`;
      note     = `_For information only — not a suggested signal_`;
      hashtags = `#MaxEdge #Longshot`;
    } else {
      // 'value' (or below-floor) — shown as a tool, never suggested.
      header   = `⚡ *VALUE SIGNAL*`;
      note     = `_For information only — not a suggested signal_`;
      hashtags = `#MaxEdge #ValueBet`;
    }
  }

  return [
    header, note, ``,
    `*${home} vs ${away}*`,
    league ? `_${league}_` : null,
    `${outcome} @ ${odds} (${book})`,
    `Edge: +${edgePct}%${mes}`,
    ``,
    `Kickoff: ${kickoff}`,
    ``,
    `[View on MaxEdge](https://maxedge.live/feed)`,
    upsell,
    hashtags,
  ].filter(l => l !== null).join('\n');
}

function hashMessage(message) {
  return crypto.createHash('sha256').update(message).digest('hex');
}

function telegramPost(token, chatId, text) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: false });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(raw); } catch (e) { return reject(new Error(`Telegram not JSON: ${raw.slice(0,200)}`)); }
        if (json.ok) {
          resolve(json.result);
        } else {
          const err = new Error(`Telegram error ${json.error_code}: ${json.description}`);
          err.retryAfterSec = json.parameters?.retry_after ?? null;
          reject(err);
        }
      });
    });
    req.setTimeout(15_000, () => req.destroy(new Error('Telegram timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function run() {
  console.log(`\n[postToX] ${new Date().toISOString()}${DRY_RUN ? ' [DRY RUN]' : ''}`);

  const supabase = getSupabase();
  const telegram = getTelegramConfig();

  const postedIds = await loadPostedIds(supabase);
  const signals   = await fetchRecentSignals(supabase);

  console.log(`[postToX] ${signals.length} signal(s) fetched`);

  const validSignals = signals.filter(s => {
    const odds = parseFloat(s.detected_odds);
    const edge = parseFloat(s.detected_edge);
    if (!Number.isFinite(odds) || odds <= 1) { console.warn(`[postToX] skip ${s.id} — bad odds`); return false; }
    if (!Number.isFinite(edge)) { console.warn(`[postToX] skip ${s.id} — bad edge`); return false; }
    s.detected_odds = odds;
    s.detected_edge = edge;
    return true;
  });

  const toPost      = validSignals.filter(s => !postedIds.has(s.id));
  const alreadySeen = signals.length - toPost.length;
  console.log(`[postToX] ${toPost.length} new | ${alreadySeen} already posted`);

  // Conflict guard, applied within each broadcast set: keep only the
  // highest-edge pick per (match, market, line) so we never push two opposing
  // outcomes on the same match. Prime picks (paid channel) and value/longshot
  // picks (free channel) are de-duped independently. Losers are suppressed below.
  const dedupSet = (predTiers) => new Set(
    dedupeConflicts(toPost.filter(s =>
      !isInplay(s) && !isMover(s) && predTiers.includes(classifyTier(s).tier)))
      .map(s => s.id));
  const broadcastPrimeIds = dedupSet(['prime']);
  const broadcastFreeIds  = dedupSet(['value', 'longshot']);

  if (!toPost.length) { console.log('[postToX] nothing to post'); return { posted: 0, failed: 0, skipped: alreadySeen }; }

  if (!telegram && !DRY_RUN) {
    console.error('[postToX] no Telegram config — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID');
    return { posted: 0, failed: toPost.length, skipped: alreadySeen };
  }

  let posted = 0, failed = 0;

  let skippedNoChannel = 0;
  let skippedInfo      = 0;

  for (let i = 0; i < toPost.length; i++) {
    const signal  = toPost[i];
    const { tier } = classifyTier(signal);
    const label   = isInplay(signal) ? 'IN-PLAY'
                  : isMover(signal) ? 'ODDS_MOVE'
                  : (tier ? tier.toUpperCase() : 'BELOW_FLOOR');
    const home    = signal.match?.home_team?.name ?? '?';
    const away    = signal.match?.away_team?.name ?? '?';
    const message     = buildMessage(signal);
    const messageHash = hashMessage(message);
    const chatId      = telegram ? chatIdForSignal(telegram, signal) : telegram;

    // Conflict guard: a pre-match pick that lost the per-(match,market,line)
    // tie-break to a higher-edge opposing pick is suppressed so the two can't
    // cancel out — enforced per channel (Prime→paid set, value/longshot→free
    // set). In-play and odds-movement alerts bypass this (own logic). Below-floor
    // picks (tier null) fall through to the no-channel skip below.
    if (!isInplay(signal) && !isMover(signal)) {
      const lostPrime = tier === 'prime' && !broadcastPrimeIds.has(signal.id);
      const lostFree  = (tier === 'value' || tier === 'longshot') && !broadcastFreeIds.has(signal.id);
      if (lostPrime || lostFree) {
        console.log(`\n[postToX] skip (${label} conflict, lower edge) — ${home} vs ${away} (${signal.outcome.toUpperCase()})`);
        await markPosted(supabase, signal.id, messageHash, null);
        skippedInfo++;
        continue;
      }
    }

    console.log(`\n[postToX] ${label} — ${home} vs ${away} (${signal.outcome.toUpperCase()})`);
    console.log(message);

    if (DRY_RUN) { await markPosted(supabase, signal.id, messageHash, null); posted++; continue; }

    // No destination for this tier/phase → skip silently. Covers: in-play with
    // no in-play channel (don't leak live picks), value/longshot with no free
    // channel provisioned, and below-floor picks. Mark posted so they aren't
    // retried every run.
    if (!chatId) {
      console.log(`[postToX] no channel for ${label} (phase=${signal.phase}) — skipping`);
      await markPosted(supabase, signal.id, messageHash, null);
      skippedNoChannel++;
      continue;
    }

    try {
      const res = await telegramPost(telegram.token, chatId, message);
      console.log(`[postToX] posted — message id: ${res.message_id}`);
      await markPosted(supabase, signal.id, messageHash, String(res.message_id));
      posted++;
    } catch (err) {
      console.error(`[postToX] failed: ${err.message}`);
      if (err.retryAfterSec) await new Promise(r => setTimeout(r, (err.retryAfterSec + 1) * 1000));
      failed++;
    }

    if (i < toPost.length - 1) await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\n[postToX] done —`, { posted, failed, skipped: alreadySeen, no_channel: skippedNoChannel, info_only: skippedInfo });
  return { posted, failed, skipped: alreadySeen, no_channel: skippedNoChannel, info_only: skippedInfo };
}

if (require.main === module) {
  run().catch(err => { console.error('[postToX] fatal:', err.message); process.exit(1); });
}

module.exports = { run, buildMessage, isSuggested, isMover, isInplay, chatIdForSignal };
