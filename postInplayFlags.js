'use strict';

/**
 * postInplayFlags — posts the /in-play tracker's flags to the Plus-only
 * #in-play Discord channel as they appear. See lib/inplayFlags for the rules.
 *
 * ── IT POLLS ITSELF ─────────────────────────────────────────────────────────
 *
 * GitHub's cron is a request, not a promise: engine.yml asks for every 15
 * minutes and gets a median of 34. So one run stays alive for LOOP_MIN minutes
 * taking a pass every POLL_SEC seconds, and the cron only has to make sure a
 * run exists. A pass first asks the cheap gate (/api/inplay/live, one count,
 * no upstream call) and stops the run when nothing is in play.
 *
 * ── ONE POST PER FLAG, EVEN ACROSS CRASHES ──────────────────────────────────
 *
 * The ledger row is CLAIMED before the post goes out (primary key on match +
 * flag). A well-formed 4xx from Discord proves nothing was sent, so the claim
 * is released; a timeout proves nothing either way, so it stands. One withheld
 * post beats one duplicate, the same contract postToDiscord keeps.
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   DISCORD_WEBHOOK_INPLAY       the #in-play channel's webhook (secret)
 *   DISCORD_POSTING_ENABLED      must be exactly '1', the shared kill switch
 *   INPLAY_FLAGS_LOOP_MIN        how long one run lives (default 25)
 *   INPLAY_FLAGS_POLL_SEC        seconds between passes (default 180)
 *   INPLAY_FLAGS_CARD            '0' posts text only (default: square image card)
 *   X_INPLAY_ENABLED             '1' also posts the alert flags to X (own switch)
 *   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET
 *   X_INPLAY_DAILY_CAP           X posts per UK day (default 6)
 *   X_INPLAY_LEAGUES             API-Football league ids for X (default: 14 leagues, see lib/inplayFlagsX)
 *   SITE_URL                     default https://www.maxedge.live
 *   DRY_RUN=1                    read and print, post nothing, write nothing
 */

const { createClient } = require('@supabase/supabase-js');
const { postWebhook, postWebhookFiles, channelEnabled } = require('./lib/discordClient');
const { flagCard } = require('./lib/discordCards');
const { newFlags, flagPost, withCard } = require('./lib/inplayFlags');
const { xEligible, xFlagText, leaguesFrom, FRAMES } = require('./lib/inplayFlagsX');
const { postTweet, uploadImage, getXConfig } = require('./lib/xClient');
const { mayPost } = require('./lib/xGuard');

/** X has its own switch: X_INPLAY_ENABLED must be exactly '1'. Fails closed. */
const xEnabled = () => process.env.X_INPLAY_ENABLED === '1';
const X_DAILY_CAP = Number(process.env.X_INPLAY_DAILY_CAP) || 6;
const X_MAX_PER_PASS = 2;

/** Card off with INPLAY_FLAGS_CARD=0; any other value (or unset) draws it. */
const CARD_ON = process.env.INPLAY_FLAGS_CARD !== '0';

/**
 * Post the square card with the embed; if the card cannot be drawn, post the
 * text embed alone. A failed render must never cost the post itself.
 */
async function send(webhook, match, flag, payload) {
  if (!CARD_ON) return postWebhook(webhook, payload);
  let png = null;
  try { png = await flagCard(match, flag); }
  catch (e) { console.log(`[inplayFlags] card render failed (${e.message}), posting text only`); }
  if (!png) return postWebhook(webhook, payload);
  return postWebhookFiles(webhook, withCard(payload, 'flag.png'), [{
    name: 'flag.png', data: png, type: 'image/png',
    description: `${match.homeTeam} ${match.homeGoals}-${match.awayGoals} ${match.awayTeam}. ${flag.title}. ${flag.detail ?? ''}`,
  }]);
}

const SITE_URL = (process.env.SITE_URL || 'https://www.maxedge.live').replace(/\/$/, '');
const LOOP_MIN = Number(process.env.INPLAY_FLAGS_LOOP_MIN) || 25;
const POLL_SEC = Math.max(60, Number(process.env.INPLAY_FLAGS_POLL_SEC) || 180);
const MAX_POSTS_PER_PASS = 15;
const DRY_RUN = process.env.DRY_RUN === '1';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(path) {
  const res = await fetch(`${SITE_URL}${path}`, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'maxedge-inplay-flags' } });
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
  return res.json();
}

async function postedFor(supabase, matchIds) {
  const map = new Map();
  if (!matchIds.length) return map;
  const { data, error } = await supabase.from('inplay_flag_posts')
    .select('match_id, flag_key').in('match_id', matchIds);
  if (error) throw new Error(`inplay_flag_posts read: ${error.message}`);
  for (const r of data ?? []) {
    if (!map.has(r.match_id)) map.set(r.match_id, new Set());
    map.get(r.match_id).add(r.flag_key);
  }
  return map;
}

async function pass(supabase, webhook, { discord = true, x = false } = {}) {
  const gate = await getJson('/api/inplay/live');
  if (!gate?.live) return { live: false, posted: 0 };

  const board = await getJson('/api/inplay');
  const tracker = Array.isArray(board?.tracker) ? board.tracker : [];
  const posted = await postedFor(supabase, tracker.map(m => m.id));
  const todo = discord ? newFlags(tracker, posted).slice(0, MAX_POSTS_PER_PASS) : [];
  console.log(`[inplayFlags] ${tracker.length} live match(es), ${todo.length} new flag(s)`);

  let sent = 0;
  for (const { match, flag, key } of todo) {
    const payload = flagPost(match, flag);
    if (DRY_RUN) { console.log(JSON.stringify({ key, ...payload.embeds[0] })); continue; }

    const { error: claimErr } = await supabase.from('inplay_flag_posts').insert({ match_id: match.id, flag_key: key });
    if (claimErr) {
      if (/duplicate key/.test(claimErr.message)) continue;   // another run got it
      throw new Error(`inplay_flag_posts claim: ${claimErr.message}`);
    }
    try {
      const res = await send(webhook, match, flag, payload);
      sent++;
      if (res?.message_id) {
        await supabase.from('inplay_flag_posts').update({ external_msg_id: res.message_id })
          .eq('match_id', match.id).eq('flag_key', key);
      }
    } catch (e) {
      if (e.discordRejected) {
        await supabase.from('inplay_flag_posts').delete().eq('match_id', match.id).eq('flag_key', key);
      }
      console.log(`[inplayFlags] post failed (${e.message}) for ${match.homeTeam} v ${match.awayTeam} ${key}`);
    }
  }
  if (x) {
    try { sent += await xPass(supabase, tracker); }
    catch (e) { console.log(`[inplayFlags:x] pass failed: ${e.message}`); }   // X never stops Discord
  }
  return { live: true, posted: sent };
}

// ── X ───────────────────────────────────────────────────────────────────────

const ukDayStart = (now = new Date()) => {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(now);
  const off = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'shortOffset' })
    .formatToParts(now).find(p => p.type === 'timeZoneName')?.value.replace('GMT', '') || '+0';
  const [h, mm = '0'] = off.split(':');
  const sign = h.startsWith('-') ? '-' : '+';
  return new Date(`${d}T00:00:00${sign}${String(Math.abs(Number(h))).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
};

async function xLedger(supabase, matchIds) {
  const posted = new Map();
  if (matchIds.length) {
    const { data, error } = await supabase.from('inplay_flag_x_posts').select('match_id, flag_key').in('match_id', matchIds);
    if (error) throw new Error(`inplay_flag_x_posts read: ${error.message}`);
    for (const r of data ?? []) {
      if (!posted.has(r.match_id)) posted.set(r.match_id, new Set());
      posted.get(r.match_id).add(r.flag_key);
    }
  }
  const { count, error: cErr } = await supabase.from('inplay_flag_x_posts')
    .select('match_id', { count: 'exact', head: true }).gte('posted_at', ukDayStart().toISOString());
  if (cErr) throw new Error(`inplay_flag_x_posts count: ${cErr.message}`);
  const { data: recent, error: rErr } = await supabase.from('inplay_flag_x_posts')
    .select('skeleton').order('posted_at', { ascending: false }).limit(8);
  if (rErr) throw new Error(`inplay_flag_x_posts recent: ${rErr.message}`);
  return { posted, today: count ?? 0, recent: (recent ?? []).map(r => r.skeleton).filter(Boolean) };
}

async function leagueIds(supabase, matchIds) {
  const map = new Map();
  if (!matchIds.length) return map;
  const { data, error } = await supabase.from('matches').select('id, league:leagues ( external_id )').in('id', matchIds);
  if (error) throw new Error(`matches league read: ${error.message}`);
  for (const r of data ?? []) map.set(r.id, r.league?.external_id ?? null);
  return map;
}

/** The first frame (rotating from `start`) the similarity guard accepts. */
function pickText(match, flag, start, ctx) {
  for (let k = 0; k < FRAMES.length; k++) {
    const text = xFlagText(match, flag, start + k);
    const verdict = mayPost({ text, recentSkeletons: ctx.recent, postedToday: ctx.today,
      env: { ...process.env, X_POSTING_ENABLED: '1', X_DAILY_CAP: String(X_DAILY_CAP) } });
    if (verdict.ok) return { text, skeleton: verdict.skeleton };
    if (verdict.reason !== 'too-similar') return { refused: verdict.reason };
  }
  return { refused: 'too-similar' };
}

async function xPass(supabase, tracker) {
  const ids = tracker.map(m => m.id);
  const [ctx, leagues] = await Promise.all([xLedger(supabase, ids), leagueIds(supabase, ids)]);
  if (ctx.today >= X_DAILY_CAP) { console.log(`[inplayFlags:x] daily cap ${ctx.today}/${X_DAILY_CAP}`); return 0; }
  const allowed = leaguesFrom();
  const todo = newFlags(tracker, ctx.posted)
    .filter(({ match, flag }) => xEligible(flag, leagues.get(match.id), allowed))
    .slice(0, X_MAX_PER_PASS);
  console.log(`[inplayFlags:x] ${todo.length} flag(s) for X, ${ctx.today}/${X_DAILY_CAP} today`);

  let sent = 0;
  for (const { match, flag, key } of todo) {
    if (ctx.today >= X_DAILY_CAP) break;
    const pick = pickText(match, flag, ctx.today, ctx);
    if (!pick.text) { console.log(`[inplayFlags:x] refused (${pick.refused}) ${key}`); continue; }
    if (DRY_RUN) { console.log(`[inplayFlags:x] would post:\n${pick.text}`); continue; }

    let png;
    try { png = await flagCard(match, flag); }
    catch (e) { console.log(`[inplayFlags:x] card failed (${e.message}), skipping X for ${key}`); continue; }

    const { error: claimErr } = await supabase.from('inplay_flag_x_posts')
      .insert({ match_id: match.id, flag_key: key, skeleton: pick.skeleton });
    if (claimErr) {
      if (/duplicate key/.test(claimErr.message)) continue;
      throw new Error(`inplay_flag_x_posts claim: ${claimErr.message}`);
    }
    try {
      const mediaId = await uploadImage(png);
      const res = await postTweet(pick.text, { mediaIds: [mediaId] });
      sent++; ctx.today++; ctx.recent.unshift(pick.skeleton);
      await supabase.from('inplay_flag_x_posts').update({ external_msg_id: res.message_id })
        .eq('match_id', match.id).eq('flag_key', key);
    } catch (e) {
      // A refusal (bad key, 429, failed upload) proves nothing went out:
      // release the claim. A timeout proves nothing either way: keep it.
      if (e.xRejected) {
        await supabase.from('inplay_flag_x_posts').delete().eq('match_id', match.id).eq('flag_key', key);
      }
      console.log(`[inplayFlags:x] failed (${e.message}) for ${match.homeTeam} v ${match.awayTeam} ${key}`);
      if (e.status === 401 || e.status === 403) break;   // credentials: stop trying this pass
    }
  }
  return sent;
}

async function run() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  const webhook = process.env.DISCORD_WEBHOOK_INPLAY;
  const discord = DRY_RUN || (channelEnabled() && !!webhook);
  let x = xEnabled();
  if (x && !DRY_RUN) {
    try { getXConfig(); } catch (e) { console.log(`[inplayFlags:x] ${e.message}, X off this run`); x = false; }
  }
  if (!discord && !x) { console.log('[inplayFlags] neither Discord nor X is switched on, nothing to do'); return; }

  const supabase = createClient(url, key);
  const deadline = Date.now() + LOOP_MIN * 60 * 1000;
  let total = 0;
  for (;;) {
    const r = await pass(supabase, webhook, { discord, x });
    total += r.posted;
    if (!r.live) { console.log('[inplayFlags] nothing in play, stopping'); break; }
    if (DRY_RUN || Date.now() + POLL_SEC * 1000 > deadline) break;
    await sleep(POLL_SEC * 1000);
  }
  console.log(`[inplayFlags] done: ${total} posted`);
}

if (require.main === module) {
  run().catch(e => { console.error(e.message || e); process.exit(1); });
}

module.exports = { run, pass, xPass, pickText, ukDayStart };
