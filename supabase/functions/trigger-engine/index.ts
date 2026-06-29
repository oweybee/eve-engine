import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/**
 * Dispatches the eve-engine GitHub Actions workflow.
 * Called every 5 minutes by Supabase pg_cron via net.http_post.
 *
 * Required secret: GITHUB_PAT (workflow scope)
 */
Deno.serve(async (_req: Request) => {
  const pat = Deno.env.get('GITHUB_PAT');
  if (!pat) {
    console.error('[trigger-engine] GITHUB_PAT secret not set');
    return new Response(
      JSON.stringify({ error: 'GITHUB_PAT not configured' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  let githubStatus: number;
  let responseBody: Record<string, unknown>;

  try {
    const res = await fetch(
      'https://api.github.com/repos/oweybee/eve-engine/actions/workflows/engine.yml/dispatches',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
          'User-Agent': 'supabase-trigger-engine',
        },
        body: JSON.stringify({ ref: 'main' }),
      },
    );

    githubStatus = res.status;
    responseBody = githubStatus === 204
      ? { triggered: true, ts: new Date().toISOString() }
      : { error: await res.text() };
  } catch (err) {
    console.error('[trigger-engine] fetch error:', err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }

  console.log(`[trigger-engine] GitHub dispatch → ${githubStatus}`);

  return new Response(
    JSON.stringify({ github_status: githubStatus, ...responseBody }),
    {
      status: githubStatus === 204 ? 200 : githubStatus,
      headers: { 'Content-Type': 'application/json' },
    },
  );
});
