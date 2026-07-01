/**
 * reportStatus.js — daily recap (public) + ops report (private)
 *
 * Two distinct outputs so business internals never reach subscribers:
 *
 *   1. PUBLIC RECAP  → TELEGRAM_CHAT_ID (the subscriber channel)
 *      A friendly summary of the day's activity — how many value signals were
 *      shared, a quick tier breakdown, the day's top edge — plus a link to the
 *      site. Contains NO operational or business detail.
 *
 *   2. OPS REPORT    → TELEGRAM_ADMIN_CHAT_ID (private, owner-only) if set,
 *      otherwise printed to stdout only (GitHub Actions logs are private).
 *      The full internal view: fixtures polled, polling cadence, exact API
 *      request counts vs the daily quota, and projected end-of-day usage.
 *
 * The API quota / polling detail is deliberately kept OUT of the public
 * channel — subscribers should never see how much API budget is being burned.
 *
 * Safe to run any time — read-only against Supabase.
 *
 * Required env vars:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 *
 * Optional env vars:
 *   TELEGRAM_ADMIN_CHAT_ID — private chat for the full ops report
 *   DAILY_QUOTA            — total daily limit for the API plan (default: 75000)
 *   SITE_URL               — link shared in the public recap (default: https://maxedge.live/feed)
 *
 * Usage:
 *   node reportStatus.js
 */

'use strict';

const https            = require('https');
const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID        = process.env.TELEGRAM_CHAT_ID;
const ADMIN_CHAT_ID  = process.env.TELEGRAM_ADMIN_CHAT_ID || null;
const DAILY_QUOTA    = parseInt(process.env.DAILY_QUOTA ?? '75000', 10);
const SITE_URL       = process.env.SITE_URL || 'https://maxedge.live/feed';

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing Supabase credentials');
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

function sendTelegram(chatId, text) {
  if (!BOT_TOKEN || !chatId) {
    console.log('[report] Telegram target not configured — printing to stdout only');
    return Promise.resolve();
  }
  const body = JSON.stringify({
    chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: false,
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      method:   'POST',
      hostname: 'api.telegram.org',
      path:     `/bot${BOT_TOKEN}/sendMessage`,
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Data fetchers
// ---------------------------------------------------------------------------

function startOfTodayISO() {
  return new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
}

async function loadTodayPlan(supabase) {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('engine_plan')
    .select('*')
    .eq('date', today)
    .maybeSingle();
  if (error) throw new Error(`loadTodayPlan: ${error.message}`);
  return data;
}

async function loadFixtureDetails(supabase, fixtureIds) {
  if (!fixtureIds?.length) return [];
  const { data, error } = await supabase
    .from('matches')
    .select(`
      external_id, kickoff_at,
      home_team:teams!matches_home_team_id_fkey ( name ),
      away_team:teams!matches_away_team_id_fkey ( name )
    `)
    .in('external_id', fixtureIds.map(String));
  if (error) throw new Error(`loadFixtureDetails: ${error.message}`);
  return data ?? [];
}

/**
 * Value signals actually published to the subscriber channel today. We read
 * posted_signals (channel='telegram', with a real external_msg_id so DRY_RUN
 * and no-channel skips are excluded) and join through to value_signals for the
 * tier / edge / teams. This reflects exactly what subscribers saw.
 */
async function loadTodaysPublishedSignals(supabase) {
  const since = startOfTodayISO();
  const { data: posts, error: postsErr } = await supabase
    .from('posted_signals')
    .select('signal_id')
    .eq('channel', 'telegram')
    .gte('posted_at', since)
    .not('external_msg_id', 'is', null);
  if (postsErr) throw new Error(`loadTodaysPublishedSignals(posts): ${postsErr.message}`);

  const ids = [...new Set((posts ?? []).map(p => p.signal_id))];
  if (!ids.length) return [];

  const { data: sigs, error: sigsErr } = await supabase
    .from('value_signals')
    .select(`
      id, outcome, detected_odds, detected_edge, signal_category, phase,
      match:matches (
        home_team:teams!matches_home_team_id_fkey ( name ),
        away_team:teams!matches_away_team_id_fkey ( name )
      )
    `)
    .in('id', ids);
  if (sigsErr) throw new Error(`loadTodaysPublishedSignals(signals): ${sigsErr.message}`);
  return sigs ?? [];
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtTime(isoStr) {
  if (!isoStr) return '—';
  return new Date(isoStr).toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  }) + ' UTC';
}

function fmtDate(isoStr) {
  if (!isoStr) return '—';
  return new Date(isoStr).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

function bar(used, total, width = 20) {
  const filled = Math.round((used / total) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function pct(used, total) {
  return ((used / total) * 100).toFixed(2) + '%';
}

// Signal tier classification — mirrors postToX.js precedence.
function tierOf(signal) {
  if (signal.phase === 'inplay') return 'inplay';
  if (signal.signal_category === 'PriceMove') return 'oddsmove';
  if (Number(signal.detected_edge) >= 0.08) return 'ruby';
  return 'value';
}

// ---------------------------------------------------------------------------
// Public recap — safe for the subscriber channel (no business internals)
// ---------------------------------------------------------------------------

async function buildPublicRecap(supabase) {
  const now     = new Date();
  const signals = await loadTodaysPublishedSignals(supabase);

  const lines = [];
  lines.push(`🏆 <b>MaxEdge — Daily Recap</b>`);
  lines.push(`📅 ${fmtDate(now.toISOString())}\n`);

  if (!signals.length) {
    lines.push(`Quiet one today — nothing cleared our value threshold, so no picks went out.`);
    lines.push(`We only post when the edge is genuinely there.\n`);
    lines.push(`📲 Full history, results & live feed:`);
    lines.push(`<a href="${SITE_URL}">${SITE_URL}</a>`);
    return lines.join('\n');
  }

  const counts = { ruby: 0, value: 0, oddsmove: 0, inplay: 0 };
  let best = null;
  for (const s of signals) {
    counts[tierOf(s)] += 1;
    if (best === null || Number(s.detected_edge) > Number(best.detected_edge)) best = s;
  }

  lines.push(`<b>${signals.length}</b> value signal${signals.length === 1 ? '' : 's'} shared with the channel today:`);
  if (counts.ruby)     lines.push(`  ◆ Ruby: ${counts.ruby}`);
  if (counts.value)    lines.push(`  ⚡ Value: ${counts.value}`);
  if (counts.oddsmove) lines.push(`  ↗️ Odds movement: ${counts.oddsmove}`);
  if (counts.inplay)   lines.push(`  🔴 In-play: ${counts.inplay}`);

  if (best) {
    const home = best.match?.home_team?.name ?? 'Home';
    const away = best.match?.away_team?.name ?? 'Away';
    const edge = (Number(best.detected_edge) * 100).toFixed(1);
    lines.push(`\n📈 Top edge of the day: <b>+${edge}%</b> — ${home} vs ${away}`);
  }

  lines.push(`\n📲 Full history, results & live feed:`);
  lines.push(`<a href="${SITE_URL}">${SITE_URL}</a>`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Ops report — PRIVATE (owner only). Contains API quota / polling internals.
// ---------------------------------------------------------------------------

async function buildOpsReport(supabase) {
  const now  = new Date();
  const plan = await loadTodayPlan(supabase);

  const lines = [];
  lines.push(`📊 <b>EVE — Daily Ops Report</b> (private)`);
  lines.push(`📅 ${fmtDate(now.toISOString())}  •  ${fmtTime(now.toISOString())}\n`);

  if (!plan) {
    lines.push(`⚠️ No plan found for today.`);
    lines.push(`Plan is written at 05:00 UTC by plan-day.yml.`);
    lines.push(`Run the <code>Plan Day</code> workflow manually to create one.`);
    return lines.join('\n');
  }

  // ── Fixtures ──────────────────────────────────────────────────────────────
  const fixtureIds = plan.fixture_ids ?? [];
  const fixtures   = await loadFixtureDetails(supabase, fixtureIds);

  lines.push(`⚽ <b>Fixtures being polled (${fixtureIds.length})</b>`);
  if (fixtures.length === 0 && fixtureIds.length > 0) {
    lines.push(`  IDs: ${fixtureIds.join(', ')}`);
  } else if (fixtures.length === 0) {
    lines.push(`  None — no fixtures scheduled today`);
  } else {
    // Sort by kickoff
    const sorted = [...fixtures].sort((a, b) =>
      new Date(a.kickoff_at ?? 0) - new Date(b.kickoff_at ?? 0)
    );
    for (const f of sorted) {
      const home = f.home_team?.name ?? '?';
      const away = f.away_team?.name ?? '?';
      const ko   = fmtTime(f.kickoff_at);
      lines.push(`  • ${ko}  ${home} vs ${away}  <code>[${f.external_id}]</code>`);
    }
  }

  // ── Polling status ────────────────────────────────────────────────────────
  lines.push(`\n🔄 <b>Polling Status</b>`);
  const interval = plan.interval_minutes;
  const runsComp = plan.runs_completed ?? 0;
  const runsPlan = plan.runs_planned   ?? 0;
  const nextRun  = plan.next_run_at;

  if (interval) {
    lines.push(`  • Interval:     every ${interval} min`);
  } else {
    lines.push(`  • Interval:     not set (no fixtures?)`);
  }
  lines.push(`  • Runs:         ${runsComp} / ${runsPlan} completed`);
  lines.push(`  • Next run:     ${fmtTime(nextRun)}`);

  // Warn if interval would exceed 15-min cron window
  if (interval && interval > 15) {
    lines.push(`  ⚠️  Interval (${interval}m) exceeds cron cadence (15m) — polling may lag`);
  }

  // ── API usage ─────────────────────────────────────────────────────────────
  const plannerCalls = 1;
  const oddsCalls    = runsComp * (fixtureIds.length || 0);
  const detailCalls  = plan.details_calls_used ?? 0;
  const totalUsed    = plannerCalls + oddsCalls + detailCalls;
  const remaining    = DAILY_QUOTA - totalUsed;

  lines.push(`\n📡 <b>API Requests Today (quota: ${DAILY_QUOTA.toLocaleString()})</b>`);
  lines.push(`  • Plan setup:      ${plannerCalls.toLocaleString()} call`);
  lines.push(`  • Odds ingestion:  ${oddsCalls.toLocaleString()} calls  (${runsComp} runs × ${fixtureIds.length} fixtures)`);
  lines.push(`  • Match details:   ${detailCalls.toLocaleString()} calls`);
  lines.push(`  • ─────────────────────────────`);
  lines.push(`  • Total used:      <b>${totalUsed.toLocaleString()} / ${DAILY_QUOTA.toLocaleString()}</b>  (${pct(totalUsed, DAILY_QUOTA)})`);
  lines.push(`  • Remaining:       ${remaining.toLocaleString()}`);
  lines.push(`  • ${bar(totalUsed, DAILY_QUOTA)}  ${pct(totalUsed, DAILY_QUOTA)}`);

  // ── Projected end-of-day usage ────────────────────────────────────────────
  if (runsComp > 0 && fixtureIds.length > 0) {
    const runsLeft    = runsPlan - runsComp;
    const projOdds    = runsPlan * fixtureIds.length;
    // fetchMatchDetails averages about 2 calls per fixture per run (pre-kickoff) or 1 (post)
    const projDetails = Math.round(runsPlan * fixtureIds.length * 1.5);
    const projTotal   = plannerCalls + projOdds + projDetails;
    const safetyPct   = ((projTotal / DAILY_QUOTA) * 100).toFixed(1);
    lines.push(`\n🔮 <b>Projected end-of-day</b>`);
    lines.push(`  • Estimated total: ~${projTotal.toLocaleString()} calls  (${safetyPct}% of quota)`);
    lines.push(`  • Runs remaining:  ${runsLeft}`);

    if (projTotal > DAILY_QUOTA) {
      lines.push(`  🚨 QUOTA RISK: projected usage exceeds daily limit!`);
      lines.push(`  → Reduce DAILY_REQUEST_BUDGET in plan-day.yml`);
    } else if (projTotal > DAILY_QUOTA * 0.8) {
      lines.push(`  ⚠️  Projected usage above 80% — monitor closely`);
    } else {
      lines.push(`  ✅ Well within quota`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`[report] ${new Date().toISOString()}`);
  const supabase = getSupabase();

  // ── Public recap → subscriber channel ──────────────────────────────────────
  try {
    const recap = await buildPublicRecap(supabase);
    console.log('\n--- PUBLIC RECAP ---\n' + recap.replace(/<[^>]+>/g, '') + '\n');
    if (CHAT_ID) {
      await sendTelegram(CHAT_ID, recap);
      console.log('[report] public recap sent to subscriber channel');
    } else {
      console.log('[report] TELEGRAM_CHAT_ID not set — recap not sent');
    }
  } catch (err) {
    console.error('[report] public recap failed:', err.message);
  }

  // ── Ops report → private admin chat (never the public channel) ─────────────
  try {
    const ops = await buildOpsReport(supabase);
    console.log('\n--- OPS REPORT (private) ---\n' + ops.replace(/<[^>]+>/g, '') + '\n');
    if (ADMIN_CHAT_ID) {
      await sendTelegram(ADMIN_CHAT_ID, ops);
      console.log('[report] ops report sent to admin chat');
    } else {
      console.log('[report] TELEGRAM_ADMIN_CHAT_ID not set — ops report kept to logs only');
    }
  } catch (err) {
    console.error('[report] ops report failed:', err.message);
  }

  console.log('[report] done');
}

main().catch(err => {
  console.error('[report] fatal:', err.message);
  process.exit(1);
});
