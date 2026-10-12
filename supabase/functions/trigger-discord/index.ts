import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// trigger-discord
//
// The clock for post-to-discord.yml. Called by pg_cron (migration 145), one
// job per mode, and dispatches the workflow with that mode and dry_run=false.
//
// WHY THIS EXISTS. GitHub's `schedule:` trigger delivered about 15 of the ~120
// runs a day the workflow asked for between 9 and 12 Oct 2026, and the
// once-a-day ones (trends 07:05, the Monday record and edge table) were simply
// never delivered: #hit-rates got no card on 10, 11 or 12 Oct. engine.yml hit
// the same wall and moved to pg_cron in migration 136; this is the same move.
//
// AUTH. verify_jwt is off and the caller must send x-cron-secret matching the
// vault secret `discord_cron_secret`, checked through the service-role-only
// RPC check_discord_cron_secret(). Without that, anyone holding the public anon
// key could make the bot post. The secret lives in the vault and in the cron
// command, never in this repo.
//
// Secrets: GITHUB_PAT (actions:write on oweybee/eve-engine), shared with
// trigger-engine.

const DISPATCH =
  "https://api.github.com/repos/oweybee/eve-engine/actions/workflows/post-to-discord.yml/dispatches";

// No `delete` here: that is a by-hand operation, never a clock.
const MODES = new Set(["signals", "results", "weekly", "trends", "movers", "edge"]);

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function secretOk(given: string | null): Promise<boolean> {
  if (!given) return false;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/check_discord_cron_secret`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_secret: given }),
  });
  if (!res.ok) {
    console.error(`[trigger-discord] secret check failed ${res.status}: ${await res.text()}`);
    return false;
  }
  return (await res.json()) === true;
}

async function dispatch(pat: string, mode: string): Promise<{ status: number; body: string }> {
  const res = await fetch(DISPATCH, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "supabase-trigger-discord",
    },
    body: JSON.stringify({ ref: "main", inputs: { mode, dry_run: "false" } }),
  });
  return { status: res.status, body: res.status === 204 ? "" : await res.text() };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!(await secretOk(req.headers.get("x-cron-secret")))) return json({ error: "not found" }, 404);

  let mode = "";
  try { mode = String((await req.json())?.mode ?? ""); } catch { /* falls through */ }
  if (!MODES.has(mode)) return json({ error: `unknown mode ${mode}` }, 400);

  const pat = Deno.env.get("GITHUB_PAT");
  if (!pat) return json({ error: "GITHUB_PAT not configured" }, 500);

  let status = 0, body = "", attempts = 0;
  for (let i = 0; i < 2; i++) {
    attempts++;
    try { ({ status, body } = await dispatch(pat, mode)); } catch (e) { status = 0; body = String(e); }
    if (status === 204) break;
    if (i === 0) await new Promise((r) => setTimeout(r, 1500));
  }
  const ok = status === 204;
  if (ok) console.log(`[trigger-discord] dispatched mode=${mode} attempts=${attempts}`);
  else console.error(`[trigger-discord] mode=${mode} failed after ${attempts}: ${status} ${body.slice(0, 300)}`);
  return json({ mode, github_status: status, dispatch_ok: ok, attempts }, ok ? 200 : 502);
});
