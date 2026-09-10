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
const { liveState, adjustLambdaForCards } = require('./lib/inplayState');
const { bookmakerLabel } = require('./lib/bookmakers');
const { classifyTier, dedupeConflicts, isBacked, rungFor } = require('./lib/signalTier');
const { scoreSignal } = require('./lib/maxedge');
const { isPublished, withheldReason, mayBroadcastInplay, inplayDisclosure, inplayLabel,
} = require('./lib/publication');

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
  // THE IN-PLAY CHANNEL MAY HAVE ITS OWN BOT, and until now it could not.
  // Only one token was ever read, so an owner who created a second bot for the
  // in-play channel — the natural thing to do, and what the secret name
  // TELEGRAM_INPLAY_BOT_TOKEN says they did — had its token sitting unread
  // while the code tried to post with the pre-match bot, which is not an
  // administrator of that channel. Telegram answers 403 and the channel stays
  // empty with the secrets looking correctly set.
  //
  // Falls back to the main token, so the simpler arrangement (one bot, two
  // channels) needs no second secret and keeps working untouched.
  const inplayToken  = process.env.TELEGRAM_INPLAY_BOT_TOKEN || token;
  if (!token || !chatId) return null;
  return { token, chatId, inplayChatId, inplayToken };
}

/**
 * Where a signal is posted — the TOKEN AND THE CHAT TOGETHER, deliberately.
 *
 * They are a pair: a bot can only post to a channel it administers, so a token
 * from one bot and a chat id from another is a 403 every time. Returning them
 * separately is what let the two drift apart in the first place, so there is
 * one function and it returns both or neither.
 *
 * In-play routes to the dedicated channel; with that channel unconfigured the
 * signal is NOT posted rather than leaking a live pick into the pre-match
 * feed. Pre-match → the main channel, unchanged.
 *
 * @returns {{token:string, chatId:string}|null} null ⇒ do not post
 */
function postTargetFor(telegram, signal) {
  if (!telegram) return null;
  if (signal.phase === 'inplay') {
    if (!telegram.inplayChatId) return null;
    return { token: telegram.inplayToken ?? telegram.token, chatId: telegram.inplayChatId };
  }
  return { token: telegram.token, chatId: telegram.chatId };
}

/** Back-compat shim — the chat half of `postTargetFor`. Prefer that. */
function chatIdForSignal(telegram, signal) {
  return postTargetFor(telegram, signal)?.chatId ?? null;
}

/**
 * The rows already spoken for on this channel — a cheap PRE-FILTER, and NOT
 * the guard. `deliver` is the guard.
 *
 * IT IS PAGED, AND THAT IS THE FAULT THAT LET THE RESENDS RUN. PostgREST caps a
 * response at 1000 rows whatever the client asks for, and this window held
 * 1,113. It dedupes by id rather than trusting the page length, because
 * `.range()` travels as a Range HEADER and any layer that answers the URL and
 * ignores headers returns the same page for ever. The ORDER BY is not
 * decoration: without one, `.range()` offsets index into an unspecified order
 * and pages can overlap or skip.
 */
async function loadPostedIds(supabase) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const PAGE = 1000, MAX_PAGES = 50;
  const ids = new Set();
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE;
    const { data, error } = await supabase
      .from('posted_signals')
      .select('signal_id')
      .eq('channel', CHANNEL)
      .gte('posted_at', since)
      .order('posted_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`loadPostedIds: ${error.message}`);
    const rows = data ?? [];
    if (!rows.length) break;
    const before = ids.size;
    for (const r of rows) ids.add(r.signal_id);
    if (ids.size === before) break;   // no new ids — a layer ignoring Range
    if (rows.length < PAGE) break;
  }
  return ids;
}

/**
 * A SUBSCRIBER'S identity for a signal — match + market + line + outcome —
 * which is NOT the row's own id.
 *
 * `value_signals_selection_price_unique` includes `detected_odds` (CLAUDE.md:
 * "and is therefore NOT one row per fixture"), so every re-detection at a
 * moved price — pre-match on a re-poll, or in-play on the next tick — writes
 * a BRAND NEW row with a brand new id. `loadPostedIds` dedupes by that row
 * id, which two re-detections of the exact same claim never share.
 *
 * Confirmed live, 10 Sep 2026: one in-play match (Portland Timbers v
 * St. Louis City) posted "away to win" FOUR times in eighteen minutes, each
 * a fresh id at a shrinking price, and a pre-match PRIME signal (Mariehamn v
 * Turku PS) repeated the same way. Nothing was wrong with either signal —
 * each was honestly scored at detection — the failure is that a subscriber
 * was told the same thing four times and had no way to know the row behind
 * the fourth message was not the row behind the first.
 */
function selectionKey(r) {
  return `${r.match_id}|${r.market ?? 'h2h'}|${r.market_line ?? ''}|${r.outcome}`;
}

/**
 * Which SELECTIONS (not row ids) have already reached this channel, for a
 * given set of matches.
 *
 * Scoped to `matchIds` rather than a full `posted_signals` scan: this run's
 * candidates already name the handful of matches in play, and re-reading
 * every post of the last 30 days (1,100+ rows and growing daily) to answer a
 * question about a dozen matches is the wrong shape — the same lesson this
 * file already carries about oversized `.in()` lists.
 *
 * The embed is INNER on purpose (`posted_signals!inner`): a `value_signals`
 * row with no matching posted row drops out entirely, so what comes back is
 * exactly "already told a subscriber about this", nothing else.
 */
async function loadPostedSelectionsFor(supabase, matchIds) {
  if (!matchIds.length) return new Set();
  const { data, error } = await supabase
    .from('value_signals')
    .select('match_id, market, market_line, outcome, posted_signals!inner(channel)')
    .eq('posted_signals.channel', CHANNEL)
    .in('match_id', matchIds);
  if (error) throw new Error(`loadPostedSelectionsFor: ${error.message}`);
  return new Set((data ?? []).map(selectionKey));
}

/**
 * THE CLAIM IS TAKEN BEFORE THE SEND, AND IT IS TAKEN ON THE SELECTION.
 *
 * 10 Sep 2026. The channel re-sent the same fixtures for most of a day, and it
 * took THREE findings to account for it. Each of the first two was real, and
 * neither was sufficient on its own:
 *
 *  1. `markPosted` upserted with ON CONFLICT DO UPDATE. An upsert always
 *     succeeds, so UNIQUE (signal_id, channel) — the whole idempotency
 *     guarantee migration 015 exists for — could never refuse anything. The
 *     only dedupe was a READ, and that read was unordered and unpaged against
 *     1,113 rows behind PostgREST's 1000-row ceiling. Worse, an UPDATE writes a
 *     new tuple at the end of the heap, so every row the upsert touched
 *     relocated into the truncated tail: all ten re-sent rows sat at physical
 *     ranks 1096-1113 of 1113. Re-sending a signal is what guaranteed it would
 *     be re-sent again.
 *  2. `value_signals_selection_price_unique` includes `detected_odds`, so a
 *     re-detection at a moved price writes a BRAND NEW row with a new id. A
 *     ledger keyed on signal_id cannot recognise it as the same bet. (#116)
 *  3. THREE workflows run this file concurrently — `engine.yml`,
 *     `run-engine.yml`, and `runInplayLoop.js` inside `run-inplay.yml`, the
 *     last on a loop of up to 175 minutes that re-posts on every pass. A run
 *     that began at 14:19 was still broadcasting from a two-hour-old checkout
 *     at 16:46.
 *
 * (3) IS WHY A READ CANNOT BE THE GUARD, however well it is written. #116's
 * selection dedupe is correct about WHAT identifies a duplicate and is kept
 * below — but three processes reading before they write will all read "not
 * posted" and all post. Only the database can arbitrate that, and only at the
 * moment of writing.
 *
 * So `claim_selection_post` (migration 125) is one INSERT ... ON CONFLICT DO
 * NOTHING RETURNING id, with NO conflict target — which makes it atomic
 * against BOTH unique constraints at once: the row-level (signal_id, channel)
 * and the selection-level (selection_key, channel). Two runs racing the same
 * bet, by the same row or by two different re-detections of it, collide in
 * Postgres and exactly one wins.
 *
 * THE SELECTION KEY IS COMPUTED IN SQL AND NEVER HERE. `market_line` is
 * unconstrained `numeric`, so 2.5 and 2.50 are both storable and render
 * differently as text; a key built in JavaScript and a key built in SQL would
 * agree until the day they did not. `selectionKey` below is still the
 * IN-MEMORY, same-run guard #116 added, and is deliberately not the thing the
 * constraint uses.
 *
 * NEVER REINTRODUCE AN UPSERT OR AN ON CONFLICT DO UPDATE AGAINST
 * posted_signals, and never write `posted_at` from here — it defaults to now()
 * and is the record of FIRST publication. `engine.postledger.test.js` is the
 * ratchet.
 */

/** Claim id if this caller won; null if the row OR the selection is published. */
async function claimPost(supabase, signalId, messageHash, dedupeSelection) {
  const { data, error } = await supabase.rpc('claim_selection_post', {
    p_signal_id:        signalId,
    p_channel:          CHANNEL,
    p_message_hash:     messageHash,
    p_dedupe_selection: dedupeSelection,
    p_run_id:           RUN_ID,
  });
  if (error) throw new Error(`claim_selection_post: ${error.message}`);
  return data ?? null;
}

async function confirmPost(supabase, claimId, externalMsgId) {
  const { error } = await supabase.rpc('confirm_signal_post', {
    p_claim_id: claimId, p_external_msg_id: String(externalMsgId),
  });
  // A sent message whose confirm write failed is not a reason to fail the run:
  // the claim stands, so it cannot go out twice. Only the message id is lost.
  if (error) console.warn(`[postToX] confirm_signal_post failed (message ${externalMsgId} WAS sent): ${error.message}`);
}

async function releasePost(supabase, claimId) {
  const { error } = await supabase.rpc('release_signal_post', { p_claim_id: claimId });
  // Never throw over the send error this is unwinding. A failed release leaves
  // the claim standing, which suppresses one post — the safe direction.
  if (error) console.warn(`[postToX] release_signal_post failed, claim ${claimId} stands: ${error.message}`);
}

/**
 * Claim, send, confirm — releasing only on PROOF that nothing was delivered.
 *
 * `send` is null for a signal being suppressed rather than broadcast (not
 * backed, a conflict loser, already alerted, no channel). Those take the claim
 * and never confirm it, which is what stops them being reconsidered on every
 * tick — the job `markPosted(…, null)` used to do, without the upsert that
 * made the constraint unenforceable.
 *
 * `dedupeSelection` is false for a MOVER, preserving #116's exemption: "the
 * price on an existing signal moved" is a deliberate re-alert, not the repeat
 * this guard exists to stop. A mover writes a NULL selection_key, and the
 * partial unique index ignores NULLs, so it is bound only by its own row id.
 *
 * THE RELEASE IS NARROWER THAN "on any error", on purpose. A Telegram
 * rejection (a well-formed ok:false — 400, 403, a 429) is proof nothing was
 * sent, so the claim is released and the signal retries next run. A TRANSPORT
 * failure — a timeout, a dropped socket — is proof of nothing: the message may
 * have landed and only the answer was lost. Releasing there hands back the
 * duplicate this whole change exists to remove. One withheld post is a smaller
 * harm than one duplicate post, on a channel whose readers cannot tell them
 * apart.
 */
async function deliver(supabase, signal, messageHash, send, dedupeSelection = true) {
  const claimId = await claimPost(supabase, signal.id, messageHash, dedupeSelection);
  if (!claimId) return { outcome: 'already_published' };
  if (!send)    return { outcome: 'claimed', claimId };

  try {
    const res = await send();
    await confirmPost(supabase, claimId, res.message_id);
    return { outcome: 'sent', claimId, messageId: res.message_id };
  } catch (err) {
    if (err && err.telegramRejected) {
      await releasePost(supabase, claimId);
      return { outcome: 'refused', claimId, error: err };
    }
    return { outcome: 'uncertain', claimId, error: err };
  }
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
  // IN-PLAY IS ADMITTED BY ITS OWN GATE, NOT BY THIS ONE.
  //
  // `isPublished` answers "may this be presented as a backed selection" and no
  // in-play architecture is in PUBLICATION — so every in-play row was dropped
  // HERE, and the 🔴 branch in buildMessage below has never once been
  // reachable, whatever TELEGRAM_INPLAY_CHAT_ID was set to. That was the
  // fourth gate on this feature and the one that decided it.
  //
  // `mayBroadcastInplay` is off unless INPLAY_BROADCAST_ENABLED is set, admits
  // only named architectures, and every message it lets through carries the
  // disclosure. Nothing pre-match changes: the pre-match arm of this filter is
  // the same call it always was.
  const backed = rows.filter(r => (
    isInplay(r) ? mayBroadcastInplay(r.model_architecture) : isPublished(r.model_architecture)
  ));
  if (backed.length !== rows.length) {
    const byArch = new Map();
    for (const r of rows) {
      if (isInplay(r) ? mayBroadcastInplay(r.model_architecture) : isPublished(r.model_architecture)) continue;
      const k = isInplay(r) ? `${r.model_architecture ?? '(null)'} [in-play]` : (r.model_architecture ?? '(null)');
      byArch.set(k, (byArch.get(k) ?? 0) + 1);
    }
    for (const [arch, count] of byArch) {
      // An in-play row withheld because the CHANNEL IS OFF is a different fact
      // from one withheld because the model does not publish, and reading the
      // pre-match reason against it would send the next person to the wrong
      // gate entirely.
      const why = arch.endsWith('[in-play]')
        ? 'the in-play channel is off (set INPLAY_BROADCAST_ENABLED=true), or this architecture is not in INPLAY_BROADCAST'
        : withheldReason(arch);
      console.log(`[postToX] withheld ${count} ${arch} signal(s): ${why}`);
    }
  }
  await attachLiveState(supabase, backed);
  return backed;
}

/**
 * Attach `live_state` to the in-play rows, from `match_stats`.
 *
 * A man advantage is WHY a live price moved, so the alert says it above the
 * price rather than leaving a reader to infer it from a number that looks
 * wrong. Read here rather than in `buildMessage` because that function is pure
 * and unit-tested, and it must stay that way.
 *
 * Fails soft and does nothing at all when no in-play row survived the gate:
 * the alert simply omits the line, which is correct — an absent card line
 * means "not reported", never "no cards".
 */
async function attachLiveState(supabase, rows) {
  const inplayRows = rows.filter(isInplay);
  if (!inplayRows.length) return;

  // match_stats keys on the API-FOOTBALL fixture id, and value_signals carries
  // only match_id — so the external id has to be looked up. Joining the wrong
  // one returns nothing and looks exactly like a feed with no stats.
  const matchIds = [...new Set(inplayRows.map(r => r.match_id).filter(Boolean))];
  if (!matchIds.length) return;

  const { data: matchRows, error: mErr } = await supabase
    .from('matches').select('id, external_id').in('id', matchIds);
  if (mErr) { console.warn(`[postToX] live state: match lookup failed: ${mErr.message}`); return; }

  const externalByMatch = new Map();
  for (const m of matchRows ?? []) if (m.external_id != null) externalByMatch.set(m.id, String(m.external_id));
  const externals = [...new Set(externalByMatch.values())];
  if (!externals.length) return;

  const { data: statRows, error: sErr } = await supabase
    .from('match_stats').select('fixture_id, team_side, stats').in('fixture_id', externals);
  if (sErr) { console.warn(`[postToX] live state: stats read failed: ${sErr.message}`); return; }

  const sides = new Map();
  for (const r of statRows ?? []) {
    let e = sides.get(String(r.fixture_id));
    if (!e) { e = { home: null, away: null }; sides.set(String(r.fixture_id), e); }
    if (r.team_side === 'home' || r.team_side === 'away') e[r.team_side] = r;
  }

  let attached = 0;
  for (const row of inplayRows) {
    const ext = externalByMatch.get(row.match_id);
    const e = ext ? sides.get(ext) : null;
    if (!e) continue;
    row.live_state = liveState(e.home, e.away);
    attached++;
  }
  console.log(`[postToX] live state attached to ${attached}/${inplayRows.length} in-play signal(s)`);
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
 * THE WORD THE POST PRINTS — and it is NOT `bandOf`.
 *
 * `mxs_band` is the SCORE band: what the number alone says. Since 26 Aug 2026
 * the printed rung is decided by the BOX first and the score can only demote
 * it, so the two now disagree routinely — a 99-scoring row at a 4% edge has
 * `mxs_band = 'PRIME'` and a rung of WATCH. Printing `bandOf` here would put
 * the top word on a row the ladder declines, which is the exact failure the
 * 21 Aug badge fix removed from the site.
 */
function rungOf(signal) {
  return rungFor({
    odds: signal.detected_odds,
    edge: signal.detected_edge,
    mxs:  signal.mxs ?? rescore(signal).mxs,
  });
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
 * today would be correct today and wrong the next time a word moves. Read the
 * line, never the word.
 *
 * ON 26 Aug 2026 THE BOX BECAME PART OF THE GATE, not just the score. `isBacked`
 * takes the ROW now and `rungFor` asks both ladders inside it, so the explicit
 * `isSuggested(signal) &&` that used to sit here is not gone — it moved in, and
 * expressing the conjunction ONCE is the point. Passing a bare score here would
 * make `rungFor` return null and the channel would go silent without throwing.
 */
function isBroadcastable(signal) {
  const mxs = signal.mxs ?? rescore(signal).mxs;
  return isBacked({
    odds: signal.detected_odds,
    edge: signal.detected_edge,
    mxs,
  });
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
  // THROUGH bookmakerLabel, AND THE REASON IS THE SAME ONE THE OUTCOME LINE
  // ABOVE GIVES. `value_signals.bookmaker` holds The Odds API's KEYS verbatim
  // — `unibet_uk`, `betfair_sb_uk`, `apifootball_live` — and an underscore is
  // Telegram's italic delimiter. Two of them in one message silently italicise
  // everything between, and one on its own leaves a stray `_` in the post.
  // This was already known about outcomes and the bookmaker was printed raw
  // beside it. The label is also simply the right thing to show a reader.
  const book    = bookmakerLabel(signal.bookmaker) ?? 'Best price';
  const kickoff = formatKickoff(signal.kickoff_at);

  // In-play signals are a separate tier: live score/minute instead of kickoff,
  // and a distinct header so the dedicated channel reads unmistakably "live".
  if (isInplay(signal)) {
    // RED IS THE IN-PLAY MARK AND IT IS THE ONLY THING THAT USES IT. The
    // pre-match channel runs `>>` for its backed rungs and 🎯 / ⚡ for the
    // rest; nothing there is red. A reader scanning two channels on a phone
    // should be able to tell which one they are in from the first glyph, so
    // the header, the rule and the clock all carry it and nothing else does.
    const state = formatLiveState(
      signal.match?.goals_home, signal.match?.goals_away, signal.match?.minute
    );
    const marketLabel = signal.market && signal.market !== 'h2h'
      ? `${signal.market.toUpperCase()}${signal.market_line != null ? ` ${signal.market_line}` : ''} · `
      : '';

    // A MAN ADVANTAGE IS WHY THE PRICE MOVED, so it goes above the price
    // rather than being left for the reader to infer. lib/inplayState is the
    // one place that reads it, and it returns nothing when the feed did not
    // report cards — an absent line is "not reported", never "none".
    const cards = signal.live_state
      ? adjustLambdaForCards({ lambdaHome: 1, lambdaAway: 1 }, signal.live_state)
      : null;
    let cardLine = null;
    if (cards?.applied) {
      const short = cards.differential > 0 ? home : away;
      cardLine = `🔴 *${short} down to ${11 - Math.min(Math.abs(cards.differential), 2)} men* — priced in`;
    }

    return [
      `🔴 *IN-PLAY* · ${inplayLabel(signal.model_architecture)}`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `*${home} v ${away}*`,
      league ? `_${league}_` : null,
      `🔴 *${state}*`,
      cardLine,
      ``,
      `${marketLabel}*${outcome}* @ *${odds}*`,
      `_${book}_ · EV *+${edgePct}%*${mes}`,
      ``,
      // The two things a live reader needs and a pre-match reader does not.
      `⚠️ _Live price — it moves, and it may be gone. Check the book before you take it._`,
      `_${inplayDisclosure(signal.model_architecture)}_`,
      ``,
      `[Live board](https://maxedge.live/in-play)`,
      `#MaxEdge #InPlay`,
    ].filter(l => l !== null).join('\n');
  }

  let header, hashtags, note = null;
  if (isMover(signal)) {
    header   = `>> *ODDS MOVEMENT*`;
    hashtags = `#MaxEdge #OddsMove`;
  } else {
    const { tier, notable } = classifyTier(signal);
    const mxs  = signal.mxs ?? rescore(signal).mxs;
    const rung = rungOf(signal);

    // TWO BACKED RUNGS NOW, AND THEY MUST NOT SHARE COPY.
    //
    // It read `🟢 BACKED SIGNAL` for one rung from 21 Aug, because PRIME was
    // capped out of the product and naming it would have claimed a rung no row
    // could reach. That is no longer true: PRIME is the 5.0-6.9% box at 60+ and
    // rows reach it, so the word is earned again and the post says it.
    //
    // EDGE IS BROADCAST AND IS NOT PRIME. The two are settled separately and
    // reported separately (`performance_band`), so a post that blurs them
    // creates a record nobody can reconcile. The branch splits on `rungFor`,
    // never on the score band — see rungOf above.
    if (rung === 'PRIME') {
      header   = `>> *PRIME SIGNAL*`;
      note     = `_Our headline tier — the ladder suggests it and it scores ${mxs}/100_`;
      hashtags = `#MaxEdge #PrimeSignal`;
    } else if (rung === 'EDGE') {
      // The scope line is deliberate and is the same disclosure
      // `performance_band.headline_scope_note` carries on the site: this rung is
      // backed and broadcast, and it is NOT in the published headline record.
      // Quoting it as though it were is the "we count our best band" charge the
      // split has to answer every time it is made.
      header   = `>> *EDGE SIGNAL*`;
      note     = `_Backed at ${mxs}/100 — tracked and reported separately from our headline record_`;
      hashtags = `#MaxEdge #EdgeSignal`;
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
          // Telegram answered, and it answered no. That is PROOF the message
          // was not delivered, which is what lets `deliver` release the claim.
          // A timeout carries no such proof and is deliberately left untagged.
          err.telegramRejected = true;
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

  // A PRE-FILTER, NOT THE GUARD — `deliver`'s claim is the guard. This read
  // only saves a claim round trip on rows already visibly spoken for; whatever
  // it misses, the claim refuses. Treating it as the guard is what shipped the
  // 10 Sep resends, and the paging in `loadPostedIds` is why it missed them.
  const toPost      = validSignals.filter(s => !postedIds.has(s.id));
  const alreadySeen = signals.length - toPost.length;
  console.log(`[postToX] ${toPost.length} candidate(s) | ${alreadySeen} already in the ledger`);

  // SELECTION-LEVEL DEDUP. `toPost` is deduped by ROW id, and a price
  // re-detection writes a new row every time — see the note on
  // `selectionKey`/`loadPostedSelectionsFor` above. Loaded AFTER the row-level
  // filter and scoped to the matches still in play, so this is one small read
  // rather than a second scan of the whole 30-day window.
  const postedSelections = await loadPostedSelectionsFor(
    supabase, [...new Set(toPost.filter(s => !isMover(s)).map(s => s.match_id))]
  );

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

  let posted = 0, failed = 0, uncertain = 0;

  let skippedNoChannel = 0;
  let skippedInfo      = 0;
  let alreadyClaimed   = 0;

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
    const target      = telegram ? postTargetFor(telegram, signal) : telegram;
    const chatId      = target ? target.chatId : target;

    // WHY THIS SIGNAL IS NOT BEING BROADCAST, decided before the claim so that
    // taking the claim has ONE shape for every road out. Each reason still
    // takes the claim and never confirms it, which is what stops the row being
    // reconsidered on every tick — the job `markPosted(…, null)` used to do,
    // without the upsert that made the constraint unenforceable.
    let suppressed = null;

    // Pre-match, we only broadcast a BACKED signal — suggested by the
    // eligibility ladder (the price+edge box) AND scored at or above the
    // backing line, which is exactly what `isBroadcastable` (isBacked, reading
    // BOTH ladders) means. The wider edges and the longshots stay visible on
    // the site and are never pushed. In-play and odds-movement alerts bypass
    // this; they have their own logic.
    //
    // THIS USED TO READ `tier !== 'prime'` — the ELIGIBILITY tier alone, from
    // `classifyTier` — and it silently diverged from the definition above the
    // day the eligibility ladder split into two suggested tiers, 'prime' and
    // 'edge' (26 Aug 2026, lib/signalTier.js). Two live failures: every
    // genuinely backed EDGE-tier signal was dropped here before reaching
    // `buildMessage`'s "EDGE SIGNAL" branch, and a PRIME-eligibility signal
    // scoring below the backing line sailed through and was posted labelled
    // "⚡ UNBACKED EDGE" by a branch whose own comment claimed that case "does
    // not reach the channel". Reading the one predicate this file already
    // defines, instead of re-deriving the ladder from a tier string, is the fix.
    if (!isInplay(signal) && !isMover(signal) && !isBroadcastable(signal)) {
      suppressed = `${label}, not backed`;
    }

    // ALREADY TOLD A SUBSCRIBER ABOUT THIS SELECTION. A mover is exempt on
    // purpose — "the price on an existing signal moved" is its own deliberate
    // re-alert, not the repeat this guard exists to stop. Everything else,
    // in-play included, gets one message per (match, market, line, outcome):
    // the row's own id says nothing about whether a subscriber has heard this,
    // and re-detections at a new price share no id at all.
    //
    // THIS IS A PRE-FILTER NOW, NOT THE GUARD — `deliver`'s claim is the
    // guard, because THREE workflows run this file concurrently and all three
    // would read "not posted" before any of them wrote. Kept because it saves
    // a round trip and because it is the in-run half of the same rule.
    else if (!isMover(signal) && postedSelections.has(selectionKey(signal))) {
      suppressed = `${label}, already alerted this selection`;
    }

    // Conflict guard: a suggested selection that lost the per-match/market
    // tie-break to a higher-edge opposing pick, suppressed so the two cannot
    // cancel out.
    else if (!isInplay(signal) && !isMover(signal) && isBroadcastable(signal) && !broadcastableIds.has(signal.id)) {
      suppressed = 'backed conflict, lower edge';
    }

    // In-play signal with no in-play channel configured → silence, rather than
    // leaking a live pick into the pre-match channel.
    else if (!DRY_RUN && !chatId) {
      suppressed = `no channel for phase=${signal.phase}`;
    }

    // Claim the selection NOW, in-memory, for the rest of THIS run — not just
    // in the database for the next one. Two rows for the same (match, market,
    // line, outcome) can both land in `toPost` in a single run (a re-detection
    // arriving between the fetch above and this loop), and without this a
    // second one would sail through the check above unopposed.
    if (!isMover(signal) && !suppressed) postedSelections.add(selectionKey(signal));

    // A DRY RUN WRITES NOTHING AT ALL, and it used to write real ledger rows.
    // `markPosted` ran on the DRY_RUN branch, so rehearsing the broadcast
    // permanently suppressed every signal it rehearsed: the next real run found
    // them already recorded and never sent them. A rehearsal must be able to be
    // wrong without costing a broadcast.
    if (DRY_RUN) {
      if (suppressed) { console.log(`\n[postToX] would skip (${suppressed}) — ${home} vs ${away} (${signal.outcome.toUpperCase()})`); skippedInfo++; continue; }
      console.log(`\n[postToX] would post ${label} — ${home} vs ${away} (${signal.outcome.toUpperCase()})`);
      console.log(message);
      posted++;
      continue;
    }

    // CLAIM BEFORE SEND. A mover is claimed WITHOUT a selection key so its
    // deliberate re-alert is not blocked by its own earlier post; everything
    // else is claimed on the selection, which is the only key a re-detection
    // at a moved price shares with the row it repeats.
    const send = suppressed ? null : () => telegramPost(target.token, chatId, message);

    let result;
    try {
      result = await deliver(supabase, signal, messageHash, send, !isMover(signal));
    } catch (err) {
      // The claim RPC itself failed — the database is unreachable or the grant
      // is gone. Nothing was sent and nothing was recorded.
      console.error(`[postToX] claim failed for ${signal.id}: ${err.message}`);
      failed++;
      continue;
    }

    // A null claim is the ORDINARY case on a channel three workflows tick:
    // somebody else already published this bet. Not an error, not a failure.
    if (result.outcome === 'already_published') { alreadyClaimed++; continue; }

    if (suppressed) {
      console.log(`\n[postToX] skip (${suppressed}) — ${home} vs ${away} (${signal.outcome.toUpperCase()})`);
      if (suppressed.startsWith('no channel')) skippedNoChannel++; else skippedInfo++;
      continue;
    }

    console.log(`\n[postToX] ${label} — ${home} vs ${away} (${signal.outcome.toUpperCase()})`);
    console.log(message);

    if (result.outcome === 'sent') {
      console.log(`[postToX] posted — message id: ${result.messageId}`);
      posted++;
    } else if (result.outcome === 'refused') {
      // Telegram said no, so nothing went out and the claim has been released.
      // This signal is eligible again on the next tick.
      console.error(`[postToX] refused: ${result.error.message}`);
      if (result.error.retryAfterSec) await new Promise(r => setTimeout(r, (result.error.retryAfterSec + 1) * 1000));
      failed++;
    } else {
      // Transport failure. The message MAY have landed, so the claim stands and
      // this signal will not be retried. Under-posting once beats posting twice.
      console.error(`[postToX] send outcome unknown, claim retained (will not retry): ${result.error.message}`);
      uncertain++;
      failed++;
    }

    if (i < toPost.length - 1) await new Promise(r => setTimeout(r, 1000));
  }

  const summary = { posted, failed, skipped: alreadySeen + alreadyClaimed,
                    no_channel: skippedNoChannel, info_only: skippedInfo,
                    already_claimed: alreadyClaimed, uncertain };
  console.log(`\n[postToX] done —`, summary);
  return summary;
}

if (require.main === module) {
  run().catch(err => { console.error('[postToX] fatal:', err.message); process.exit(1); });
}

module.exports = { run, deliver, claimPost, confirmPost, releasePost, loadPostedIds, buildMessage, isSuggested, isBroadcastable, bandOf, isMover, isInplay, chatIdForSignal, postTargetFor, getTelegramConfig, selectionKey, loadPostedSelectionsFor };
