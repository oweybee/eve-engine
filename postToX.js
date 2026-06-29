/**
 * MaxEdge — Automated Signal Posting (Telegram)
 *
 * Signal tiers:
 *   PRICE MOVEMENT — signal_category='PriceMove' (odds shifted on a live value bet)
 *   VALUE          — edge >= 0.5%
 *   RUBY           — edge >= 8%
 */
'use strict';

const https  = require('https');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const DRY_RUN = process.env.DRY_RUN === '1';
const CHANNEL = 'telegram';
const RUN_ID  = process.env.GITHUB_RUN_ID ?? 'local';

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key);
}

function getTelegramConfig() {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return null;
  return { token, chatId };
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
      id, outcome, detected_odds, detected_edge, detected_mes, bookmaker,
      kickoff_at, detected_at, signal_category,
      match:matches (
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

function isRuby(edge) { return Number(edge) >= 0.08; }
function isPriceMove(signal) { return signal.signal_category === 'PriceMove'; }

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

  let header, hashtags;
  if (isPriceMove(signal)) {
    header   = `>> *ODDS MOVEMENT*`;
    hashtags = `#MaxEdge #OddsMove`;
  } else if (isRuby(signal.detected_edge)) {
    header   = `◆ *RUBY SIGNAL*`;
    hashtags = `#MaxEdge #Ruby #ValueBet`;
  } else {
    header   = `⚡ *VALUE SIGNAL*`;
    hashtags = `#MaxEdge #ValueBet`;
  }

  return [
    header, ``,
    `*${home} vs ${away}*`,
    league ? `_${league}_` : null,
    `${outcome} @ ${odds} (${book})`,
    `Edge: +${edgePct}%${mes}`,
    ``,
    `Kickoff: ${kickoff}`,
    ``,
    `[View on MaxEdge](https://maxedge.live/feed)`,
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

  if (!toPost.length) { console.log('[postToX] nothing to post'); return { posted: 0, failed: 0, skipped: alreadySeen }; }

  if (!telegram && !DRY_RUN) {
    console.error('[postToX] no Telegram config — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID');
    return { posted: 0, failed: toPost.length, skipped: alreadySeen };
  }

  let posted = 0, failed = 0;

  for (let i = 0; i < toPost.length; i++) {
    const signal  = toPost[i];
    const label   = isPriceMove(signal) ? 'PRICE_MOVE' : isRuby(signal.detected_edge) ? 'RUBY' : 'VALUE';
    const home    = signal.match?.home_team?.name ?? '?';
    const away    = signal.match?.away_team?.name ?? '?';
    const message     = buildMessage(signal);
    const messageHash = hashMessage(message);

    console.log(`\n[postToX] ${label} — ${home} vs ${away} (${signal.outcome.toUpperCase()})`);
    console.log(message);

    if (DRY_RUN) { await markPosted(supabase, signal.id, messageHash, null); posted++; continue; }

    try {
      const res = await telegramPost(telegram.token, telegram.chatId, message);
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

  console.log(`\n[postToX] done —`, { posted, failed, skipped: alreadySeen });
  return { posted, failed, skipped: alreadySeen };
}

if (require.main === module) {
  run().catch(err => { console.error('[postToX] fatal:', err.message); process.exit(1); });
}

module.exports = { run, buildMessage, isRuby, isPriceMove };
