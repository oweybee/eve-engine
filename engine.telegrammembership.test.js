/**
 * engine.telegrammembership.test.js — reconcileTelegramMembership.js.
 *
 * Zero deps, no DB/network: `lib/supabaseClient.getClient()` and
 * `lib/telegramBot.js` are never reached — every test injects a fake
 * Supabase-shaped object and a fake Telegram client directly into `run()`.
 *
 * Run: node engine.telegrammembership.test.js
 */
'use strict';

const assert = require('assert');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); process.exitCode = 1; }
}
/**
 * Async cases need their own runner — engine.inplayseries.test.js's own note
 * applies verbatim: handing an async function to the sync `test` above
 * resolves nothing, and a failed assertion lands as an unhandled rejection
 * after the summary has already printed, which is a ratchet that cannot fail.
 */
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); process.exitCode = 1; }
}

const {
  run, planChannel, planFor, needsEntitlementCheck, membershipEnabled, CHANNELS,
} = require('./reconcileTelegramMembership');

// ── env plumbing ──────────────────────────────────────────────────────────
const ENV_KEYS = [
  'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_INPLAY_CHAT_ID',
  'TELEGRAM_INPLAY_BOT_TOKEN', 'TELEGRAM_MEMBERSHIP_ENABLED', 'TELEGRAM_OWNER_CHAT_ID',
];
function snapshotEnv() {
  const snap = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}
function restoreEnv(snap) {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}
/** Both channels configured, dry run by default (TELEGRAM_MEMBERSHIP_ENABLED unset). */
function baseTelegramEnv() {
  delete process.env.TELEGRAM_MEMBERSHIP_ENABLED;
  delete process.env.TELEGRAM_OWNER_CHAT_ID;
  delete process.env.TELEGRAM_INPLAY_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN      = 'MAIN_TOKEN';
  process.env.TELEGRAM_CHAT_ID        = 'MAIN_CHAT';
  process.env.TELEGRAM_INPLAY_CHAT_ID = 'INPLAY_CHAT';
}

// ── fakes ─────────────────────────────────────────────────────────────────
function row(over = {}) {
  return {
    user_id: 'u1',
    signals_status: 'none', signals_telegram_user_id: null, signals_invite_link: null,
    signals_joined_at: null,
    inplay_status: 'none', inplay_telegram_user_id: null, inplay_invite_link: null,
    inplay_joined_at: null,
    ...over,
  };
}

function fakeSupabase({ rows = [], entitled = {} } = {}) {
  const updates = [];
  const rpcCalls = [];
  return {
    updates, rpcCalls,
    from(table) {
      assert.strictEqual(table, 'telegram_links', 'must only ever touch telegram_links');
      return {
        select() { return Promise.resolve({ data: rows, error: null }); },
        update(patch) {
          return {
            eq(col, val) {
              updates.push({ patch, col, val });
              return Promise.resolve({ data: null, error: null });
            },
          };
        },
      };
    },
    rpc(name, args) {
      assert.strictEqual(name, 'is_plus_entitled');
      rpcCalls.push(args.p_user_id);
      const v = entitled[args.p_user_id];
      return Promise.resolve({ data: v === undefined ? false : v, error: null });
    },
  };
}

/** Throws if touched at all — for the fail-closed "must never reach the DB" case. */
function untouchableSupabase() {
  return {
    from() { throw new Error('telegram_links must not be read'); },
    rpc() { throw new Error('is_plus_entitled must not be called'); },
  };
}

function fakeTelegramBot({ failBan = false, failRevoke = false, failSend = false } = {}) {
  const calls = { ban: [], unban: [], revoke: [], send: [] };
  return {
    calls,
    async banChatMember(token, chatId, userId) {
      calls.ban.push({ token, chatId, userId });
      if (failBan) throw new Error('ban failed (mock)');
    },
    async unbanChatMember(token, chatId, userId, opts) {
      calls.unban.push({ token, chatId, userId, opts });
    },
    async revokeChatInviteLink(token, chatId, inviteLink) {
      calls.revoke.push({ token, chatId, inviteLink });
      if (failRevoke) throw new Error('revoke failed (mock)');
    },
    async sendMessage(token, chatId, text) {
      calls.send.push({ token, chatId, text });
      if (failSend) throw new Error('send failed (mock)');
    },
  };
}

/** Throws if any Telegram call is attempted at all. */
function untouchableTelegramBot() {
  const boom = (m) => () => { throw new Error(`must not call ${m}`); };
  return {
    banChatMember: boom('banChatMember'),
    unbanChatMember: boom('unbanChatMember'),
    revokeChatInviteLink: boom('revokeChatInviteLink'),
    sendMessage: boom('sendMessage'),
  };
}

// ── pure planning ────────────────────────────────────────────────────────

console.log('planChannel / planFor — pure, no I/O');

test('CHANNELS is exactly signals and inplay', () => {
  assert.deepStrictEqual(CHANNELS, ['signals', 'inplay']);
});

test('still entitled: always none, whatever the status', () => {
  for (const status of ['none', 'invited', 'joined', 'kicked', 'revoked', 'left']) {
    const r = row({ signals_status: status, signals_telegram_user_id: 1, signals_invite_link: 'x' });
    assert.deepStrictEqual(planChannel(r, 'signals', true), { action: 'none' });
  }
});

test('unentitled + joined + a telegram_user_id -> kick', () => {
  const r = row({ signals_status: 'joined', signals_telegram_user_id: 777 });
  assert.deepStrictEqual(planChannel(r, 'signals', false), { action: 'kick', telegramUserId: 777 });
});

test('unentitled + joined + NO telegram_user_id -> notify_owner, never kick', () => {
  const r = row({ signals_status: 'joined', signals_telegram_user_id: null });
  const plan = planChannel(r, 'signals', false);
  assert.strictEqual(plan.action, 'notify_owner');
  assert.ok(/telegram_user_id/.test(plan.reason));
});

test('unentitled + invited + an invite link -> revoke', () => {
  const r = row({ signals_status: 'invited', signals_invite_link: 'https://t.me/+abc' });
  assert.deepStrictEqual(planChannel(r, 'signals', false), { action: 'revoke', inviteLink: 'https://t.me/+abc' });
});

test('unentitled + invited + NO invite link -> skip_log, not revoke', () => {
  const r = row({ signals_status: 'invited', signals_invite_link: null });
  const plan = planChannel(r, 'signals', false);
  assert.strictEqual(plan.action, 'skip_log');
});

test("unentitled + none/kicked/revoked/left -> none", () => {
  for (const status of ['none', 'kicked', 'revoked', 'left']) {
    const r = row({ signals_status: status });
    assert.deepStrictEqual(planChannel(r, 'signals', false), { action: 'none' });
  }
});

test('planFor asks both channels independently', () => {
  const r = row({
    signals_status: 'joined', signals_telegram_user_id: 1,
    inplay_status: 'invited', inplay_invite_link: 'link',
  });
  const plan = planFor(r, false);
  assert.strictEqual(plan.signals.action, 'kick');
  assert.strictEqual(plan.inplay.action, 'revoke');
});

test('needsEntitlementCheck is true only when some channel is joined or invited', () => {
  assert.strictEqual(needsEntitlementCheck(row()), false);
  assert.strictEqual(needsEntitlementCheck(row({ signals_status: 'kicked' })), false);
  assert.strictEqual(needsEntitlementCheck(row({ signals_status: 'invited' })), true);
  assert.strictEqual(needsEntitlementCheck(row({ inplay_status: 'joined' })), true);
});

test('membershipEnabled reads the literal string "true", case-insensitively, and nothing else', () => {
  const snap = snapshotEnv();
  try {
    for (const v of ['true', 'TRUE', 'True']) {
      process.env.TELEGRAM_MEMBERSHIP_ENABLED = v;
      assert.strictEqual(membershipEnabled(), true, `expected ${v} to enable`);
    }
    for (const v of [undefined, '', '1', 'yes', 'false']) {
      if (v === undefined) delete process.env.TELEGRAM_MEMBERSHIP_ENABLED;
      else process.env.TELEGRAM_MEMBERSHIP_ENABLED = v;
      assert.strictEqual(membershipEnabled(), false, `expected ${JSON.stringify(v)} to stay dry-run`);
    }
  } finally { restoreEnv(snap); }
});

// ── run() — the orchestration, async ────────────────────────────────────

async function integrationTests() {
console.log('\nrun() — dry run vs enabled, against fake Supabase and Telegram clients');

await testAsync('fails closed: no bot token -> does nothing, never touches the database', async () => {
  const snap = snapshotEnv();
  try {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    const supabase = untouchableSupabase();
    const bot = untouchableTelegramBot();
    const result = await run({ supabase, telegramBot: bot });
    assert.strictEqual(result.checked, 0);
  } finally { restoreEnv(snap); }
});

await testAsync('dry run (flag unset): computes the plan, zero Telegram calls, zero DB updates', async () => {
  const snap = snapshotEnv();
  try {
    baseTelegramEnv(); // TELEGRAM_MEMBERSHIP_ENABLED left unset
    const rows = [row({ user_id: 'u1', signals_status: 'joined', signals_telegram_user_id: 555 })];
    const supabase = fakeSupabase({ rows, entitled: { u1: false } });
    const bot = fakeTelegramBot();
    const result = await run({ supabase, telegramBot: bot });
    assert.strictEqual(bot.calls.ban.length, 0);
    assert.strictEqual(bot.calls.unban.length, 0);
    assert.strictEqual(bot.calls.revoke.length, 0);
    assert.strictEqual(bot.calls.send.length, 0);
    assert.strictEqual(supabase.updates.length, 0);
    assert.strictEqual(result.kicked, 0);
    assert.strictEqual(result.revoked, 0);
  } finally { restoreEnv(snap); }
});

await testAsync('dry run also makes zero Telegram calls for an explicit "false"', async () => {
  const snap = snapshotEnv();
  try {
    baseTelegramEnv();
    process.env.TELEGRAM_MEMBERSHIP_ENABLED = 'false';
    const rows = [row({ user_id: 'u1', signals_status: 'invited', signals_invite_link: 'x' })];
    const supabase = fakeSupabase({ rows, entitled: { u1: false } });
    const bot = fakeTelegramBot();
    await run({ supabase, telegramBot: bot });
    assert.strictEqual(bot.calls.revoke.length, 0);
    assert.strictEqual(supabase.updates.length, 0);
  } finally { restoreEnv(snap); }
});

await testAsync('enabled: a joined+unentitled row is kicked with the right chat id and telegram user id', async () => {
  const snap = snapshotEnv();
  try {
    baseTelegramEnv();
    process.env.TELEGRAM_MEMBERSHIP_ENABLED = 'true';
    const rows = [row({ user_id: 'u1', signals_status: 'joined', signals_telegram_user_id: 999 })];
    const supabase = fakeSupabase({ rows, entitled: { u1: false } });
    const bot = fakeTelegramBot();
    const result = await run({ supabase, telegramBot: bot });

    assert.strictEqual(bot.calls.ban.length, 1);
    assert.strictEqual(bot.calls.ban[0].chatId, 'MAIN_CHAT');
    assert.strictEqual(bot.calls.ban[0].token, 'MAIN_TOKEN');
    assert.strictEqual(bot.calls.ban[0].userId, 999);

    assert.strictEqual(bot.calls.unban.length, 1);
    assert.strictEqual(bot.calls.unban[0].userId, 999);
    assert.strictEqual(bot.calls.unban[0].opts.only_if_banned, true);

    const upd = supabase.updates.find(u => u.val === 'u1');
    assert.ok(upd, 'expected a status update for u1');
    assert.strictEqual(upd.patch.signals_status, 'kicked');
    assert.strictEqual(upd.col, 'user_id');

    assert.strictEqual(result.kicked, 1);
  } finally { restoreEnv(snap); }
});

await testAsync('enabled: invited+unentitled is revoked, and joined+entitled is left alone entirely', async () => {
  const snap = snapshotEnv();
  try {
    baseTelegramEnv();
    process.env.TELEGRAM_MEMBERSHIP_ENABLED = 'true';
    const rows = [
      row({ user_id: 'u1', signals_status: 'invited', signals_invite_link: 'https://t.me/+abc' }),
      row({ user_id: 'u2', signals_status: 'joined', signals_telegram_user_id: 111 }),
    ];
    const supabase = fakeSupabase({ rows, entitled: { u1: false, u2: true } });
    const bot = fakeTelegramBot();
    const result = await run({ supabase, telegramBot: bot });

    assert.strictEqual(bot.calls.revoke.length, 1);
    assert.strictEqual(bot.calls.revoke[0].inviteLink, 'https://t.me/+abc');
    assert.strictEqual(bot.calls.revoke[0].chatId, 'MAIN_CHAT');

    // u2 is entitled: no ban call, no kick, no update at all.
    assert.strictEqual(bot.calls.ban.length, 0);
    const u2Update = supabase.updates.find(u => u.val === 'u2');
    assert.strictEqual(u2Update, undefined, 'a still-entitled joined row must not be written to at all');

    const u1Update = supabase.updates.find(u => u.val === 'u1');
    assert.strictEqual(u1Update.patch.signals_status, 'revoked');
    assert.strictEqual(result.revoked, 1);
  } finally { restoreEnv(snap); }
});

await testAsync('a revoke API failure is non-fatal and STILL marks the row revoked (low stakes — nobody joined)', async () => {
  const snap = snapshotEnv();
  try {
    baseTelegramEnv();
    process.env.TELEGRAM_MEMBERSHIP_ENABLED = 'true';
    const rows = [row({ user_id: 'u1', signals_status: 'invited', signals_invite_link: 'x' })];
    const supabase = fakeSupabase({ rows, entitled: { u1: false } });
    const bot = fakeTelegramBot({ failRevoke: true });
    const result = await run({ supabase, telegramBot: bot });
    const upd = supabase.updates.find(u => u.val === 'u1');
    assert.strictEqual(upd.patch.signals_status, 'revoked');
    assert.strictEqual(result.ownerNotify.length, 0, 'a failed revoke is low-stakes and must not reach the owner list');
  } finally { restoreEnv(snap); }
});

await testAsync('a kick API failure lands the row in the owner-notify list and does NOT flip status to kicked', async () => {
  const snap = snapshotEnv();
  try {
    baseTelegramEnv();
    process.env.TELEGRAM_MEMBERSHIP_ENABLED = 'true';
    const rows = [row({ user_id: 'u1', signals_status: 'joined', signals_telegram_user_id: 42 })];
    const supabase = fakeSupabase({ rows, entitled: { u1: false } });
    const bot = fakeTelegramBot({ failBan: true });
    const result = await run({ supabase, telegramBot: bot });

    assert.strictEqual(result.ownerNotify.length, 1);
    assert.strictEqual(result.ownerNotify[0].user_id, 'u1');
    assert.strictEqual(result.ownerNotify[0].channel, 'signals');
    assert.ok(/kick failed/.test(result.ownerNotify[0].reason));

    const upd = supabase.updates.find(u => u.val === 'u1');
    assert.strictEqual(upd, undefined, 'must not have written any status change when the kick failed');
    assert.strictEqual(result.kicked, 0);
  } finally { restoreEnv(snap); }
});

await testAsync('a row with joined status but a null telegram_user_id goes straight to owner-notify, no Telegram call attempted', async () => {
  const snap = snapshotEnv();
  try {
    baseTelegramEnv();
    process.env.TELEGRAM_MEMBERSHIP_ENABLED = 'true';
    const rows = [row({ user_id: 'u1', signals_status: 'joined', signals_telegram_user_id: null })];
    const supabase = fakeSupabase({ rows, entitled: { u1: false } });
    const bot = fakeTelegramBot();
    const result = await run({ supabase, telegramBot: bot });

    assert.strictEqual(bot.calls.ban.length, 0);
    assert.strictEqual(bot.calls.unban.length, 0);
    assert.strictEqual(result.ownerNotify.length, 1);
    assert.strictEqual(result.ownerNotify[0].telegram_user_id, null);
    assert.ok(/telegram_user_id/.test(result.ownerNotify[0].reason));
  } finally { restoreEnv(snap); }
});

await testAsync('owner notification uses TELEGRAM_OWNER_CHAT_ID when set', async () => {
  const snap = snapshotEnv();
  try {
    baseTelegramEnv();
    process.env.TELEGRAM_MEMBERSHIP_ENABLED = 'true';
    process.env.TELEGRAM_OWNER_CHAT_ID = 'OWNER_CHAT';
    const rows = [row({ user_id: 'u1', signals_status: 'joined', signals_telegram_user_id: null })];
    const supabase = fakeSupabase({ rows, entitled: { u1: false } });
    const bot = fakeTelegramBot();
    await run({ supabase, telegramBot: bot });

    assert.strictEqual(bot.calls.send.length, 1);
    assert.strictEqual(bot.calls.send[0].chatId, 'OWNER_CHAT');
    assert.ok(bot.calls.send[0].text.includes('u1'), 'the summary must name the affected user');
  } finally { restoreEnv(snap); }
});

await testAsync('owner notification with TELEGRAM_OWNER_CHAT_ID unset logs instead of throwing', async () => {
  const snap = snapshotEnv();
  try {
    baseTelegramEnv();
    process.env.TELEGRAM_MEMBERSHIP_ENABLED = 'true';
    delete process.env.TELEGRAM_OWNER_CHAT_ID;
    const rows = [row({ user_id: 'u1', signals_status: 'joined', signals_telegram_user_id: null })];
    const supabase = fakeSupabase({ rows, entitled: { u1: false } });
    const bot = fakeTelegramBot();
    // Must resolve, not reject, even with nowhere to send the notification.
    await run({ supabase, telegramBot: bot });
    assert.strictEqual(bot.calls.send.length, 0);
  } finally { restoreEnv(snap); }
});

await testAsync('a sendMessage failure to the owner is swallowed, not thrown', async () => {
  const snap = snapshotEnv();
  try {
    baseTelegramEnv();
    process.env.TELEGRAM_MEMBERSHIP_ENABLED = 'true';
    process.env.TELEGRAM_OWNER_CHAT_ID = 'OWNER_CHAT';
    const rows = [row({ user_id: 'u1', signals_status: 'joined', signals_telegram_user_id: null })];
    const supabase = fakeSupabase({ rows, entitled: { u1: false } });
    const bot = fakeTelegramBot({ failSend: true });
    await run({ supabase, telegramBot: bot }); // must not throw
  } finally { restoreEnv(snap); }
});

await testAsync('rows needing no decision are never asked about entitlement (no RPC call issued)', async () => {
  const snap = snapshotEnv();
  try {
    baseTelegramEnv();
    process.env.TELEGRAM_MEMBERSHIP_ENABLED = 'true';
    const rows = [
      row({ user_id: 'u1', signals_status: 'none', inplay_status: 'none' }),
      row({ user_id: 'u2', signals_status: 'kicked', inplay_status: 'revoked' }),
    ];
    const supabase = fakeSupabase({ rows, entitled: {} });
    const bot = fakeTelegramBot();
    const result = await run({ supabase, telegramBot: bot });
    assert.strictEqual(supabase.rpcCalls.length, 0, 'no row here can act on anything — entitlement should never be asked');
    assert.strictEqual(result.skipped, 2);
    assert.strictEqual(result.checked, 0);
  } finally { restoreEnv(snap); }
});

await testAsync('the two channels act independently on one row: kicked on signals, revoked on inplay, each with its own chat id', async () => {
  const snap = snapshotEnv();
  try {
    baseTelegramEnv();
    process.env.TELEGRAM_MEMBERSHIP_ENABLED = 'true';
    const rows = [row({
      user_id: 'u1',
      signals_status: 'joined', signals_telegram_user_id: 1,
      inplay_status: 'invited', inplay_invite_link: 'inplay-link',
    })];
    const supabase = fakeSupabase({ rows, entitled: { u1: false } });
    const bot = fakeTelegramBot();
    const result = await run({ supabase, telegramBot: bot });

    assert.strictEqual(bot.calls.ban.length, 1, 'signals side must kick');
    assert.strictEqual(bot.calls.ban[0].chatId, 'MAIN_CHAT', 'the signals kick must use the signals chat id');
    assert.strictEqual(bot.calls.revoke.length, 1, 'inplay side must revoke');
    assert.strictEqual(bot.calls.revoke[0].chatId, 'INPLAY_CHAT', 'the inplay revoke must use the inplay chat id, not the signals one');
    assert.strictEqual(bot.calls.revoke[0].inviteLink, 'inplay-link');

    // Two separate update() calls land for one user_id — one per channel.
    const allForU1 = supabase.updates.filter(u => u.val === 'u1');
    assert.strictEqual(allForU1.length, 2);
    const patches = Object.assign({}, ...allForU1.map(u => u.patch));
    assert.strictEqual(patches.signals_status, 'kicked');
    assert.strictEqual(patches.inplay_status, 'revoked');
    assert.strictEqual(result.kicked, 1);
    assert.strictEqual(result.revoked, 1);
  } finally { restoreEnv(snap); }
});

}

integrationTests().then(() => {
  console.log(`\n${passed} passed${process.exitCode ? ' (with failures)' : ''}`);
});
