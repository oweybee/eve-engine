import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// discord-predictor
//
// The weekly Premier League predictor in the MAXEDGE Discord (migration 115).
//
// Two callers:
//  1. Discord, at the app's Interactions Endpoint URL. Every request is
//     Ed25519-signed; anything unsigned is refused. Handles /predict (two
//     forms of up to 5 games, because a Discord form holds 5 boxes),
//     /mypredictions and /leaderboard. Also /teams (migration 197): a private
//     reply with the member's lineup-alert teams and a button to the site's
//     picker. Lineup alerts are Plus only; the DMs themselves are sent by the
//     lineup-dms function.
//  2. pg_cron every 10 minutes with x-cron-secret (action "tick"): opens the
//     next round and announces it, posts a reminder ~3h before the first
//     kick-off, and posts the leaderboard and moves the Top Predictor role
//     once every game in the round has a result. Action "register" installs
//     the slash commands (run once by hand).
//
// Rules: correct score, 3 points exact, 1 point right result, ties split by
// exact scores. Each game locks at its own kick-off (also enforced by a
// trigger in the database). No entry fee and no prizes, which keeps it within
// Discord's gambling policy. No prices or odds anywhere in this feature.
//
// Secrets: DISCORD_BOT_TOKEN (owner sets), DISCORD_PUBLIC_KEY, DISCORD_APP_ID,
// PREDICTOR_CHANNEL_ID, PREDICTOR_ROLE_ID, DISCORD_GUILD_ID (optional).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Public values (not secrets): the MaxEdge app, the MAXEDGE server and #predictor.
const PUBLIC_KEY = Deno.env.get("DISCORD_PUBLIC_KEY") ?? "f522088bac4c4f41065dac46e449c0c59012fbd01987c854b66eef16502a5211";
const APP_ID = Deno.env.get("DISCORD_APP_ID") ?? "1558155726449414144";
const BOT_TOKEN = Deno.env.get("DISCORD_BOT_TOKEN") ?? "";
const GUILD_ID = Deno.env.get("DISCORD_GUILD_ID") ?? "1558073072010137722";
const CHANNEL_ID = Deno.env.get("PREDICTOR_CHANNEL_ID") ?? "1560684613645369354";
const ROLE_NAME = "Top Predictor";
const TROPHY = "\u{1F3C6}";
let ROLE_ID = Deno.env.get("PREDICTOR_ROLE_ID") ?? "";
const API = "https://discord.com/api/v10";
const EPHEMERAL = 64;
const PER_FORM = 5;
const SITE = "https://maxedge.live";
const linkButtons = (...b: { label: string; url: string }[]) =>
  [{ type: 1, components: b.map((x) => ({ type: 2, style: 5, label: x.label, url: x.url })) }];

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

type Fixture = {
  slot: number; match_id: string; home: string; away: string; kickoff_at: string;
  locked: boolean; status: string; goals_home: number | null; goals_away: number | null;
};
type Round = {
  id: number; label: string; first_kickoff: string; last_kickoff: string; status: string;
  announced_at: string | null; reminded_at: string | null; winner_ids: string[];
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// ---------- helpers ----------

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function verifyDiscord(req: Request, body: string): Promise<boolean> {
  const sig = req.headers.get("x-signature-ed25519");
  const ts = req.headers.get("x-signature-timestamp");
  if (!sig || !ts || !PUBLIC_KEY) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hexToBytes(PUBLIC_KEY), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, hexToBytes(sig), new TextEncoder().encode(ts + body));
  } catch (e) {
    console.error("[predictor] verify error", e);
    return false;
  }
}

const SHORT: Record<string, string> = {
  "Manchester City": "Man City",
  "Manchester United": "Man United",
  "Nottingham Forest": "Nott'm Forest",
  "Wolverhampton Wanderers": "Wolves",
  "Brighton & Hove Albion": "Brighton",
  "West Ham United": "West Ham",
  "Newcastle United": "Newcastle",
  "Tottenham Hotspur": "Tottenham",
};
const short = (n: string) => SHORT[n] ?? n;

const ukWhen = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(iso)).replace(",", "");

const game = (f: Fixture) => `${short(f.home)} v ${short(f.away)}`;
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + "…");

function parseScore(raw: string): [number, number] | null {
  const m = raw.trim().match(/^(\d{1,2})\s*[-:–]\s*(\d{1,2})$/);
  if (!m) return null;
  const h = Number(m[1]), a = Number(m[2]);
  if (h > 20 || a > 20) return null;
  return [h, a];
}

function who(body: any): { id: string; name: string } {
  const u = body.member?.user ?? body.user;
  const name = body.member?.nick || u?.global_name || u?.username || "player";
  return { id: String(u?.id), name: String(name).slice(0, 64) };
}

async function openRound(): Promise<Round | null> {
  const { data, error } = await db.from("predictor_rounds").select("*").eq("status", "open")
    .order("id", { ascending: false }).limit(1);
  if (error) throw error;
  return (data?.[0] as Round) ?? null;
}

async function lastRound(): Promise<Round | null> {
  const { data, error } = await db.from("predictor_rounds").select("*").order("id", { ascending: false }).limit(1);
  if (error) throw error;
  return (data?.[0] as Round) ?? null;
}

async function fixtures(roundId: number): Promise<Fixture[]> {
  const { data, error } = await db.rpc("predictor_round_fixtures", { p_round: roundId });
  if (error) throw error;
  return (data ?? []) as Fixture[];
}

async function myPicks(roundId: number, userId: string): Promise<Map<string, { home: number; away: number }>> {
  const { data, error } = await db.from("predictor_entries").select("match_id, home, away")
    .eq("round_id", roundId).eq("discord_user_id", userId);
  if (error) throw error;
  return new Map((data ?? []).map((r: any) => [r.match_id, { home: r.home, away: r.away }]));
}

async function discord(path: string, method: string, payload?: unknown): Promise<Response> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bot ${BOT_TOKEN}`, "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  if (!res.ok) console.error(`[predictor] ${method} ${path} -> ${res.status} ${(await res.clone().text()).slice(0, 300)}`);
  return res;
}

async function post(content: string, mentionUsers: string[] = [], components?: unknown[]) {
  if (!CHANNEL_ID || !BOT_TOKEN) {
    console.warn("[predictor] PREDICTOR_CHANNEL_ID or DISCORD_BOT_TOKEN missing; not posting");
    return false;
  }
  const res = await discord(`/channels/${CHANNEL_ID}/messages`, "POST", {
    content: clip(content, 1990),
    allowed_mentions: { parse: [], users: mentionUsers.slice(0, 20) },
    components,
  });
  return res.ok;
}

// One tap opens the form: no slash command to type.
const ENTER_BUTTON = [{ type: 1, components: [
  { type: 2, style: 3, label: "Enter predictions", emoji: { name: "\u26BD" }, custom_id: "pred:open" },
  { type: 2, style: 2, label: "My picks", custom_id: "pred:mine" },
]}];

// ---------- forms ----------

function formFor(round: Round, fx: Fixture[], picks: Map<string, { home: number; away: number }>, page: number) {
  const open = fx.filter((f) => !f.locked);
  const chunk = open.slice(page * PER_FORM, page * PER_FORM + PER_FORM);
  if (!chunk.length) return null;
  const from = page * PER_FORM + 1, to = page * PER_FORM + chunk.length;
  const pages = Math.ceil(open.length / PER_FORM);
  return {
    type: 9,
    data: {
      custom_id: `pred:save:${round.id}:${page}`,
      title: clip(pages > 1 ? `${round.label} · games ${from} to ${to}` : `${round.label} predictions`, 45),
      components: chunk.map((f) => {
        const p = picks.get(f.match_id);
        const input: Record<string, unknown> = {
          type: 4, custom_id: `m:${f.match_id}`, style: 1,
          label: clip(`${game(f)} · ${ukWhen(f.kickoff_at)}`, 45),
          placeholder: "Score, e.g. 1-2", required: false, min_length: 3, max_length: 5,
        };
        if (p) input.value = `${p.home}-${p.away}`;
        return { type: 1, components: [input] };
      }),
    },
  };
}

function picksCard(fx: Fixture[], picks: Map<string, { home: number; away: number }>) {
  return fx.map((f) => {
    const p = picks.get(f.match_id);
    const pick = p ? `**${p.home}-${p.away}**` : "no pick";
    let tail = f.locked ? " · locked" : "";
    if (f.status === "completed" && f.goals_home !== null && p) {
      const exact = p.home === f.goals_home && p.away === f.goals_away;
      const res = Math.sign(p.home - p.away) === Math.sign(f.goals_home - (f.goals_away ?? 0));
      tail = ` · FT ${f.goals_home}-${f.goals_away} · ${exact ? 3 : res ? 1 : 0} pts`;
    } else if (f.status === "completed" && f.goals_home !== null) {
      tail = ` · FT ${f.goals_home}-${f.goals_away}`;
    }
    return `${game(f)}: ${pick}${tail}`;
  }).join("\n");
}

const reply = (content: string, ephemeral = true, components?: unknown[]) =>
  json({ type: 4, data: { content: clip(content, 1990), flags: ephemeral ? EPHEMERAL : 0, components, allowed_mentions: { parse: [] } } });

async function leaderboardText(roundId: number | null, top = 10): Promise<{ text: string; rows: any[] }> {
  const { data, error } = await db.rpc("predictor_leaderboard", { p_round: roundId });
  if (error) throw error;
  const rows = (data ?? []) as any[];
  if (!rows.length) return { text: "No entries yet.", rows };
  const lines = rows.slice(0, top).map((r) =>
    `${r.rank}. ${r.discord_name} · ${r.points} pts (${r.exact} exact)`);
  if (rows.length > top) lines.push(`… and ${rows.length - top} more`);
  return { text: lines.join("\n"), rows };
}

// ---------- interactions ----------

async function onCommand(body: any): Promise<Response> {
  const name = body.data?.name;
  const me = who(body);

  if (name === "predict") {
    const round = await openRound();
    if (!round) return reply("No round is open right now. The next one opens when the Premier League fixtures are set, and it'll be announced in #predictor.");
    const fx = await fixtures(round.id);
    const form = formFor(round, fx, await myPicks(round.id, me.id), 0);
    if (!form) return reply(`Every game in ${round.label} has kicked off. The leaderboard posts once the results are in.`);
    return json(form);
  }

  if (name === "mypredictions") {
    const round = (await openRound()) ?? (await lastRound());
    if (!round) return reply("No rounds yet.");
    const fx = await fixtures(round.id);
    const picks = await myPicks(round.id, me.id);
    if (!picks.size) return reply(`You haven't entered ${round.label} yet. Type /predict to play.`);
    return reply(`**${round.label} · your picks**\n${picksCard(fx, picks)}`);
  }

  if (name === "leaderboard") {
    const round = (await openRound()) ?? (await lastRound());
    if (!round) return reply("No rounds yet.");
    const r = await leaderboardText(round.id);
    const s = await leaderboardText(null, 5);
    return reply(`**${round.label}**\n${r.text}\n\n**Season**\n${s.text}`, false);
  }

  if (name === "teams") return await teamsCommand(me.id);

  return reply("Unknown command.");
}

// /teams: lineup alerts. The picker lives on the site because that is where
// Plus is known; this only says where things stand and links to it.
async function teamsCommand(discordUserId: string): Promise<Response> {
  const settings = `${SITE}/me/settings?panel=teams`;
  const { data: link, error } = await db.from("discord_links").select("user_id")
    .eq("discord_user_id", discordUserId).maybeSingle();
  if (error) throw error;
  if (!link) {
    return reply(
      "**Lineup alerts** (Plus)\nPick your teams on MAXEDGE and I'll DM you both confirmed XIs the moment they're out, usually 20 to 30 minutes before kick-off.\n\nFirst, link this Discord account to your MAXEDGE account.",
      true, linkButtons({ label: "Link Discord", url: `${SITE}/me/settings?panel=discord` }),
    );
  }
  const { data: plus, error: pe } = await db.rpc("is_plus_entitled", { p_user_id: link.user_id });
  if (pe) throw pe;
  if (!plus) {
    return reply(
      "**Lineup alerts are a Plus feature.**\nPick the teams you follow and I'll DM you both confirmed XIs the moment they're out, usually 20 to 30 minutes before kick-off. No pings for anyone else's games.",
      true, linkButtons({ label: "See Plus", url: `${SITE}/pricing` }),
    );
  }
  const { data: follows, error: fe } = await db.from("team_follows").select("created_at, teams(name)")
    .eq("user_id", link.user_id).order("created_at");
  if (fe) throw fe;
  const names = (follows ?? []).map((f: any) => f.teams?.name).filter(Boolean) as string[];
  const { data: state } = await db.from("lineup_alert_state").select("dm_blocked_at").eq("user_id", link.user_id).maybeSingle();
  const blocked = state?.dm_blocked_at
    ? "\n\n**I couldn't DM you last time.** In this server's Privacy Settings, turn on Direct Messages, then press \"I've turned DMs on\" in your MAXEDGE settings."
    : "";
  const body = names.length
    ? `**Your lineup alerts** (${names.length})\n${names.map((n) => `• ${n}`).join("\n")}\n\nI'll DM you both XIs as soon as they're confirmed.`
    : "**Lineup alerts**\nYou're not following any teams yet. Pick them and I'll DM you both XIs as soon as they're confirmed.";
  return reply(body + blocked, true, linkButtons({ label: names.length ? "Change my teams" : "Pick my teams", url: settings }));
}

async function onComponent(body: any): Promise<Response> {
  const id: string = body.data?.custom_id ?? "";
  if (id === "pred:open") return onCommand({ ...body, data: { name: "predict" } });
  if (id === "pred:mine") return onCommand({ ...body, data: { name: "mypredictions" } });
  const m = id.match(/^pred:next:(\d+):(\d+)$/);
  if (!m) return reply("That button has expired. Type /predict to carry on.");
  const round = await openRound();
  if (!round || round.id !== Number(m[1])) return reply("That round has closed. Type /predict for the current one.");
  const me = who(body);
  const fx = await fixtures(round.id);
  const form = formFor(round, fx, await myPicks(round.id, me.id), Number(m[2]));
  if (!form) return reply("Those games have kicked off. Type /mypredictions to see your picks.");
  return json(form);
}

async function onModal(body: any): Promise<Response> {
  const id: string = body.data?.custom_id ?? "";
  const m = id.match(/^pred:save:(\d+):(\d+)$/);
  if (!m) return reply("That form has expired. Type /predict to start again.");
  const roundId = Number(m[1]), page = Number(m[2]);
  const round = await openRound();
  if (!round || round.id !== roundId) return reply("That round has closed. Type /predict for the current one.");

  const me = who(body);
  const fx = await fixtures(roundId);
  const byId = new Map(fx.map((f) => [f.match_id, f]));
  const rows: any[] = [];
  const problems: string[] = [];

  for (const row of body.data?.components ?? []) {
    for (const c of row.components ?? []) {
      const matchId = String(c.custom_id ?? "").replace(/^m:/, "");
      const f = byId.get(matchId);
      const raw = String(c.value ?? "").trim();
      if (!f || !raw) continue;
      if (f.locked) { problems.push(`${game(f)} has kicked off, so it wasn't saved`); continue; }
      const s = parseScore(raw);
      if (!s) { problems.push(`${game(f)}: "${clip(raw, 8)}" isn't a score. Use something like 1-2`); continue; }
      rows.push({ round_id: roundId, match_id: matchId, discord_user_id: me.id, discord_name: me.name, home: s[0], away: s[1] });
    }
  }

  if (rows.length) {
    const { error } = await db.from("predictor_entries").upsert(rows, { onConflict: "round_id,match_id,discord_user_id" });
    if (error) {
      // A game kicked off between opening the form and saving: save the rest one by one.
      for (const r of rows) {
        const { error: e } = await db.from("predictor_entries").upsert(r, { onConflict: "round_id,match_id,discord_user_id" });
        if (e) problems.push(`${game(byId.get(r.match_id)!)} couldn't be saved (it may have just kicked off)`);
      }
    }
  }

  const open = fx.filter((f) => !f.locked);
  const nextFrom = (page + 1) * PER_FORM;
  const picks = await myPicks(roundId, me.id);
  const problemText = problems.length ? `\n\n${problems.map((p) => `• ${p}`).join("\n")}` : "";

  if (nextFrom < open.length) {
    const to = Math.min(open.length, nextFrom + PER_FORM);
    return reply(
      `Saved ${rows.length} of ${Math.min(PER_FORM, open.length - page * PER_FORM)}. Now games ${nextFrom + 1} to ${to}.${problemText}`,
      true,
      [{ type: 1, components: [{ type: 2, style: 1, label: `Next: games ${nextFrom + 1} to ${to}`, custom_id: `pred:next:${roundId}:${page + 1}` }]}],
    );
  }

  return reply(
    `**${round.label} · you're in.**\n${picksCard(fx, picks)}\n\nChange any score with /predict until that game kicks off.${problemText}`,
  );
}

// ---------- clock ----------

async function announce(round: Round) {
  const fx = await fixtures(round.id);
  const first = fx[0];
  const lines = fx.map((f) => `${game(f)} · ${ukWhen(f.kickoff_at)}`).join("\n");
  const ok = await post(
    `**Predictor League · ${round.label}**\n` +
    `Predict the score of every Premier League game. Tap **Enter predictions** below (or type /predict), and change any score up to that game's kick-off.\n` +
    `3 points for an exact score, 1 for the right result. The winner holds the Top Predictor role until the next round.\n` +
    `No entry fee, no prizes, just bragging rights.\n\n${lines}\n\n` +
    `First game: ${first ? `${game(first)}, ${ukWhen(first.kickoff_at)}` : "tbc"}`,
    [], ENTER_BUTTON,
  );
  if (ok) await db.from("predictor_rounds").update({ announced_at: new Date().toISOString() }).eq("id", round.id);
}

async function remind(round: Round) {
  const fx = await fixtures(round.id);
  const { data } = await db.from("predictor_entries").select("discord_user_id").eq("round_id", round.id);
  const players = new Set((data ?? []).map((r: any) => r.discord_user_id)).size;
  const first = fx[0];
  const ok = await post(
    `**${round.label} starts soon.** ${first ? `${game(first)} kicks off at ${ukWhen(first.kickoff_at).split(" ")[1]}.` : ""} ` +
    `${players ? `${players} ${players === 1 ? "player is" : "players are"} in.` : "Nobody's in yet."} Tap **Enter predictions** to play. Each game locks at its own kick-off.`,
    [], ENTER_BUTTON,
  );
  if (ok) await db.from("predictor_rounds").update({ reminded_at: new Date().toISOString() }).eq("id", round.id);
}

async function finalise(round: Round) {
  const fx = await fixtures(round.id);
  const lb = await leaderboardText(round.id);
  const winners = lb.rows.filter((r) => r.rank === 1 && r.points > 0).map((r) => String(r.discord_user_id));

  const { data: prev } = await db.from("predictor_rounds").select("winner_ids, winner_nicks").eq("status", "final")
    .order("id", { ascending: false }).limit(1);
  const prevWinners = ((prev?.[0]?.winner_ids ?? []) as string[]);
  const prevNicks = ((prev?.[0]?.winner_nicks ?? {}) as Record<string, string | null>);
  let winnerNicks: Record<string, string | null> = prevNicks;

  if (!ROLE_ID && BOT_TOKEN) {
    const res = await discord(`/guilds/${GUILD_ID}/roles`, "GET");
    if (res.ok) ROLE_ID = ((await res.json()) as any[]).find((r) => r.name === ROLE_NAME)?.id ?? "";
  }

  // The role only moves when someone actually wins; otherwise the holder keeps it.
  if (ROLE_ID && BOT_TOKEN && winners.length) {
    for (const uid of prevWinners) {
      if (!winners.includes(uid)) await discord(`/guilds/${GUILD_ID}/members/${uid}/roles/${ROLE_ID}`, "DELETE");
    }
    for (const uid of winners) await discord(`/guilds/${GUILD_ID}/members/${uid}/roles/${ROLE_ID}`, "PUT");
  }

  // Trophy in the winner's server nickname; the previous winner gets their old name back.
  // Discord never lets a bot rename the server owner or anyone ranked above the bot; those calls just fail (logged).
  if (BOT_TOKEN && winners.length) {
    for (const uid of prevWinners) {
      if (!winners.includes(uid)) {
        await discord(`/guilds/${GUILD_ID}/members/${uid}`, "PATCH", { nick: prevNicks[uid] ?? null });
      }
    }
    winnerNicks = {};
    for (const uid of winners) {
      if (prevWinners.includes(uid)) { winnerNicks[uid] = prevNicks[uid] ?? null; continue; } // already wearing it
      const res = await discord(`/guilds/${GUILD_ID}/members/${uid}`, "GET");
      if (!res.ok) continue;
      const m = await res.json();
      const original: string | null = m.nick ?? null;
      const base = original ?? m.user?.global_name ?? m.user?.username ?? "Top Predictor";
      winnerNicks[uid] = original;
      await discord(`/guilds/${GUILD_ID}/members/${uid}`, "PATCH", { nick: `${TROPHY} ${base}`.slice(0, 32) });
    }
  }

  const results = fx.filter((f) => f.status === "completed" && f.goals_home !== null)
    .map((f) => `${game(f)} ${f.goals_home}-${f.goals_away}`).join(" · ");
  const winnerLine = winners.length
    ? `${winners.map((u) => `<@${u}>`).join(" and ")} ${winners.length > 1 ? "share" : "takes"} the Top Predictor role this week.`
    : lb.rows.length ? "Nobody scored a point this round, so the Top Predictor role stays where it is." : "";

  if (lb.rows.length) {
    const season = await leaderboardText(null, 5);
    await post(
      `**Predictor League · ${round.label} final table**\n${lb.text}\n\n${winnerLine}\n\n` +
      `**Season so far**\n${season.text}\n\nResults: ${results}`,
      winners,
    );
  }

  await db.from("predictor_rounds").update({
    status: "final", finalised_at: new Date().toISOString(),
    winner_ids: winners.length ? winners : prevWinners,
    winner_nicks: winnerNicks,
  }).eq("id", round.id);
}

async function tick() {
  const log: string[] = [];
  let round = await openRound();

  if (round && Date.now() > new Date(round.last_kickoff).getTime()) {
    const fx = await fixtures(round.id);
    const allIn = fx.every((f) => f.status === "completed" && f.goals_home !== null);
    const timedOut = Date.now() > new Date(round.last_kickoff).getTime() + 48 * 3600e3; // postponed games are dropped
    if (allIn || timedOut) { await finalise(round); log.push(`finalised ${round.id}`); round = null; }
  }

  if (!round) {
    const { data: newId, error } = await db.rpc("predictor_open_round");
    if (error) throw error;
    if (newId) { round = await openRound(); log.push(`opened ${newId}`); }
  }

  if (round && !round.announced_at) { await announce(round); log.push(`announced ${round.id}`); }

  if (round && round.announced_at && !round.reminded_at) {
    const until = new Date(round.first_kickoff).getTime() - Date.now();
    if (until > 0 && until <= 3 * 3600e3) { await remind(round); log.push(`reminded ${round.id}`); }
  }
  return log;
}

async function register() {
  const commands = [
    { name: "predict", description: "Enter or change your scores for this round's Premier League games", type: 1 },
    { name: "mypredictions", description: "See your picks and points for this round", type: 1 },
    { name: "leaderboard", description: "This round's table and the season standings", type: 1 },
    { name: "teams", description: "Plus: the teams you get lineup DMs for, and where to change them", type: 1 },
  ];
  const res = await discord(`/applications/${APP_ID}/guilds/${GUILD_ID}/commands`, "PUT", commands);
  let hoist = "skipped";
  const rr = await discord(`/guilds/${GUILD_ID}/roles`, "GET");
  if (rr.ok) {
    const role = ((await rr.json()) as any[]).find((r) => r.name === ROLE_NAME);
    if (role) {
      const h = await discord(`/guilds/${GUILD_ID}/roles/${role.id}`, "PATCH", { hoist: true });
      hoist = `${h.status}`;
    } else hoist = "role not found";
  }
  return { status: res.status, hoist, body: (await res.text()).slice(0, 300) };
}

async function addButtonsToAnnouncement() {
  const round = await openRound();
  if (!round) return { ok: false, why: "no open round" };
  const res = await discord(`/channels/${CHANNEL_ID}/messages?limit=50`, "GET");
  if (!res.ok) return { ok: false, status: res.status };
  const msgs = (await res.json()) as any[];
  const target = msgs.find((m) => m.author?.id === APP_ID && String(m.content).startsWith(`**Predictor League · ${round.label}**`));
  if (!target) return { ok: false, why: "announcement not found" };
  const content = String(target.content).replace("Type **/predict** to enter,", "Tap **Enter predictions** below (or type /predict),");
  const e = await discord(`/channels/${CHANNEL_ID}/messages/${target.id}`, "PATCH", { content, components: ENTER_BUTTON });
  return { ok: e.ok, status: e.status, message: target.id };
}

async function cronSecretOk(given: string | null): Promise<boolean> {
  if (!given) return false;
  const { data, error } = await db.rpc("check_discord_cron_secret", { p_secret: given });
  if (error) { console.error("[predictor] secret check failed", error.message); return false; }
  return data === true;
}

// ---------- entry ----------

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const body = await req.text();

  // Clock and admin calls from pg_cron / by hand.
  if (req.headers.has("x-cron-secret")) {
    if (!(await cronSecretOk(req.headers.get("x-cron-secret")))) return json({ error: "not found" }, 404);
    let action = "";
    try { action = JSON.parse(body)?.action ?? ""; } catch { /* empty */ }
    try {
      if (action === "tick") return json({ ok: true, log: await tick() });
      if (action === "register") return json(await register());
      if (action === "buttons") return json(await addButtonsToAnnouncement());
      return json({ error: `unknown action ${action}` }, 400);
    } catch (e) {
      console.error("[predictor] action failed", e);
      return json({ ok: false, error: String(e) }, 500);
    }
  }

  // Discord interactions.
  if (!(await verifyDiscord(req, body))) return new Response("invalid request signature", { status: 401 });
  const i = JSON.parse(body);
  try {
    if (i.type === 1) return json({ type: 1 });
    if (i.type === 2) return await onCommand(i);
    if (i.type === 3) return await onComponent(i);
    if (i.type === 5) return await onModal(i);
    return reply("Unsupported interaction.");
  } catch (e) {
    console.error("[predictor] interaction failed", e);
    return reply("Something went wrong saving that. Try /predict again in a minute.");
  }
});
