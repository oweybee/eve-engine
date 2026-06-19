/**
 * MaxEdge — Automated Signal Posting (Telegram + X)
 *
 * Posts VALUE and RUBY signals to Telegram channel as they're detected.
 * X posting is wired up but skipped unless X credentials are valid (requires X Basic plan).
 *
 * Usage:  export $(cat .env | xargs) && node postToX.js
 * Dry run: DRY_RUN=1 export $(cat .env | xargs) && node postToX.js
 *
 * Signal tiers:
 *   VALUE  — edge ≥ 2%   (⚡)
 *   RUBY   — edge ≥ 8%   (◆) — scarce, elite-confidence signals
 */
'use strict';

const https = require('https');
const { createClient } = require('@supabase/supabase-js');
const fs   = require('fs');
const path = require('path');

const STATE_FILE         = path.join(__dirname, '.x_state.json');
const MAX_SIGNAL_AGE_HOURS = parseInt(process.env.X_MAX_AGE_HOURS ?? '4', 10);
const DRY_RUN            = process.env.DRY_RUN === '1';

// ── Clients ───────────────────────────────────────────────────────────────────

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

// ── State: which signal IDs have already been posted ─────────────────────────

function loadPostedIds() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).posted ?? {};
  } catch {
    return {};
  }
}

function savePostedIds(posted) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const pruned = Object.fromEntries(
    Object.entries(posted).filter(([, ts]) => new Date(ts).getTime() > cutoff)
  );
  fs.writeFileSync(STATE_FILE, JSON.stringify({ posted: pruned }, null, 2));
}

// ── Data fetching ─────────────────────────────────────────────────────────────

async function fetchRecentSignals(supabase) {
  const since        = new Date(Date.now() - MAX_SIGNAL_AGE_HOURS * 60 * 60 * 1000).toISOString();
  const kickoffFloor = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('value_signals')
    .select(`
      id, outcome, detected_odds, detected_edge, detected_mes, bookmaker, kickoff_at, detected_at,
      match:matches (
        home_team:teams!matches_home_team_id_fkey ( name ),
        away_team:teams!matches_away_team_id_fkey ( name ),
        league:leagues ( name )
      )
    `)
    .gte('detected_at', since)
    .gte('kickoff_at', kickoffFloor)
    .order('detected_at', { ascending: true });

  if (error) throw new Error(`fetchRecentSignals: ${error.message}`);
  return data ?? [];
}

// ── Message formatting ────────────────────────────────────────────────────────

function isRuby(detectedEdge) {
  return Number(detectedEdge) >= 0.08;
}

function formatKickoff(isoStr) {
  if (!isoStr) return 'TBC';
  const d      = new Date(isoStr);
  const days   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hh     = String(d.getUTCHours()).padStart(2, '0');
  const mm     = String(d.getUTCMinutes()).padStart(2, '0');
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${hh}:${mm} UTC`;
}

function buildMessage(signal) {
  const home    = signal.match?.home_team?.name ?? 'Home';
  const away    = signal.match?.away_team?.name ?? 'Away';
  const league  = signal.match?.league?.name ?? '';
  const outcome = signal.outcome.toUpperCase();
  const odds    = Number(signal.detected_odds).toFixed(2);
  const edgePct = (Number(signal.detected_edge) * 100).toFixed(1);
  const mes     = signal.detected_mes != null ? ` | MES: ${signal.detected_mes}/100` : '';
  const book    = signal.bookmaker ?? 'Best price';
  const kickoff = formatKickoff(signal.kickoff_at);
  const ruby    = isRuby(signal.detected_edge);

  const lines = ruby
    ? [
        `◆ *RUBY SIGNAL*`,
        ``,
        `*${home} vs ${away}*`,
        league ? `_${league}_` : null,
        `${outcome} @ ${odds} (${book})`,
        `Edge: +${edgePct}%${mes}`,
        ``,
        `⏱ Kickoff: ${kickoff}`,
        ``,
        `[View on MaxEdge](https://maxedge.live/feed)`,
        `#MaxEdge #Ruby #ValueBet`,
      ]
    : [
        `⚡ *VALUE SIGNAL*`,
        ``,
        `*${home} vs ${away}*`,
        league ? `_${league}_` : null,
        `${outcome} @ ${odds} (${book})`,
        `Edge: +${edgePct}%${mes}`,
        ``,
        `⏱ Kickoff: ${kickoff}`,
        ``,
        `[View on MaxEdge](https://maxedge.live/feed)`,
        `#MaxEdge #ValueBet`,
      ];

  return lines.filter(l => l !== null).join('\n');
}

// ── Telegram posting ──────────────────────────────────────────────────────────

function telegramPost(token, chatId, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: false });
    const req  = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        const json = JSON.parse(raw);
        if (json.ok) resolve(json.result);
        else reject(new Error(`Telegram error ${json.error_code}: ${json.description}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n[postToX] ${new Date().toISOString()}${DRY_RUN ? ' [DRY RUN]' : ''}`);

  const supabase  = getSupabase();
  const telegram  = getTelegramConfig();
  const postedIds = loadPostedIds();
  const signals   = await fetchRecentSignals(supabase);

  console.log(`[postToX] ${signals.length} signal(s) in last ${MAX_SIGNAL_AGE_HOURS}h`);

  const toPost     = signals.filter(s => !postedIds[s.id]);
  const alreadySeen = signals.length - toPost.length;

  console.log(`[postToX] ${toPost.length} new | ${alreadySeen} already posted`);

  if (!toPost.length) {
    console.log('[postToX] nothing to post — done');
    return { posted: 0, failed: 0, skipped: alreadySeen };
  }

  if (!telegram && !DRY_RUN) {
    console.error('[postToX] no posting channel configured — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID');
    return { posted: 0, failed: toPost.length, skipped: alreadySeen };
  }

  let posted = 0;
  let failed = 0;

  for (let i = 0; i < toPost.length; i++) {
    const signal  = toPost[i];
    const label   = isRuby(signal.detected_edge) ? 'RUBY' : 'VALUE';
    const home    = signal.match?.home_team?.name ?? '?';
    const away    = signal.match?.away_team?.name ?? '?';
    const message = buildMessage(signal);

    console.log(`\n[postToX] ${label} — ${home} vs ${away} (${signal.outcome.toUpperCase()})`);
    console.log('─'.repeat(50));
    console.log(message);
    console.log('─'.repeat(50));

    if (DRY_RUN) {
      postedIds[signal.id] = new Date().toISOString();
      posted++;
      continue;
    }

    try {
      const res = await telegramPost(telegram.token, telegram.chatId, message);
      console.log(`[postToX] ✓ posted — message id: ${res.message_id}`);
      postedIds[signal.id] = new Date().toISOString();
      posted++;
    } catch (err) {
      console.error(`[postToX] ✗ failed: ${err.message}`);
      failed++;
    }

    if (i < toPost.length - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  savePostedIds(postedIds);

  const summary = { posted, failed, skipped: alreadySeen };
  console.log(`\n[postToX] done —`, summary);
  return summary;
}

if (require.main === module) {
  run().catch(err => {
    console.error('[postToX] fatal:', err.message);
    process.exit(1);
  });
}

module.exports = { run, buildMessage, isRuby };
