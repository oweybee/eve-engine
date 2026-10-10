'use strict';

/**
 * syncDiscordRoles — gives and removes the Plus role in the MaxEdge Discord so
 * it matches each linked member's plan. See lib/discordRoles for the rules.
 *
 *   node syncDiscordRoles.js            act (needs DISCORD_ROLE_SYNC_ENABLED=1)
 *   DRY_RUN=1 node syncDiscordRoles.js  read everything, change nothing
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   DISCORD_BOT_TOKEN          the bot holds Manage Roles and nothing else
 *   DISCORD_GUILD_ID           defaults to the public MaxEdge server
 *   DISCORD_PLUS_ROLE_ID       optional; otherwise the role named "Plus"
 *   DISCORD_ROLE_SYNC_ENABLED  must be exactly '1' to change anything
 *   DISCORD_ROLE_FORCE         '1' lifts the mass-revoke guard for one run
 */

const { createClient } = require('@supabase/supabase-js');
const {
  decide, resolvePlusRole, plan, discordApi, fetchMember, setRole, DEFAULT_GUILD_ID,
} = require('./lib/discordRoles');

async function run() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  if (!token) { console.log('[discordRoles] no DISCORD_BOT_TOKEN, skipping'); return; }

  const enabled = process.env.DISCORD_ROLE_SYNC_ENABLED === '1';
  const dry = process.env.DRY_RUN === '1' || !enabled;
  const guildId = process.env.DISCORD_GUILD_ID || DEFAULT_GUILD_ID;
  const opts = { token };
  const supabase = createClient(url, key);

  const { data: targets, error } = await supabase.from('discord_role_targets')
    .select('user_id, discord_user_id, role_state, wants_plus');
  if (error && (error.code === 'PGRST205' || error.code === '42P01')) {
    // Migration 138 has not been applied yet. A warning, not a red run every
    // ten minutes: there is nothing to sync until the table exists.
    console.log('::warning::discord_role_targets does not exist yet: apply migration 138');
    return;
  }
  if (error) throw new Error(`discord_role_targets: ${error.message}`);
  console.log(`[discordRoles] ${targets.length} linked account(s)${dry ? ' (dry run, nothing will change)' : ''}`);
  if (!targets.length) return;

  const roles = await discordApi(`/guilds/${guildId}/roles`, opts);
  const resolved = resolvePlusRole(roles, { roleId: process.env.DISCORD_PLUS_ROLE_ID || null, guildId });
  if (resolved.error) throw new Error(`[discordRoles] ${resolved.error}`);
  const plusId = resolved.role.id;

  const decisions = [];
  for (const t of targets) {
    let member = null, readError = null;
    try { member = await fetchMember(guildId, t.discord_user_id, opts); }
    catch (e) { readError = e; }
    const decision = readError
      ? { action: 'none', state: 'error', note: `member lookup failed: HTTP ${readError.status ?? '?'}` }
      : decide(t, member, plusId);
    decisions.push({ target: t, decision });
  }

  const p = plan(decisions, { force: process.env.DISCORD_ROLE_FORCE === '1' });
  console.log(`[discordRoles] plan: ${p.grants} to grant, ${p.revokes} to remove`);
  if (!p.ok) throw new Error(`[discordRoles] ${p.reason}`);

  let changed = 0;
  for (const { target, decision } of decisions) {
    let { state, note } = decision;
    if (decision.action !== 'none') {
      const verb = decision.action === 'grant' ? 'grant' : 'remove';
      if (dry) {
        console.log(`[discordRoles] would ${verb} Plus: ${target.user_id}`);
        continue;
      }
      try {
        await setRole(guildId, target.discord_user_id, plusId, decision.action === 'grant', opts);
        changed++;
        console.log(`[discordRoles] ${verb} Plus: ${target.user_id}`);
      } catch (e) {
        state = 'error';
        note = `could not ${verb} Plus: HTTP ${e.status ?? '?'}${e.status === 403 ? ' (is the bot role above Plus?)' : ''}`;
        console.log(`[discordRoles] ${note}: ${target.user_id}`);
      }
    }
    if (dry) continue;
    const { error: wErr } = await supabase.from('discord_links')
      .update({ role_state: state, role_note: note, role_synced_at: new Date().toISOString() })
      .eq('user_id', target.user_id);
    if (wErr) console.log(`[discordRoles] ledger write failed for ${target.user_id}: ${wErr.message}`);
  }
  console.log(`[discordRoles] done: ${changed} role change(s)`);
}

if (require.main === module) {
  run().catch(e => { console.error(e.message || e); process.exit(1); });
}

module.exports = { run };
