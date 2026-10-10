'use strict';

/**
 * lib/discordRoles — keeps the Plus role in the MaxEdge Discord in step with
 * the plan each linked member is actually on.
 *
 * ── WHAT DECIDES "SHOULD HOLD PLUS" ─────────────────────────────────────────
 *
 * The database, never Stripe events. `discord_role_targets` (migration 138)
 * answers `wants_plus` through `tier_for()`, the same rule `current_tier()`
 * and every RLS policy use, so a member Discord treats as Plus is exactly a
 * member the site treats as Plus. A missed webhook, a refund done by hand, a
 * trial running out at 3am: the next run moves the role to match.
 *
 * ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
 *
 *   - Touch a member who has not linked an account. Listing a guild's members
 *     needs the privileged Server Members intent, which the bot does not have
 *     and does not need: it only ever looks up the ids in `discord_links`.
 *   - Revoke in bulk. If one run would take Plus from more than
 *     MAX_REVOKES_PER_RUN members it refuses the lot. The likeliest cause of a
 *     mass revoke is a tier read gone wrong, not a mass cancellation, and a
 *     paying member losing #signals is worse than a lapsed one keeping it for
 *     ten more minutes. `DISCORD_ROLE_FORCE=1` lifts it for one run.
 *   - Use a role it cannot be sure of. The Plus role is found by exact name
 *     (or DISCORD_PLUS_ROLE_ID) and refused if two roles share the name, if it
 *     is @everyone, or if it is managed by an integration.
 *
 * Pure decisions are separated from the I/O so the tests drive every branch
 * without a network.
 */

const API = 'https://discord.com/api/v10';
const TIMEOUT_MS = 15000;
const MAX_REVOKES_PER_RUN = 10;
const DEFAULT_GUILD_ID = '1558073072010137722';   // the public MaxEdge server
const PLUS_ROLE_NAME = 'Plus';

const SNOWFLAKE = /^\d{15,21}$/;

// ── Pure ─────────────────────────────────────────────────────────────────────

/**
 * One linked member: what to do and what to record.
 *   target  a discord_role_targets row
 *   member  the guild member object, or null when they are not in the server
 */
function decide(target, member, plusRoleId) {
  if (!SNOWFLAKE.test(String(target?.discord_user_id ?? ''))) {
    return { action: 'none', state: 'error', note: 'stored Discord id is not a valid id' };
  }
  if (!member) {
    return { action: 'none', state: 'not_in_server', note: 'linked but has not joined the server' };
  }
  const has = Array.isArray(member.roles) && member.roles.includes(plusRoleId);
  const wants = target.wants_plus === true;
  if (wants && !has) return { action: 'grant', state: 'plus', note: null };
  if (!wants && has) return { action: 'revoke', state: 'no_plus', note: null };
  return { action: 'none', state: has ? 'plus' : 'no_plus', note: null };
}

/** The Plus role out of a guild's role list, or a reason it cannot be used. */
function resolvePlusRole(roles, { roleId = null, guildId } = {}) {
  if (!Array.isArray(roles)) return { error: 'could not read the server roles' };
  const found = roleId
    ? roles.filter(r => r.id === roleId)
    : roles.filter(r => r.name === PLUS_ROLE_NAME);
  if (found.length === 0) return { error: roleId ? `no role with id ${roleId}` : `no role named "${PLUS_ROLE_NAME}"` };
  if (found.length > 1) return { error: `${found.length} roles named "${PLUS_ROLE_NAME}", set DISCORD_PLUS_ROLE_ID` };
  const role = found[0];
  if (role.id === guildId) return { error: 'refusing @everyone as the Plus role' };
  if (role.managed) return { error: 'refusing a role managed by an integration' };
  return { role };
}

/** Plan a whole run. Refuses a mass revoke unless forced. */
function plan(decisions, { force = false, maxRevokes = MAX_REVOKES_PER_RUN } = {}) {
  const revokes = decisions.filter(d => d.decision.action === 'revoke').length;
  const grants = decisions.filter(d => d.decision.action === 'grant').length;
  if (revokes > maxRevokes && !force) {
    return { ok: false, grants, revokes, reason: `would remove Plus from ${revokes} members (limit ${maxRevokes}); refusing the whole run` };
  }
  return { ok: true, grants, revokes };
}

// ── I/O ──────────────────────────────────────────────────────────────────────

/**
 * One call to the Discord REST API as the bot. Retries a 429 once after the
 * time Discord asks for; any other non-2xx throws with the status on it.
 */
async function discordApi(path, { method = 'GET', token, reason, fetchImpl = fetch } = {}) {
  if (!token) throw new Error('discordApi: no bot token');
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = { Authorization: `Bot ${token}` };
    if (reason) headers['X-Audit-Log-Reason'] = encodeURIComponent(reason);
    const res = await fetchImpl(`${API}${path}`, { method, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 429 && attempt === 0) {
      const body = await res.json().catch(() => ({}));
      const wait = Math.min(Number(body.retry_after) || 1, 10);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    if (res.status === 204) return null;
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(`discord ${method} ${path} HTTP ${res.status}`);
      err.status = res.status;
      err.code = body?.code ?? null;
      throw err;
    }
    return body;
  }
  throw new Error(`discord ${method} ${path}: still rate limited`);
}

/** The guild member, or null when they are not in the server (code 10007). */
async function fetchMember(guildId, userId, opts) {
  try {
    return await discordApi(`/guilds/${guildId}/members/${userId}`, opts);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

function setRole(guildId, userId, roleId, add, opts) {
  return discordApi(`/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
    ...opts,
    method: add ? 'PUT' : 'DELETE',
    reason: add ? 'MaxEdge Plus active' : 'MaxEdge Plus ended',
  });
}

module.exports = {
  decide, resolvePlusRole, plan,
  discordApi, fetchMember, setRole,
  MAX_REVOKES_PER_RUN, DEFAULT_GUILD_ID, PLUS_ROLE_NAME,
};
