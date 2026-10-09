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
 *   node postToDiscord.js signals   PRIME/EDGE to the #signals forum the moment
 *                                   they are detected. #signals is visible to
 *                                   Plus members only (a Discord permission,
 *                                   not a code path): no delays, no early tier.
 *                                   Every Plus member sees the same post at the
 *                                   same time, which is the owner's rule.
 *   node postToDiscord.js results   Every settled signal that went out, win or
 *                                   loss, to #results and back into its thread.
 *   node postToDiscord.js weekly    The record card from performance_band.
 *   node postToDiscord.js trends    #hit-rates: goals form for the next 24h of
 *                                   fixtures (settled scores only, no prices).
 *   node postToDiscord.js edge      #edge-table: clubs against their own
 *                                   closing prices this season (weekly).
 *   node postToDiscord.js movers    #market-pulse: biggest median 1X2 price
 *                                   moves, open vs now. Never names a best
 *                                   book, a fair price or a gap.
 *
 * ── LEDGER CHANNELS (posted_signals.channel) ────────────────────────────────
 *
 *   discord          the #signals forum post (external_msg_id = thread id)
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
 *   DISCORD_WEBHOOK_SIGNALS              #signals (a FORUM channel, Plus only)
 *   DISCORD_WEBHOOK_RESULTS              #results
 *   DISCORD_WEBHOOK_RECORD               #weekly-record
 *   DISCORD_WEBHOOK_HITRATES             #hit-rates
 *   DISCORD_WEBHOOK_PULSE                #market-pulse
 *   DISCORD_WEBHOOK_EDGE                 #edge-table
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
const { postWebhook, postWebhookFiles, deleteWebhookMessage, channelEnabled } = require('./lib/discordClient');
const { trendsPost, trendSections, moversPost, moverRows, edgePost, edgeFinding } = require('./lib/discordDigest');
const { trendsCard, moversCard, edgeCard } = require('./lib/discordCards');
const { edgeSummary, divisionLabel } = require('./lib/edgeTable');
const { pageAll, inChunks } = require('./lib/pagedRead');

const DRY_RUN = process.env.DRY_RUN === '1';
// An unset GitHub `vars.X` arrives as an EMPTY STRING, and Number('') is 0:
// a 0 cap would silence the channel. So blank and non-numeric both mean "use
// the default".
function numEnv(name, fallback) {
  const v = Number(process.env[name]);
  return process.env[name]?.trim() && Number.isFinite(v) ? v : fallback;
}
const DAILY_CAP = numEnv('DISCORD_DAILY_CAP', 12);
const MIN_LEAD_MIN = 10;    // never post a public signal inside 10 min of kick-off

const LEDGER = { SIGNAL: 'discord', RESULT: 'discord-result' };

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

/** Which signals post on this run. Pure, so it can be tested. */
function plan(signals, now = Date.now()) {
  return eligibleSignals(signals)
    .filter(s => (new Date(s.kickoff_at).getTime() - now) / 60000 > MIN_LEAD_MIN);
}

async function postedToday(supabase, channel) {
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  const { count, error } = await supabase.from('posted_signals')
    .select('id', { count: 'exact', head: true })
    .eq('channel', channel).gte('posted_at', start.toISOString());
  if (error) throw new Error(`postedToday: ${error.message}`);
  return count ?? 0;
}

async function sendBatch(supabase, rows, { channel, webhook, forum }) {
  if (!rows.length) return 0;
  if (!webhook) { console.log(`[postToDiscord] ${channel}: no webhook set, skipping`); return 0; }
  let sent = 0;
  let today = DRY_RUN ? 0 : await postedToday(supabase, channel);
  for (const s of rows) {
    if (today >= DAILY_CAP) { console.log(`[postToDiscord] ${channel}: daily cap ${DAILY_CAP} reached`); break; }
    let payload;
    try { payload = signalPost(s, rungOf(s)); }
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
  const due = plan(signals);
  console.log(`[postToDiscord] ${signals.length} fetched · ${due.length} to post`);
  const posted = await sendBatch(supabase, due, {
    channel: LEDGER.SIGNAL, webhook: process.env.DISCORD_WEBHOOK_SIGNALS,
    forum: process.env.DISCORD_SIGNALS_FORUM !== '0',
  });
  return { posted };
}

/** Settled signals that Discord readers were shown and that have no result post yet. */
async function settledToAnnounce(supabase) {
  const since = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const { data: shown, error: e1 } = await supabase.from('posted_signals')
    .select('signal_id, channel, external_msg_id')
    .in('channel', [LEDGER.SIGNAL, LEDGER.RESULT])
    .gte('posted_at', since);
  if (e1) throw new Error(`settledToAnnounce ledger: ${e1.message}`);

  const byId = new Map();
  for (const r of shown ?? []) {
    const e = byId.get(r.signal_id) ?? { shown: false, done: false, thread: null };
    if (r.channel === LEDGER.RESULT) e.done = true;
    else if (r.external_msg_id) e.shown = true;
    if (r.channel === LEDGER.SIGNAL && r.external_msg_id) e.thread = r.external_msg_id;
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

// ── Daily digests (lib/discordDigest). Settled scores and prices only. ────

const FIXTURE_SELECT = `id, kickoff_at, home_team_id, away_team_id,
  home_team:teams!matches_home_team_id_fkey ( name ),
  away_team:teams!matches_away_team_id_fkey ( name )`;

/** Pre-match fixtures kicking off in the next 24 hours. */
async function upcomingFixtures(supabase) {
  const now = new Date(), until = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return pageAll(() => supabase.from('matches').select(FIXTURE_SELECT)
    .gt('kickoff_at', now.toISOString()).lte('kickoff_at', until.toISOString())
    .eq('status', 'scheduled'), 'id', 'upcomingFixtures');
}

/** Alt text for the image: the text card's lines with the markdown stripped. */
function altText(payload) {
  return payload.embeds.map(e => `${e.title}: ${e.description}`).join(' | ')
    .replace(/<t:\d+:t>/g, '').replace(/[`*]/g, '')
    .replace(/[\u{1F7E5}\u{1F7E9}]+/gu, '')          // the 🟥/🟩 strips: counts already say it
    .replace(/[^\p{L}\p{N}\p{P}\p{Zs}+]/gu, '')     // nothing exotic in an attachment description
    .replace(/\s+/g, ' ').trim().slice(0, 1000);
}

/**
 * Post a digest as an image card, falling back to the text card if drawing
 * fails. The text card is always composed first: it carries the copy check
 * (assertClean) and the alt text, so the image can never say something the
 * text version was not allowed to. DISCORD_CARDS=0 forces text.
 */
async function postDigest(payload, webhook, label, drawCard) {
  if (!payload) { console.log(`[postToDiscord] ${label}: nothing cleared the bar, no post`); return { posted: 0 }; }
  let png = null;
  if (drawCard && process.env.DISCORD_CARDS !== '0') {
    try { png = await drawCard(); }
    catch (err) { console.warn(`[postToDiscord] ${label}: card render failed, posting text: ${err.message}`); }
  }
  if (DRY_RUN) {
    console.log(JSON.stringify(payload, null, 2));
    if (png) console.log(`[postToDiscord] ${label}: card rendered, ${png.length} bytes`);
    return { posted: 0 };
  }
  if (!webhook) { console.log(`[postToDiscord] ${label}: no webhook set, skipping`); return { posted: 0 }; }
  if (png) {
    await postWebhookFiles(webhook, { content: payload.content, allowed_mentions: { parse: [] } },
      [{ name: `${label}.png`, data: png, type: 'image/png', description: altText(payload) }]);
  } else {
    await postWebhook(webhook, payload);
  }
  return { posted: 1 };
}

async function runTrends(supabase) {
  const fixtures = await upcomingFixtures(supabase);
  const teams = [...new Set(fixtures.flatMap(f => [f.home_team_id, f.away_team_id]))];
  const since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
  const cols = 'id, kickoff_at, home_team_id, away_team_id, goals_home, goals_away';
  const done = q => q.eq('status', 'completed').gte('kickoff_at', since).not('goals_home', 'is', null);
  const home = await inChunks(teams, 'id', 'trends home', c => done(supabase.from('matches').select(cols).in('home_team_id', c)));
  const away = await inChunks(teams, 'id', 'trends away', c => done(supabase.from('matches').select(cols).in('away_team_id', c)));
  const history = [...new Map([...home, ...away].map(m => [m.id, m])).values()];
  console.log(`[postToDiscord] trends: ${fixtures.length} fixtures, ${history.length} past matches`);
  return postDigest(trendsPost(fixtures, history), process.env.DISCORD_WEBHOOK_HITRATES, 'trends',
    () => trendsCard(trendSections(fixtures, history)));
}

async function runMovers(supabase) {
  const fixtures = await upcomingFixtures(supabase);
  const ids = fixtures.map(f => f.id);
  const rows = await inChunks(ids, 'id', 'movers odds', c => supabase.from('odds')
    .select('id, match_id, bookmaker, home_odds, draw_odds, away_odds, fetched_at')
    .eq('market', 'h2h').in('match_id', c));
  console.log(`[postToDiscord] movers: ${fixtures.length} fixtures, ${rows.length} price rows`);
  return postDigest(moversPost(rows, fixtures), process.env.DISCORD_WEBHOOK_PULSE, 'movers',
    () => moversCard(moverRows(rows, fixtures)));
}

// ── Admin: delete posts the bot made (workflow_dispatch only) ────────────
const WEBHOOK_FOR = {
  signals: 'DISCORD_WEBHOOK_SIGNALS', results: 'DISCORD_WEBHOOK_RESULTS', record: 'DISCORD_WEBHOOK_RECORD',
  hitrates: 'DISCORD_WEBHOOK_HITRATES', pulse: 'DISCORD_WEBHOOK_PULSE', edge: 'DISCORD_WEBHOOK_EDGE',
};

async function runDelete() {
  const channel = process.env.DELETE_CHANNEL;
  const ids = String(process.env.DELETE_IDS ?? '').split(/[\s,]+/).filter(Boolean);
  const env = WEBHOOK_FOR[channel];
  if (!env) throw new Error(`delete: unknown channel "${channel}"`);
  if (!ids.length) throw new Error('delete: no message ids');
  for (const id of ids) {
    if (DRY_RUN) { console.log(`[postToDiscord] would delete ${channel} ${id}`); continue; }
    console.log(`[postToDiscord] ${channel} ${id}: ${await deleteWebhookMessage(process.env[env], id)}`);
  }
  return { deleted: DRY_RUN ? 0 : ids.length };
}

/**
 * #edge-table, weekly: the current season's clubs against their own closing
 * prices (settled_match_prices, migration 083). The season is the newest one
 * settled_match_seasons lists, so a new season arrives without an edit;
 * DISCORD_EDGE_SEASON overrides it (e.g. 2025/26 to check a finished season).
 */
async function runEdge(supabase) {
  let season = process.env.DISCORD_EDGE_SEASON?.trim();
  if (!season) {
    const { data, error } = await supabase.from('settled_match_seasons').select('season');
    if (error) throw new Error(`settled_match_seasons: ${error.message}`);
    season = [...new Set((data ?? []).map(r => r.season))].sort().pop();
  }
  if (!season) { console.log('[postToDiscord] edge: no season on record, no post'); return { posted: 0 }; }
  const rows = await pageAll(() => supabase.from('settled_match_prices')
    .select('id, div, country, season, match_date, home_team, away_team, ftr, close_home, close_draw, close_away')
    .eq('season', season), 'id', 'edge season');
  const s = edgeSummary(rows);
  console.log(`[postToDiscord] edge ${season}: ${rows.length} matches, ${s.unpriceable} unpriceable, ${s.ranked} clubs ranked, `
    + `${s.clearNominal} past |z|>=2 (chance ~${s.expectedByChance.toFixed(1)}), bar ${s.bar?.toFixed(3) ?? 'n/a'} cleared by ${s.clearBar}`);
  const check = process.env.DISCORD_EDGE_CHECK?.trim();
  if (check) {
    const { buildEdgeTable } = require('./lib/edgeTable');
    for (const t of buildEdgeTable(rows).teams.filter(t => t.team === check)) {
      console.log(`[postToDiscord] edge check ${t.team} ${t.div}: ${t.wins}-${t.draws}-${t.losses} `
        + `units ${t.profitUnits.toFixed(2)} roi ${t.roiPercent.toFixed(1)}% edge ${t.edgePoints.toFixed(2)} z ${t.z?.toFixed(3)}`);
    }
  }
  return postDigest(edgePost(s, season, divisionLabel), process.env.DISCORD_WEBHOOK_EDGE, 'edge',
    () => edgeCard(s, { season, label: divisionLabel, finding: edgeFinding(s) }));
}

async function run(mode = process.argv[2] ?? 'signals') {
  console.log(`\n[postToDiscord] ${new Date().toISOString()} mode=${mode}${DRY_RUN ? ' [DRY RUN]' : ''}`);
  if (!channelEnabled() && !DRY_RUN) {
    console.log('[postToDiscord] channel disabled (DISCORD_POSTING_ENABLED != 1)');
    return { posted: 0, reason: 'channel-disabled' };
  }
  if (mode === 'delete') return runDelete();
  const supabase = getSupabase();
  if (mode === 'signals') return runSignals(supabase);
  if (mode === 'results') return runResults(supabase);
  if (mode === 'weekly') return runWeekly(supabase);
  if (mode === 'trends') return runTrends(supabase);
  if (mode === 'movers') return runMovers(supabase);
  if (mode === 'edge') return runEdge(supabase);
  throw new Error(`unknown mode "${mode}"`);
}

if (require.main === module) {
  run().then(r => console.log(`[postToDiscord] done ${JSON.stringify(r)}`))
    .catch(err => { console.error(`[postToDiscord] ${err.message}`); process.exit(1); });
}

module.exports = { run, numEnv, plan, eligibleSignals, settledToAnnounce, LEDGER };
