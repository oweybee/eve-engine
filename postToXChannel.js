'use strict';

/**
 * MaxEdge — the X channel.
 *
 * ── IT IS AN ADAPTER, NOT A SECOND POSTER, AND THAT IS THE WHOLE DESIGN ─────
 *
 * `postToX.js` has never posted to X. It sets CHANNEL = 'telegram' and every
 * one of the 1,315 rows it has written is Telegram; the filename is a fossil
 * from an intention. The temptation when adding X is to write a fresh file
 * that reads the signals and decides for itself what is worth posting, and
 * postToX's own header records what that cost the last time it happened: the
 * broadcast recomputed its own score and posted PRIME for selections the site
 * badged WATCH — the collision escaping the product entirely, to the one
 * audience that cannot click through and check.
 *
 * So nothing here decides anything. The gate (`isBroadcastable`), the fetch
 * (`fetchRecentSignals`), the claim/send/confirm ledger dance (`deliver`) and
 * the publication rules all come from postToX.js unchanged, with `'x'` passed
 * as the channel. This file owns three things and no others: WHICH of the
 * eligible signals to spend today's small budget on, HOW to word it, and
 * WHETHER the rails allow it.
 *
 * ── IT RUNS UNATTENDED, WHICH IS WHY THE RAILS COME FIRST ───────────────────
 *
 * The founder chose fully automatic posting over a draft queue on 28 Sep 2026.
 * Every check in `lib/xGuard` is one a human reviewer would have done by eye,
 * written down so it happens on every post rather than on the ones somebody
 * looked at. The kill switch is read BEFORE the database is, so a disabled
 * channel costs one environment lookup and nothing else.
 *
 * ── ONE POST A RUN, AT MOST ─────────────────────────────────────────────────
 *
 * Volume alone reads as automation. The job takes the single best eligible
 * signal and stops, so cadence is set by how often the workflow runs rather
 * than by how many signals happen to be open — which is what makes a quiet
 * board quiet on X too, instead of a burst of six followed by silence.
 *
 * Env: X_POSTING_ENABLED=1 · X_API_KEY · X_API_SECRET · X_ACCESS_TOKEN ·
 *      X_ACCESS_TOKEN_SECRET · optional X_DAILY_CAP, X_SIMILARITY_WINDOW.
 * DRY_RUN=1 composes, guards and prints, and never calls X or the ledger.
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { fetchRecentSignals, deliver, isBroadcastable, isMover, isInplay } = require('./postToX');
const { compose, valueBody, VARIANTS, ComposeRefusal } = require('./lib/xCompose');
const { mayPost, skeletonOf, channelEnabled } = require('./lib/xGuard');
const { postTweet, getXConfig } = require('./lib/xClient');

const CHANNEL = 'x';
const DRY_RUN = process.env.DRY_RUN === '1';

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key);
}

/** Posts sent on this channel since midnight UTC, and their shapes, newest first. */
async function loadRecentPosts(supabase) {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('posted_signals')
    .select('skeleton, posted_at')
    .eq('channel', CHANNEL)
    .gte('posted_at', since)
    .order('posted_at', { ascending: false })
    .limit(200);
  if (error) throw new Error(`loadRecentPosts: ${error.message}`);

  const rows = data ?? [];
  const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0);
  return {
    skeletons: rows.map(r => r.skeleton).filter(Boolean),
    postedToday: rows.filter(r => new Date(r.posted_at) >= startOfDay).length,
  };
}

/**
 * Which phrasing to use.
 *
 * Rotates on the count of posts already sent rather than at random: random
 * rotation repeats by chance, and a repeat is the one outcome the guard exists
 * to stop. The guard still has the final say — this only makes its job
 * satisfiable.
 */
function variantFor(postedCount) {
  return postedCount % VARIANTS.value.length;
}

/**
 * The best eligible signal, or null.
 *
 * `isBroadcastable` is postToX's own double gate: the eligibility ladder has to
 * suggest the selection AND the stored conviction band has to back it. Nothing
 * is recomputed here — a band this file worked out for itself would be the
 * exact defect the header describes.
 */
function pickBest(signals) {
  const eligible = signals.filter(s =>
    !isInplay(s) && !isMover(s) && isBroadcastable(s) &&
    Number.isFinite(parseFloat(s.detected_odds)) && parseFloat(s.detected_odds) > 1 &&
    Number.isFinite(parseFloat(s.detected_edge)));
  if (!eligible.length) return null;
  return eligible.sort((a, b) => parseFloat(b.detected_edge) - parseFloat(a.detected_edge))[0];
}

function bodyFor(signal, variant) {
  return valueBody({
    home: signal.match?.home_team?.name ?? '?',
    away: signal.match?.away_team?.name ?? '?',
    league: signal.match?.league?.name ?? null,
    selection: signal.outcome,
    odds: parseFloat(signal.detected_odds),
    ev: parseFloat(signal.detected_edge),
    book: signal.bookmaker ?? null,
  }, variant);
}

async function run() {
  const stamp = new Date().toISOString();
  console.log(`\n[postToXChannel] ${stamp}${DRY_RUN ? ' [DRY RUN]' : ''}`);

  // THE SWITCH IS READ BEFORE THE DATABASE IS. A disabled channel should cost
  // one environment lookup, not a round trip.
  if (!channelEnabled() && !DRY_RUN) {
    console.log('[postToXChannel] channel disabled (X_POSTING_ENABLED != 1)');
    return { posted: 0, reason: 'channel-disabled' };
  }
  if (!DRY_RUN) getXConfig();   // fail before claiming anything if creds are absent

  const supabase = getSupabase();
  const signals = await fetchRecentSignals(supabase);
  const best = pickBest(signals);
  if (!best) {
    console.log(`[postToXChannel] ${signals.length} signal(s) fetched, none eligible`);
    return { posted: 0, reason: 'nothing-eligible' };
  }

  const { skeletons, postedToday } = DRY_RUN
    ? { skeletons: [], postedToday: 0 }
    : await loadRecentPosts(supabase);

  // Try each phrasing in rotation order. A refusal is per-variant, so one
  // unusable wording does not silence the channel.
  let text = null, skeleton = null, refusal = null;
  for (let i = 0; i < VARIANTS.value.length; i++) {
    const variant = variantFor(postedToday + i);
    let candidate;
    try { candidate = compose({ body: bodyFor(best, variant), routeKey: 'value' }); }
    catch (err) {
      if (err instanceof ComposeRefusal) { refusal = err.refusal; continue; }
      throw err;
    }
    const verdict = mayPost({ text: candidate, recentSkeletons: skeletons, postedToday });
    if (verdict.ok) { text = candidate; skeleton = verdict.skeleton; break; }
    refusal = verdict.reason;
    // A cap or a disabled switch is not per-variant: trying another wording
    // cannot change either, so stop rather than looping five more times.
    if (verdict.reason === 'daily-cap' || verdict.reason === 'channel-disabled') break;
  }

  if (!text) {
    console.log(`[postToXChannel] no postable wording (${refusal})`);
    return { posted: 0, reason: refusal };
  }

  if (DRY_RUN) {
    console.log(`\n${text}\n`);
    console.log(`[postToXChannel] DRY RUN — nothing sent. shape: ${skeleton.slice(0, 70)}`);
    return { posted: 0, reason: 'dry-run', text };
  }

  const messageHash = crypto.createHash('sha256').update(text).digest('hex');
  const result = await deliver(supabase, best, messageHash, () => postTweet(text), true, CHANNEL);

  if (result.outcome === 'sent') {
    // Best effort, and deliberately after the send: a failed skeleton write
    // costs one weakened similarity check, where a failed send costs nothing.
    const { error } = await supabase.from('posted_signals')
      .update({ skeleton }).eq('id', result.claimId);
    if (error) console.warn(`[postToXChannel] skeleton not recorded: ${error.message}`);
    console.log(`[postToXChannel] posted ${result.messageId}`);
    return { posted: 1, messageId: result.messageId };
  }

  console.log(`[postToXChannel] not posted (${result.outcome})`);
  return { posted: 0, reason: result.outcome };
}

if (require.main === module) {
  run().catch(err => { console.error(`[postToXChannel] ${err.message}`); process.exit(1); });
}

module.exports = { run, pickBest, bodyFor, variantFor, loadRecentPosts, CHANNEL };
