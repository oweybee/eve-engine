/**
 * MaxEdge — Automated Signal Posting (Telegram)
 *
 * Broadcast policy (pre-match): a post goes out only when BOTH ladders agree.
 * The eligibility ladder has to suggest the selection — the back-tested sweet
 * spot of odds 1.40–3.00 with a 4–10% edge — and the conviction ladder has to
 * put it on PRIME, meaning MXS >= 65. That is exactly what the site requires
 * before it prints ◆ PRIME on a row, so the word means one thing in both places.
 *
 *   BACKED SIGNAL  — suggested by the ladder AND scored at or above the
 *                    backing line. The only
 *                    broadcast bucket, and the only place this word is used.
 *   ODDS MOVEMENT  — is_mover=true (odds shifted on an existing signal)
 *   IN-PLAY        — phase='inplay', routed to the dedicated in-play channel
 *
 * WHY THE SECOND CONDITION EXISTS (6 Aug 2026). This channel used to take PRIME
 * from `classifyTier` alone, which is the ELIGIBILITY ladder. After the
 * vocabulary unified, PRIME became a rung of the CONVICTION ladder, so a post
 * could go out reading PRIME for a selection the site badges WATCH — the
 * collision escaping the product entirely, to the one audience that cannot click
 * through and check. The engine now writes `mxs_band` at detection
 * (lib/maxedge.js), so the broadcast can read the same verdict the badge does
 * instead of asserting one.
 *
 * A SIGNAL WITH NO SCORE IS NOT BROADCAST, and that is a policy choice worth
 * knowing. An architecture with no row in `model_calibration` scores null, and a
 * null is not PRIME. Silence is the correct output for "we could not measure
 * this" — the alternative is a post that names a rung nobody computed.
 *
 * IT READS THE STORED VERDICT NOW, WHICH IS WHAT THE PARAGRAPH ABOVE ALWAYS
 * CLAIMED. `fetchRecentSignals` did not select `mxs` or `mxs_band`, so
 * `signal.mxs ?? recompute(signal)` took the right-hand branch on EVERY row and
 * the broadcast asserted its own score after all — the stored one it was written
 * to read was never fetched. Both are on the select list as of 7 Aug 2026, along
 * with `gap_basis`, without which a legacy row cannot be told from a current one.
 */
'use strict';

const https  = require('https');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { formatLiveState } = require('./lib/inplay');
const { classifyTier, dedupeConflicts, isBacked } = require('./lib/signalTier');
const { scoreSignal } = require('./lib/maxedge');
const { isPublished, withheldReason } = require('./lib/publication');

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
  const token        = process.env.TELEGRAM_BOT_TOKEN;
  const chatId       = process.env.TELEGRAM_CHAT_ID;
  const inplayChatId = process.env.TELEGRAM_INPLAY_CHAT_ID || null;
  if (!token || !chatId) return null;
  return { token, chatId, inplayChatId };
}

/**
 * Which chat a signal goes to. In-play signals route to the dedicated in-play
 * channel; if that channel isn't configured they are NOT posted (rather than
 * spamming the pre-match channel with live picks). Pre-match → main channel.
 */
function chatIdForSignal(telegram, signal) {
  if (signal.phase === 'inplay') return telegram.inplayChatId; // null ⇒ skip
  return telegram.chatId;
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
      kickoff_at, detected_at, signal_category, is_mover, phase, model_architecture,
      model_prob, market_prob, prob_gap, mxs, mxs_band, gap_basis,
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

  // THE PUBLICATION GATE (lib/publication.js). Every one of the 369 signals in
  // the record reached subscribers through this function, and 285 of them came
  // from architectures the 2026-08-05 audit found were not forecasting
  // anything — -98.9 units over 338 settled bets. Filtering HERE rather than at
  // the call sites is deliberate: this is the only door out of the database and
  // into a channel, so a future caller cannot forget the gate exists.
  const rows = data ?? [];
  const backed = rows.filter(r => isPublished(r.model_architecture));
  if (backed.length !== rows.length) {
    const byArch = new Map();
    for (const r of rows) {
      if (isPublished(r.model_architecture)) continue;
      const k = r.model_architecture ?? '(null)';
      byArch.set(k, (byArch.get(k) ?? 0) + 1);
    }
    for (const [arch, count] of byArch) {
      console.log(`[postToX] withheld ${count} ${arch} signal(s): ${withheldReason(arch)}`);
    }
  }
  return backed;
}

function isMover(signal) { return signal.is_mover === true; }
function isInplay(signal) { return signal.phase === 'inplay'; }
/** Pre-match selections the eligibility ladder suggests. */
function isSuggested(signal) { return classifyTier(signal).suggested; }

/**
 * Recompute a row's verdict, but ONLY when the row is on the current convention.
 *
 * SINCE MIGRATION 058 THERE ARE TWO. A row detected before 7 Aug 2026 carries
 * `market_prob = 1 / detected_odds` and `gap_basis = 'implied'`; a row detected
 * after carries the Shin-de-vigged probability and `gap_basis = 'devigged'`.
 * Both are finite numbers in (0,1), so `scoreSignal` cannot tell them apart on
 * its own — handed a legacy row it would happily produce a score under the OLD
 * convention and pass it to the broadcast gate as though it meant the same
 * thing. That is exactly the mixing `gap_basis` exists to prevent, so the check
 * lives here rather than in the reader's head.
 *
 * A row that cannot be re-scored is not broadcast. It is history: its match has
 * almost always kicked off, and a signal we cannot score under the convention we
 * currently publish is not one to put in the channel.
 */
function rescore(signal) {
  if (signal?.gap_basis !== 'devigged') return { mxs: null, mxs_band: null };
  return scoreSignal(signal);
}

/**
 * The conviction rung for a signal — the stored one where the engine wrote it,
 * recomputed from the row otherwise so a backfilled signal on the current
 * convention is not silently unbroadcastable. Same formula either way
 * (lib/maxedge.js).
 */
function bandOf(signal) {
  return signal.mxs_band ?? rescore(signal).mxs_band;
}

/**
 * Both ladders agree: suggested by the price+edge box AND scored at or above the
 * backing line.
 *
 * THIS READS `isBacked`, NOT `band === 'PRIME'`, AND THE DIFFERENCE IS THE WHOLE
 * CHANNEL. When the ladder went to six rungs on 6 Aug 2026, PRIME moved from 65
 * (1σ) to 88 (2σ) and STRONG took the 65 line. A name comparison left here would
 * have quietly raised the broadcast threshold from 1σ to 2σ — ten rows in the
 * entire database clear 88 — and the channel would have gone almost silent with
 * nothing in the diff that looked like a threshold change.
 *
 * ON 21 Aug 2026 IT WENT BACK TO FIVE and PRIME re-took the 65 line (migration
 * 089), which is the same lesson from the other side: a name comparison written
 * today would be correct today and wrong the next time a word moves. The line
 * has been 65 throughout both re-cuts. Read the line.
 */
function isBroadcastable(signal) {
  const mxs = signal.mxs ?? rescore(signal).mxs;
  return isSuggested(signal) && isBacked(mxs);
}

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
  // detected_mes is null on every row the engine writes now (§2.4 — the
  // frontend's risk-adjusted computeMes is the single implementation), so this
  // renders nothing rather than a number nobody can reconcile with the board.
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
  if (isMover(signal)) {
    header   = `>> *ODDS MOVEMENT*`;
    hashtags = `#MaxEdge #OddsMove`;
  } else {
    const { tier, notable } = classifyTier(signal);
    const band = bandOf(signal);
    const mxs  = signal.mxs ?? rescore(signal).mxs;
    if (tier === 'prime' && isBacked(mxs)) {
      // NOT "PRIME SIGNAL" ANY MORE, AND NOT BECAUSE THE GATE MOVED.
      //
      // The gate is unchanged — the ladder must suggest it AND the score must
      // clear the backing line — but the word was wrong twice over. `isBacked`
      // admits STRONG as well as PRIME, so a row the site badges ◈ STRONG went
      // out of here headed PRIME, which is the exact drift the 6 Aug
      // unification was for. And PRIME itself is capped at publication
      // (lib/maxedge.ts, migration 064): no row on the current de-vigged basis
      // has ever scored above 77, every 85+ score in the history came from the
      // legacy `implied` basis, and the 88 cutoff sits inside a band — 85 to 91
      // — that nothing occupies.
      //
      // So the post names the rung it actually scored and makes no claim above
      // it. The score and the band still go out; it is the headline that stops
      // asserting a rung the platform has not earned.
      header   = `🟢 *BACKED SIGNAL*`;
      note     = `_Our backed tier — the ladder suggests it and it scores ${mxs}/100 (${band})_`;
      hashtags = `#MaxEdge #Backed #ValueBet`;
    } else if (tier === 'longshot') {
      // A fact about the price, not a rung: every settled bet at 3.00+ lost.
      header   = notable ? `🎯 *LONGSHOT · NOTABLE EDGE*` : `🎯 *LONGSHOT*`;
      note     = `_For information only — not a suggested selection_`;
      hashtags = `#MaxEdge #Longshot`;
    } else {
      // Positive EV outside the band we back at — shown as a tool, never
      // suggested. These do not reach the channel; the branch exists because
      // the message is built before the broadcast filter runs.
      header   = `⚡ *UNBACKED EDGE*`;
      note     = `_For information only — not a suggested selection_`;
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

  // Conflict guard: among the pre-match selections we'd broadcast this run, keep
  // only the highest-edge pick per (match, market, line) so we never push two
  // opposing outcomes on the same match. The rest are suppressed below.
  const broadcastableIds = new Set(
    dedupeConflicts(toPost.filter(s => !isInplay(s) && !isMover(s) && isBroadcastable(s)))
      .map(s => s.id));

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

    // Broadcast policy: pre-match, we only broadcast what the ladder suggests.
    // The wider edges and the longshots remain visible on the site but are
    // never pushed to the channel. Mark them posted so they aren't reconsidered every run. In-play
    // signals and odds-movement alerts bypass this — they have their own logic.
    if (!isInplay(signal) && !isMover(signal) && tier !== 'prime') {
      console.log(`\n[postToX] skip (${label}, not suggested) — ${home} vs ${away} (${signal.outcome.toUpperCase()})`);
      await markPosted(supabase, signal.id, messageHash, null);
      skippedInfo++;
      continue;
    }

    // Conflict guard: a suggested selection that lost the per-match/market
    // tie-break to a higher-edge opposing pick is suppressed so the two can't
    // cancel out.
    if (!isInplay(signal) && !isMover(signal) && isBroadcastable(signal) && !broadcastableIds.has(signal.id)) {
      console.log(`\n[postToX] skip (backed conflict, lower edge) — ${home} vs ${away} (${signal.outcome.toUpperCase()})`);
      await markPosted(supabase, signal.id, messageHash, null);
      skippedInfo++;
      continue;
    }

    console.log(`\n[postToX] ${label} — ${home} vs ${away} (${signal.outcome.toUpperCase()})`);
    console.log(message);

    if (DRY_RUN) { await markPosted(supabase, signal.id, messageHash, null); posted++; continue; }

    // In-play signal with no in-play channel configured → skip silently (don't
    // leak live picks into the pre-match channel). Mark posted so it isn't
    // retried every run.
    if (!chatId) {
      console.log(`[postToX] no channel for phase=${signal.phase} — skipping`);
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

module.exports = { run, buildMessage, isSuggested, isBroadcastable, bandOf, isMover, isInplay, chatIdForSignal };
