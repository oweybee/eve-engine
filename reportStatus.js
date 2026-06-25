/**
 * reportStatus.js — daily API usage + polling frequency report
 *
 * Queries today's engine_plan from Supabase and builds a human-readable
 * status report showing:
 *   • Which fixtures are being polled for odds today
 *   • Current polling interval and run progress
 *   • Exact API requests used vs 75,000 daily quota
 *   • Per-script breakdown (planDay / ingestOdds / fetchMatchDetails)
 *   • Next scheduled run
 *
 * Sends the report to Telegram (same bot as signal alerts).
 * Safe to run any time — read-only against Supabase.
 *
 * Required env vars:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 *
 * Optional env vars:
 *   DAILY_QUOTA  — total daily limit for the API plan (default: 75000)
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
const DAILY_QUOTA    = parseInt(process.env.DAILY_QUOTA ?? '75000', 10);

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

function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log('[report] Telegram not configured — printing to stdout only');
    return Promise.resolve();
  }
  const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' });
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

// ---------------------------------------------------------------------------
// Build report
// ---------------------------------------------------------------------------

async function buildReport(supabase) {
  const now  = new Date();
  const plan = await loadTodayPlan(supabase);

  const lines = [];
  lines.push(`📊 <b>EVE — Daily Status Report</b>`);
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

  let report;
  try {
    report = await buildReport(supabase);
  } catch (err) {
    console.error('[report] failed to build report:', err.message);
    process.exit(1);
  }

  console.log('\n' + report.replace(/<[^>]+>/g, '') + '\n');

  try {
    await sendTelegram(report);
    console.log('[report] sent to Telegram');
  } catch (err) {
    console.warn('[report] Telegram send failed:', err.message);
  }

  console.log('[report] done');
}

main().catch(err => {
  console.error('[report] fatal:', err.message);
  process.exit(1);
});
