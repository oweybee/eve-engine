import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// lineup-dms
//
// Lineup alerts for Plus members (migration 197). When both confirmed XIs for
// a fixture are in, every Plus member who follows either side and has linked
// Discord gets one DM from the MAXEDGE bot with both lineups.
//
// Caller: pg_cron every 2 minutes with x-cron-secret (action "tick").
// Who is due is decided in SQL (lineup_dms_due): scheduled, kicks off within
// two hours, both XIs fetched in the last six hours, member is Plus right now,
// not already sent, not marked as blocking DMs. This function only formats,
// sends and records.
//
// Pacing: one member at a time, a short gap between members, Discord's own
// retry_after honoured on a 429, and a time budget so a busy Saturday 15:00
// spills into the next run instead of being cut off mid-send.
//
// Action "test" { discord_user_id, fixture_id }: sends that fixture's lineups
// to one Discord user regardless of follows or timing, and records nothing.
// For checking the card by hand.
//
// Secrets: DISCORD_BOT_TOKEN (shared with discord-predictor).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_TOKEN = Deno.env.get("DISCORD_BOT_TOKEN") ?? "";
const SITE = "https://maxedge.live";
const API = "https://discord.com/api/v10";
const BRAND = 0xa6e57e; // embed accent
const BUDGET_MS = 110_000;
const GAP_MS = 250;

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + "…");

type Due = {
  fixture_id: string; match_id: string; kickoff_at: string; home: string; away: string; league: string | null;
  home_api_id: number; away_api_id: number; user_id: string; discord_user_id: string; followed: string[];
};
type Side = { team_id: number; team_name: string; formation: string | null; coach: string | null; starting_xi: any[] };

const ukTime = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false })
    .format(new Date(iso));

export function xiLines(xi: any[]): string {
  return (xi ?? []).map((e) => {
    const p = e?.player ?? e ?? {};
    const num = p.number ?? p.shirt_number;
    return `\`${String(num ?? "").padStart(2, " ")}\` ${p.name ?? "Unknown"}`;
  }).join("\n");
}

export function buildMessage(d: Pick<Due, "match_id" | "kickoff_at" | "home" | "away" | "league" | "followed">, home: Side, away: Side) {
  const fixture = `${d.home} v ${d.away}`;
  const field = (s: Side, fallback: string) => ({
    name: clip(`${s.team_name || fallback}${s.formation ? ` · ${s.formation}` : ""}`, 256),
    value: clip(xiLines(s.starting_xi) + (s.coach ? `\n*Manager: ${s.coach}*` : ""), 1024) || "Not announced",
    inline: true,
  });
  const follows = d.followed.length > 1 ? `${d.followed.join(" and ")}` : d.followed[0] ?? fixture;
  return {
    content: `**Lineups are in: ${fixture}**`,
    allowed_mentions: { parse: [] },
    embeds: [{
      title: clip(fixture, 256),
      url: `${SITE}/match/${d.match_id}`,
      description: `${d.league ? `${d.league} · ` : ""}Kick-off ${ukTime(d.kickoff_at)}`,
      color: BRAND,
      fields: [field(home, d.home), field(away, d.away)],
      footer: { text: clip(`You follow ${follows} on MAXEDGE. Plus lineup alerts.`, 2048) },
    }],
    components: [{ type: 1, components: [
      { type: 2, style: 5, label: "Open the match", url: `${SITE}/match/${d.match_id}` },
      { type: 2, style: 5, label: "Change my teams", url: `${SITE}/me/settings?panel=teams` },
    ]}],
  };
}

async function discord(path: string, method: string, payload?: unknown, tries = 3): Promise<{ ok: boolean; status: number; body: any }> {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bot ${BOT_TOKEN}`, "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (res.status === 429) {
      const wait = Math.ceil(((body?.retry_after ?? 1) as number) * 1000) + 100;
      console.warn(`[lineup-dms] 429 on ${path}, waiting ${wait}ms`);
      await sleep(Math.min(wait, 15_000));
      continue;
    }
    return { ok: res.ok, status: res.status, body };
  }
  return { ok: false, status: 429, body: { message: "rate limited" } };
}

async function sides(fixtureId: string, homeApi: number, awayApi: number): Promise<[Side, Side] | null> {
  const { data, error } = await db.from("lineups")
    .select("team_id, team_name, formation, coach, starting_xi, confirmed, fetched_at")
    .eq("fixture_id", fixtureId).eq("confirmed", true)
    .order("fetched_at", { ascending: false });
  if (error) throw error;
  const pick = (id: number) => (data ?? []).find((r: any) => r.team_id === id) as Side | undefined;
  const h = pick(homeApi), a = pick(awayApi);
  return h && a ? [h, a] : null;
}

async function sendDm(discordUserId: string, message: unknown): Promise<{ status: "sent" | "dm_blocked" | "failed"; error?: string; messageId?: string }> {
  const ch = await discord(`/users/@me/channels`, "POST", { recipient_id: discordUserId });
  if (!ch.ok || !ch.body?.id) {
    // 50007 / 50278: the member blocks DMs from server members or has left every shared server.
    const code = ch.body?.code;
    const blocked = code === 50007 || code === 50278;
    return { status: blocked ? "dm_blocked" : "failed", error: `channel ${ch.status} ${code ?? ""} ${ch.body?.message ?? ""}`.trim() };
  }
  const msg = await discord(`/channels/${ch.body.id}/messages`, "POST", message);
  if (!msg.ok) {
    const code = msg.body?.code;
    return { status: code === 50007 ? "dm_blocked" : "failed", error: `message ${msg.status} ${code ?? ""} ${msg.body?.message ?? ""}`.trim() };
  }
  return { status: "sent", messageId: msg.body?.id };
}

async function tick() {
  const started = Date.now();
  if (!BOT_TOKEN) return { ok: false, error: "DISCORD_BOT_TOKEN missing" };
  const { data, error } = await db.rpc("lineup_dms_due", { p_limit: 400 });
  if (error) throw error;
  const due = (data ?? []) as Due[];
  const cache = new Map<string, [Side, Side] | null>();
  const tally = { due: due.length, sent: 0, dm_blocked: 0, failed: 0, skipped_no_lineup: 0, deferred: 0 };

  for (const d of due) {
    if (Date.now() - started > BUDGET_MS) { tally.deferred = due.length - (tally.sent + tally.dm_blocked + tally.failed + tally.skipped_no_lineup); break; }
    if (!cache.has(d.fixture_id)) cache.set(d.fixture_id, await sides(d.fixture_id, d.home_api_id, d.away_api_id));
    const s = cache.get(d.fixture_id);
    if (!s) { tally.skipped_no_lineup++; continue; }
    const r = await sendDm(d.discord_user_id, buildMessage(d, s[0], s[1]));
    const { error: e } = await db.rpc("record_lineup_dm", {
      p_fixture: d.fixture_id, p_user: d.user_id, p_discord: d.discord_user_id,
      p_status: r.status, p_error: r.error ?? null, p_message_id: r.messageId ?? null,
    });
    if (e) console.error("[lineup-dms] record failed", e.message);
    tally[r.status]++;
    if (r.status !== "sent") console.warn(`[lineup-dms] ${r.status} ${d.fixture_id} ${d.user_id}: ${r.error}`);
    await sleep(GAP_MS);
  }
  return { ok: true, ...tally, ms: Date.now() - started };
}

async function test(discordUserId: string, fixtureId: string) {
  const { data: m, error } = await db.from("matches")
    .select("id, external_id, kickoff_at, home:teams!matches_home_team_id_fkey(name, external_id), away:teams!matches_away_team_id_fkey(name, external_id), league:leagues(name)")
    .eq("external_id", fixtureId).maybeSingle();
  if (error || !m) return { ok: false, error: error?.message ?? "fixture not found" };
  const mm = m as any;
  const s = await sides(fixtureId, Number(mm.home.external_id), Number(mm.away.external_id));
  if (!s) return { ok: false, error: "no confirmed lineups for both sides" };
  const msg = buildMessage({
    match_id: mm.id, kickoff_at: mm.kickoff_at, home: mm.home.name, away: mm.away.name,
    league: mm.league?.name ?? null, followed: [mm.home.name],
  }, s[0], s[1]);
  return { ok: true, result: await sendDm(discordUserId, msg) };
}

async function cronSecretOk(given: string | null): Promise<boolean> {
  if (!given) return false;
  const { data, error } = await db.rpc("check_discord_cron_secret", { p_secret: given });
  if (error) { console.error("[lineup-dms] secret check failed", error.message); return false; }
  return data === true;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!(await cronSecretOk(req.headers.get("x-cron-secret")))) return json({ error: "not found" }, 404);
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  try {
    if (body.action === "tick") return json(await tick());
    if (body.action === "test") return json(await test(String(body.discord_user_id ?? ""), String(body.fixture_id ?? "")));
    return json({ error: `unknown action ${body.action}` }, 400);
  } catch (e) {
    console.error("[lineup-dms] failed", e);
    return json({ ok: false, error: String(e) }, 500);
  }
});
