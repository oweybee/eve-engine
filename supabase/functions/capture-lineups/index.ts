// capture-lineups: asks API-Football for the confirmed XI of every fixture from
// 90 min before kickoff to 45 min after, until both sides are held. Runs from
// pg_cron every 4 minutes (cron job "capture-lineups").
//
// WHY IT LIVES HERE (22 Oct 2026). eve-engine's lineups.yml declares a 5-minute
// cron and GitHub delivered it every 2-5 HOURS (40 runs, 16-22 Oct). Each run
// polls for 45 min, so lineups were watched about a quarter of the day, and
// over 366 fixtures in a week no XI was ever captured more than 30 min out.
// pg_cron fires on the minute. Same row shape and conflict key as
// lib/lineupCapture.js upsertLineup, so the GitHub job stays a harmless backstop.
//
// This file is the deployed source (version 1), kept here so it is reviewable.
import { createClient } from "jsr:@supabase/supabase-js@2";

const KEY = (Deno.env.get("API_FOOTBALL_KEY") ?? "").trim().replace(/^["']|["']$/g, "").trim();
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const WINDOW_MIN = 90, GRACE_MIN = 45, MAX_CALLS = 60;

Deno.serve(async () => {
  if (!KEY) return new Response(JSON.stringify({ error: "API_FOOTBALL_KEY not set" }), { status: 500 });
  const now = Date.now();
  const { data: ms, error } = await db.from("matches")
    .select("external_id, kickoff_at")
    .not("external_id", "is", null)
    .in("status", ["scheduled", "live"])
    .gte("kickoff_at", new Date(now - GRACE_MIN * 60_000).toISOString())
    .lte("kickoff_at", new Date(now + WINDOW_MIN * 60_000).toISOString())
    .order("kickoff_at", { ascending: true }).limit(1000);
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  const inWindow = (ms ?? []).filter(m => /^\d+$/.test(m.external_id ?? ""));

  // HELD MEANS BOTH SIDES CONFIRMED. A failed held-read re-asks rather than skips.
  const held = new Set<string>();
  const ids = inWindow.map(m => m.external_id);
  for (let i = 0; i < ids.length; i += 60) {
    const { data: rows, error: e } = await db.from("lineups").select("fixture_id, team_id")
      .in("fixture_id", ids.slice(i, i + 60)).eq("confirmed", true);
    if (e) break;
    const sides = new Map<string, Set<string>>();
    for (const r of rows ?? []) {
      const k = String(r.fixture_id);
      if (!sides.has(k)) sides.set(k, new Set());
      sides.get(k)!.add(String(r.team_id));
    }
    for (const [k, t] of sides) if (t.size >= 2) held.add(k);
  }
  const due = inWindow.filter(m => !held.has(String(m.external_id))).slice(0, MAX_CALLS);

  let calls = 0, captured = 0, notPublished = 0, rowsWritten = 0; const errs: string[] = []; const leads: number[] = [];
  const q = [...due];
  const worker = async () => {
    while (q.length) {
      const m: any = q.shift();
      try {
        const r = await fetch(`https://v3.football.api-sports.io/fixtures/lineups?fixture=${m.external_id}`, { headers: { "x-apisports-key": KEY } });
        calls++;
        const j = await r.json();
        const apiErr = j?.errors && (Array.isArray(j.errors) ? j.errors.length : Object.keys(j.errors).length);
        if (apiErr || !r.ok) { errs.push(JSON.stringify(j?.errors ?? r.status).slice(0, 150)); if (j?.errors?.requests || j?.errors?.token) q.length = 0; continue; }
        const teams = j?.response ?? [];
        if (!teams.length) { notPublished++; continue; }
        let wrote = 0;
        for (const t of teams) {
          const teamId = t?.team?.id; if (!teamId) continue;
          const up = await db.from("lineups").upsert({
            fixture_id: String(m.external_id),
            api_football_fixture_id: parseInt(m.external_id, 10),
            team_id: teamId,
            team_name: t?.team?.name ?? null,
            formation: t?.formation ?? null,
            starting_xi: t?.startXI ?? [],
            substitutes: t?.substitutes ?? [],
            team_colors: t?.team?.colors?.player ?? null,
            coach: t?.coach?.name ?? null,
            confirmed: (t?.startXI?.length ?? 0) > 0,
            fetched_at: new Date().toISOString(),
          }, { onConflict: "fixture_id,team_id" });
          if (up.error) errs.push(up.error.message.slice(0, 150)); else wrote++;
        }
        if (wrote) { captured++; rowsWritten += wrote; leads.push(Math.round((new Date(m.kickoff_at).getTime() - Date.now()) / 60_000)); }
      } catch (e) { errs.push(String(e).slice(0, 150)); }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return new Response(JSON.stringify({ inWindow: inWindow.length, held: held.size, due: due.length, calls, captured, rowsWritten, notPublished, leads, errs: errs.slice(0, 5) }), { headers: { "Content-Type": "application/json" } });
});
