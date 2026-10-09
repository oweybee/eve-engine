import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// trigger-engine
//
// Source of record for the deployed edge function (version 3, last deployed
// 6 Sep 2026). Until 9 Oct 2026 this lived only in Supabase. It is called
// every 5 minutes by pg_cron job `trigger-engine-every-5min` (pinned in
// migrations/136) and is the ONLY clock that starts engine.yml.
//
// Previously: POST to GitHub, log the status, return. The status was computed
// and discarded, so a dispatch that GitHub accepted but that produced no data
// was indistinguishable from a healthy one. Combined with pg_cron recording
// success on net.http_post handoff, that made the 25-hour blackout of
// 6 Sep 2026 completely invisible: 288 dispatches, 0 bookmaker rows, 0 alerts.
//
// Now: retry a failed dispatch once, then write an engine_runs row either way.
// reconcile_engine_runs() grades it later by whether prices actually landed.
// The dispatch cadence is deliberately unchanged.
//
// Deploy: supabase functions deploy trigger-engine --project-ref zlbmpeiuhyllxwegtayu
// Secrets: GITHUB_PAT (actions:write on oweybee/eve-engine).

const GITHUB_DISPATCH =
  "https://api.github.com/repos/oweybee/eve-engine/actions/workflows/engine.yml/dispatches";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function recordRun(row: Record<string, unknown>): Promise<void> {
  // Never let bookkeeping failure take down dispatch: log and move on.
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/engine_runs`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      console.error(`[trigger-engine] engine_runs insert failed ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    console.error("[trigger-engine] engine_runs insert threw:", err);
  }
}

async function dispatch(pat: string): Promise<{ status: number; body: string }> {
  const res = await fetch(GITHUB_DISPATCH, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "supabase-trigger-engine",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  // 204 = accepted, no body.
  return { status: res.status, body: res.status === 204 ? "" : await res.text() };
}

Deno.serve(async (_req: Request) => {
  const pat = Deno.env.get("GITHUB_PAT");
  if (!pat) {
    console.error("[trigger-engine] GITHUB_PAT secret not set");
    await recordRun({
      dispatch_ok: false,
      attempts: 0,
      error: "GITHUB_PAT not configured",
      outcome: "pending",
    });
    return new Response(JSON.stringify({ error: "GITHUB_PAT not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  let attempts = 0;
  let status = 0;
  let body = "";
  let threw: string | null = null;

  // One retry. A 401 means an expired PAT and will fail twice, which is the
  // point: it lands in engine_runs as dispatch_failed rather than vanishing.
  for (let i = 0; i < 2; i++) {
    attempts++;
    try {
      const r = await dispatch(pat);
      status = r.status;
      body = r.body;
      threw = null;
      if (status === 204) break;
    } catch (err) {
      threw = String(err);
      status = 0;
    }
    if (i === 0) await new Promise((r) => setTimeout(r, 1500));
  }

  const ok = status === 204;
  const error = ok ? null : (threw ?? `github ${status}: ${body}`.slice(0, 500));

  await recordRun({
    github_status: status || null,
    dispatch_ok: ok,
    attempts,
    error,
    outcome: ok ? "pending" : "dispatch_failed",
  });

  if (!ok) console.error(`[trigger-engine] dispatch failed after ${attempts}: ${error}`);
  else console.log(`[trigger-engine] dispatched, attempts=${attempts}`);

  return new Response(
    JSON.stringify({ github_status: status, dispatch_ok: ok, attempts, error }),
    { status: ok ? 200 : 502, headers: { "Content-Type": "application/json" } },
  );
});
