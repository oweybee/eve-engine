// match-extras: after full time, fetches total corners and cards for completed
// matches (pending settlements first, then history back to 6 Aug 2026 for hit
// rates). Cards = yellow + red shown (one each). Every 10 minutes from pg_cron.
// A match API-Football has no stats for is stored with nulls so it is not retried.
import { createClient } from "jsr:@supabase/supabase-js@2";

const KEY = (Deno.env.get("API_FOOTBALL_KEY") ?? "").trim().replace(/^["']|["']$/g, "").trim();
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const stat = (team: any, type: string) => {
  const v = (team?.statistics ?? []).find((s: any) => s.type === type)?.value;
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

Deno.serve(async () => {
  const { data: pending, error } = await db.rpc("match_extras_due");
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  let done = 0, empty = 0; const errs: string[] = [];
  const q = [...(pending ?? [])];
  const worker = async () => {
    while (q.length) {
      const m: any = q.shift();
      try {
        const r = await fetch(`https://v3.football.api-sports.io/fixtures/statistics?fixture=${m.external_id}`, { headers: { "x-apisports-key": KEY } });
        const j = await r.json();
        if (j?.errors && (Array.isArray(j.errors) ? j.errors.length : Object.keys(j.errors).length)) { errs.push(JSON.stringify(j.errors).slice(0, 150)); q.length = 0; break; }
        const teams = j?.response ?? [];
        const ok = teams.length === 2 && (teams[0]?.statistics ?? []).some((s: any) => s.type === "Corner Kicks" && s.value !== null);
        const row = ok
          ? (() => { const y = stat(teams[0], "Yellow Cards") + stat(teams[1], "Yellow Cards"); const rd = stat(teams[0], "Red Cards") + stat(teams[1], "Red Cards");
              return { match_id: m.match_id, corners: stat(teams[0], "Corner Kicks") + stat(teams[1], "Corner Kicks"), cards: y + rd, yellow: y, red: rd, fetched_at: new Date().toISOString() }; })()
          : { match_id: m.match_id, corners: null, cards: null, yellow: null, red: null, fetched_at: new Date().toISOString() };
        const up = await db.from("match_extra_stats").upsert(row);
        if (up.error) errs.push(up.error.message); else if (ok) done++; else empty++;
      } catch (e) { errs.push(String(e).slice(0, 200)); }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (done) { await db.rpc("settle_new_market_paper_trades"); await db.rpc("settle_pending_signals"); }
  return new Response(JSON.stringify({ due: pending?.length ?? 0, done, empty, errs: errs.slice(0, 5) }), { headers: { "Content-Type": "application/json" } });
});
