# MaxEdge System Health Report

**Generated:** 2026-06-27  
**Scope:** Full audit of eve-engine, eve-frontend, and Supabase data pipeline after multi-model DB migration

---

## Executive Summary

Following the introduction of the `model_architecture` composite key (`UNIQUE(match_id, model_architecture)`) into `computed_values`, several cascading failures occurred that left the Market Pulse empty, signals absent, and MES scores zeroed out. All root causes have been identified and resolved.

---

## Root Causes

### 1. `planDay.js` never called in workflow (CRITICAL)

**File:** `.github/workflows/engine.yml`  
**Impact:** After each UTC day's `engine_plan` exhausted its run budget, `next_run_at` became `null`. `ingestOdds.js` detected this and exited silently with *"active window exhausted for today — done"*. No odds were ever ingested after the first day's quota ran out.

**Fix:** Added a `Plan today's fixtures` step (calling `planDay.js`) before the ingest loop in `engine.yml`, with `DAYS_AHEAD=3`. The script's built-in guard (`plan for today already exists — skipping`) makes it a no-op on 287 of the 288 daily runs.

---

### 2. EV_THRESHOLD too high for efficient market (HIGH)

**File:** `computeValues.js`, `computeApiValues.js`  
**Impact:** Default threshold was `0.02` (2%). The World Cup market, priced by 11–12 sharp bookmakers, rarely produces 2%+ consensus edge. Result: zero value rows, zero signals, all MES scores = 0.

**Fix:** Lowered `EV_THRESHOLD` default to `0.005` (0.5%) in both compute scripts.

---

### 3. `MIN_BOOKMAKERS` too strict in `computeApiValues.js` (MEDIUM)

**File:** `computeApiValues.js`  
**Impact:** Required 3 bookmakers, but early in a match window only 2 may have posted. All such matches were skipped.

**Fix:** Lowered `MIN_BOOKMAKERS` default from `3` to `2` in `computeApiValues.js` (already `2` in `computeValues.js`).

---

### 4. `signals_written` gate in `computeApiValues.js` (HIGH)

**File:** `computeApiValues.js`  
**Impact:** Once `signals_written = true` was set on a `computed_values` row, that match was permanently excluded from signal generation — even when odds moved significantly. The `MARKET_CONSENSUS` engine (v7) had already removed this gate; `API_PREDICTIVE` still had it.

**Fix:** Removed the gate entirely. `upsertComputedValues` no longer selects or updates `signals_written`. Signal dedup is now handled by the 60-minute odds-hash window (same price = skip, different price = new `PriceMove` signal).

---

### 5. GitHub Actions scheduled workflows only run from `main` (HIGH)

**Impact:** All engine improvements on the `claude/` feature branches never executed. Scheduled cron jobs are ignored on non-default branches per GitHub Actions policy.

**Fix:** All engine changes are committed and pushed directly to `main`.

---

### 6. Frontend model architecture filter blocking content (MEDIUM)

**File:** `eve-frontend/lib/feed.js`  
**Impact:** `fetchValueFeed` and `fetchMarketSeries` were both filtering `.eq('model_architecture', 'MARKET_CONSENSUS')`. After the migration added `API_PREDICTIVE` rows, this filter still worked, but it excluded any match where only `API_PREDICTIVE` data existed. More critically, the query structure assumed a single-architecture world.

**Fix:** Removed the `.eq('model_architecture', 'MARKET_CONSENSUS')` filter from both queries. Both model tracks now surface to the frontend.

---

### 7. Frontend build failure on Vercel preview deployments (MEDIUM)

**File:** `eve-frontend/lib/supabase.js`  
**Impact:** Module-level code threw `[MaxEdge] Missing Supabase credentials.` during `next build` on preview deployments, which don't inject env vars at build time. This broke all preview deploys.

**Fix:** Changed from eager `createClient` to a Proxy-based lazy initialiser. The error is now thrown at call-time (never during `next build`).

---

## Files Modified

| File | Repo | Change |
|------|------|--------|
| `computeValues.js` | eve-engine | v7: removed `signals_written` gate, odds-hash dedup, `EV_THRESHOLD=0.005`, `MIN_BOOKMAKERS=2`, `max_edge_score` 0–100 scale |
| `computeApiValues.js` | eve-engine | v2: same fixes — removed `signals_written` gate, lowered thresholds, odds-hash dedup, `PriceMove` category |
| `.github/workflows/engine.yml` | eve-engine | Added `planDay.js` step with `DAYS_AHEAD=3` before ingest loop |
| `lib/supabase.js` | eve-frontend | Proxy-based lazy init (no throw at module load) |
| `lib/feed.js` | eve-frontend | Removed model architecture filter; `edgeToAIProb()` replaces `fairOddsToModelProb`; renamed sort option |
| `components/MobileFeedHeader.js` | eve-frontend | Two-row layout: logo/count row + scrollable filter pills row |

---

## Pipeline Architecture (Current State)

```
GitHub Actions (every 5min, from main only)
  └── planDay.js          → creates engine_plan row (DAYS_AHEAD=3, idempotent)
  └── ingestOdds.js       → fetches odds from OddsAPI → writes odds table
  └── computeValues.js    → Kaunitz consensus → computed_values (MARKET_CONSENSUS)
                          → value_signals (Prime/Standard/PriceMove)
  └── fetchMatchDetails.js → API-Football /predictions → match_predictions
  └── computeApiValues.js → p_api model → computed_values (API_PREDICTIVE)
                          → value_signals (Prime/Longshot Edge/Standard/PriceMove)
```

---

## MES Score System

| Score | Zone | Colour |
|-------|------|--------|
| 0–20 | LOW | Red `#ea3943` |
| 21–40 | MODERATE | Amber `#f59e0b` |
| 41–60 | STANDARD | Yellow `#ffd600` |
| 61–80 | STRONG | Light green `#8bc34a` |
| 81–100 | HIGH | Green `#16c784` |

**Formula:** `max_edge_score = Math.min(100, Math.round(max_edge_val * 1000))`  
Where `max_edge_val` is the highest of `home_edge`, `draw_edge`, `away_edge`.  
A 1% edge = score 10. A 10% edge = score 100 (capped).

The `MARKET_CONSENSUS` model also writes `confidence_score = Math.min(100, bookmakerCount * 5)` — separate from MES.

---

## Signal Categories

### MARKET_CONSENSUS
| Category | Condition |
|----------|-----------|
| `Prime` | edge ≥ 5% |
| `Standard` | 0.5% ≤ edge < 5% |
| `PriceMove` | edge threshold met, same match/outcome signalled before but odds have changed |

### API_PREDICTIVE
| Category | Condition |
|----------|-----------|
| `Prime` | edge ≥ 5% AND p_api ≥ 15% |
| `Longshot Edge` | edge ≥ 5% AND p_api < 15% |
| `Standard` | 0.5% ≤ edge < 5% |
| `PriceMove` | odds changed since last signal within dedup window |

---

## Frontend Composite Key Audit

### `.single()` usage scan
Searched `lib/feed.js`, `lib/signals.ts`, `components/MatchCard.js`, `app/market-pulse/page.js` for `.single()` calls.

**Result: No `.single()` calls found on `computed_values` or `value_signals` queries.** All queries use `.select()` with array returns. Multi-model rows are safe.

### MES score rendering
`MatchCard.js` uses `clampScore(row.maxEdgeScore)` → `zoneOf(score)` from `ConfidenceGauge.js`. Both handle non-numeric inputs defensively (`Number.isFinite` guard, defaults to 0).

### Optional chaining audit
All market grid fields in `MatchCard.js` use defensive optional chaining (`row.allBttsYesOdds?.[bk]`, `row.totalsLine ?? ''`, etc.). No crash paths identified for null ancillary market data.

### `signals.ts` dedup key
Deduplication key is `${match_id}|${model_architecture}` — correctly handles two model rows per match without collision.

---

## API_PREDICTIVE Pipeline (xG / API-Football) Verification

### Data flow
1. `fetchMatchDetails.js` calls API-Football `/predictions` per fixture
2. Parses `"55%"` → `"0.5500"` via `parsePct()` and writes to `match_predictions.pct_home/draw/away` as TEXT
3. `computeApiValues.js` reads via `parseFloat(prediction.pct_home)` — handles TEXT decimal strings correctly

### Known gap
`match_predictions` row count was not verified against live Supabase in this audit. If `fetchMatchDetails.js` has not run recently (or if the World Cup fixture IDs in `engine_plan.fixture_ids` don't match `matches.external_id`), `computeApiValues.js` will log *"no matches with both odds and predictions — nothing to compute"* and exit cleanly.

**Recommended check:**
```sql
SELECT COUNT(*), MAX(created_at) FROM match_predictions;
SELECT COUNT(*) FROM computed_values WHERE model_architecture = 'API_PREDICTIVE';
```

---

## League Coverage

`planDay.js` currently fetches fixtures for **FIFA World Cup 2026 (league ID 1) only**. No other leagues are covered. Once the World Cup concludes, the engine will have no fixtures to process. Expanding to additional leagues (Champions League, Premier League, etc.) requires updating `planDay.js` to include additional league IDs.

---

## Confirmation Checklist

- [x] `planDay.js` added to workflow — engine no longer stalls after first day
- [x] `EV_THRESHOLD` lowered to 0.5% in both compute scripts
- [x] `MIN_BOOKMAKERS` aligned to 2 in both compute scripts
- [x] `signals_written` gate removed from `computeApiValues.js`
- [x] Odds-hash dedup (60min window) active in both compute scripts
- [x] `PriceMove` signal category wired in `computeApiValues.js`
- [x] `max_edge_score` written by `computeApiValues.js` (was missing in v1)
- [x] Frontend build no longer throws on Vercel preview deployments
- [x] Both model tracks surface to frontend (filter removed from feed.js)
- [x] No `.single()` misuse on multi-row queries
- [x] MES bar renders correctly for 0–100 integer scores
- [ ] `match_predictions` row count verified in live DB (pending manual check)
- [ ] Additional leagues added to `planDay.js` (pending product decision)
