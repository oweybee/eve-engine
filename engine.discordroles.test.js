'use strict';
// lib/discordRoles — the Plus role follows the plan, and nothing else.

const assert = require('assert');
const fs = require('fs');
const { decide, resolvePlusRole, plan, discordApi, fetchMember, MAX_REVOKES_PER_RUN } = require('./lib/discordRoles');

let n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

const PLUS = '1558100000000000001';
const GUILD = '1558073072010137722';
const target = (wants, id = '123456789012345678') => ({ user_id: 'u1', discord_user_id: id, wants_plus: wants });
const member = (...roles) => ({ roles });

t('a paying member without the role is granted it', () => {
  assert.deepStrictEqual(decide(target(true), member(), PLUS), { action: 'grant', state: 'plus', note: null });
});

t('a lapsed member holding the role loses it', () => {
  assert.deepStrictEqual(decide(target(false), member(PLUS), PLUS), { action: 'revoke', state: 'no_plus', note: null });
});

t('a member already in step is left alone', () => {
  assert.strictEqual(decide(target(true), member(PLUS), PLUS).action, 'none');
  assert.strictEqual(decide(target(false), member('999'), PLUS).action, 'none');
  assert.strictEqual(decide(target(false), member(), PLUS).state, 'no_plus');
});

t('a linked member who has not joined is recorded, not acted on', () => {
  const d = decide(target(true), null, PLUS);
  assert.strictEqual(d.action, 'none');
  assert.strictEqual(d.state, 'not_in_server');
});

t('wants_plus must be literally true: null or a string never grants', () => {
  assert.strictEqual(decide({ ...target(true), wants_plus: null }, member(), PLUS).action, 'none');
  assert.strictEqual(decide({ ...target(true), wants_plus: 'true' }, member(), PLUS).action, 'none');
});

t('a malformed stored id is an error, never a lookup', () => {
  const d = decide(target(true, 'abc'), member(), PLUS);
  assert.strictEqual(d.action, 'none');
  assert.strictEqual(d.state, 'error');
});

t('the Plus role is found by exact name', () => {
  const r = resolvePlusRole([{ id: GUILD, name: '@everyone' }, { id: PLUS, name: 'Plus' }, { id: '2', name: 'plus fans' }], { guildId: GUILD });
  assert.strictEqual(r.role.id, PLUS);
});

t('two roles called Plus is refused, not guessed', () => {
  const r = resolvePlusRole([{ id: '1', name: 'Plus' }, { id: '2', name: 'Plus' }], { guildId: GUILD });
  assert(r.error && /2 roles/.test(r.error));
});

t('@everyone and integration-managed roles are refused', () => {
  assert(resolvePlusRole([{ id: GUILD, name: 'Plus' }], { guildId: GUILD }).error);
  assert(resolvePlusRole([{ id: PLUS, name: 'Plus', managed: true }], { guildId: GUILD }).error);
});

t('an explicit role id wins over the name', () => {
  const r = resolvePlusRole([{ id: PLUS, name: 'Plus' }, { id: '777', name: 'Members' }], { roleId: '777', guildId: GUILD });
  assert.strictEqual(r.role.id, '777');
  assert(resolvePlusRole([{ id: PLUS, name: 'Plus' }], { roleId: '888', guildId: GUILD }).error);
});

t('a mass revoke is refused as a whole run', () => {
  const many = Array.from({ length: MAX_REVOKES_PER_RUN + 1 }, () => ({ decision: { action: 'revoke' } }));
  const p = plan(many);
  assert.strictEqual(p.ok, false);
  assert.strictEqual(plan(many, { force: true }).ok, true);
  assert.strictEqual(plan(many.slice(1)).ok, true);   // exactly at the limit is allowed
});

t('the API retries one 429 and then succeeds', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return { status: 429, ok: false, json: async () => ({ retry_after: 0.01 }) };
    return { status: 200, ok: true, json: async () => ({ id: 'x' }) };
  };
  const body = await discordApi('/x', { token: 't', fetchImpl });
  assert.deepStrictEqual(body, { id: 'x' });
  assert.strictEqual(calls, 2);
});

t('the bot token is sent as a Bot header and never without one', async () => {
  let seen = null;
  const fetchImpl = async (_u, o) => { seen = o.headers.Authorization; return { status: 204, ok: true }; };
  await discordApi('/x', { token: 'abc', fetchImpl });
  assert.strictEqual(seen, 'Bot abc');
  await assert.rejects(() => discordApi('/x', { token: '', fetchImpl }));
});

t('a 404 member lookup means not in the server; other failures throw', async () => {
  const notFound = async () => ({ status: 404, ok: false, json: async () => ({ code: 10007 }) });
  assert.strictEqual(await fetchMember(GUILD, '123456789012345678', { token: 't', fetchImpl: notFound }), null);
  const forbidden = async () => ({ status: 403, ok: false, json: async () => ({ code: 50013 }) });
  await assert.rejects(() => fetchMember(GUILD, '123456789012345678', { token: 't', fetchImpl: forbidden }));
});

t('the sync changes nothing unless the switch is exactly "1"', () => {
  const src = fs.readFileSync(require.resolve('./syncDiscordRoles'), 'utf8');
  assert(/DISCORD_ROLE_SYNC_ENABLED === '1'/.test(src));
  assert(/dry = .*!enabled/.test(src));
});

(async () => {
  for (const [name, fn] of tests) { await fn(); n++; console.log(`ok ${n} ${name}`); }
  console.log(`\n${n} passed`);
})().catch(e => { console.error(e); process.exit(1); });
