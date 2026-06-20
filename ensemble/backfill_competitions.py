#!/usr/bin/env python3
"""
ensemble/backfill_competitions.py — Backfill fixture_predictions from StatsBomb open data.

Handles any competition available via statsbombpy, auto-creates leagues and teams in DB,
and upserts to fixture_predictions. Designed for resumability — skips already-imported
fixture_ids. Run multiple times safely.

Usage:
  cd engine && export $(cat .env | xargs) && python3 ensemble/backfill_competitions.py

Edit COMPETITIONS list below to add/remove competitions.
"""

import os
import sys
import time
import uuid
from datetime import datetime, timezone
from functools import wraps

import pandas as pd
from statsbombpy import sb
from supabase import create_client

SUPABASE_URL = os.environ.get('SUPABASE_URL')
SUPABASE_KEY = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
if not SUPABASE_URL or not SUPABASE_KEY:
    sys.exit('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')

client = create_client(SUPABASE_URL, SUPABASE_KEY)

# ── Competitions to backfill ──────────────────────────────────────────────────
# (competition_id, season_id, fixture_prefix, league_name, league_country)
# Start with international (highest WC relevance), then club data.
COMPETITIONS = [
    # Already done (will skip cleanly): copa_2024, euro_2024, ucl_2018, ucl_2017, laliga_2018, ligue1_2022
    (223, 282, 'copa_2024',       'Copa América',    'South America'),
    (55,  282, 'euro_2024',       'UEFA Euro',       'Europe'),
    (11,  4,   'laliga_2018',     'La Liga',         'Spain'),
    (7,   235, 'ligue1_2022',     'Ligue 1',         'France'),
    # Bundesliga (timed out previously)
    (9,   281, 'bundesliga_2023', '1. Bundesliga',   'Germany'),
    (9,   27,  'bundesliga_2015', '1. Bundesliga',   'Germany'),
    # More La Liga seasons for deeper training data
    (11,  1,   'laliga_2017',     'La Liga',         'Spain'),
    (11,  2,   'laliga_2016',     'La Liga',         'Spain'),
    (11,  27,  'laliga_2015',     'La Liga',         'Spain'),
    (11,  26,  'laliga_2014',     'La Liga',         'Spain'),
    (11,  25,  'laliga_2013',     'La Liga',         'Spain'),
    # More Ligue 1
    (7,   108, 'ligue1_2021',     'Ligue 1',         'France'),
    (7,   27,  'ligue1_2015',     'Ligue 1',         'France'),
    # African Cup of Nations 2023
    (1267, 107, 'afcon_2023',     'African Cup of Nations', 'Africa'),
]

PPDA_DEFAULT = 11.5
PPDA_MIN = 7.5
PPDA_MAX = 15.5
BATCH_SIZE = 50


def with_retry(fn, *args, retries=3, delay=3, **kwargs):
    """Call fn(*args, **kwargs), retrying on ReadTimeout up to `retries` times."""
    import httpx
    for attempt in range(retries):
        try:
            return fn(*args, **kwargs)
        except (httpx.ReadTimeout, httpx.ConnectTimeout, Exception) as e:
            if 'Timeout' in type(e).__name__ or 'timeout' in str(e).lower():
                if attempt < retries - 1:
                    print(f'  ⏳ timeout, retrying in {delay}s... (attempt {attempt+2}/{retries})')
                    time.sleep(delay)
                    continue
            raise
    return None


# ── DB helpers ────────────────────────────────────────────────────────────────

def load_existing_fixture_ids():
    resp = client.table('fixture_predictions').select('fixture_id').execute()
    return {r['fixture_id'] for r in (resp.data or [])}


def load_leagues():
    resp = client.table('leagues').select('id, name, country').execute()
    return {r['name']: r for r in (resp.data or [])}


def ensure_league(leagues_cache, name, country):
    """Return league_id, creating the row if needed."""
    if name in leagues_cache:
        return leagues_cache[name]['id']
    new_id = str(uuid.uuid4())
    with_retry(
        client.table('leagues').insert({'id': new_id, 'name': name, 'country': country}).execute
    )
    leagues_cache[name] = {'id': new_id, 'name': name, 'country': country}
    print(f'  Created league: {name} ({country})')
    return new_id


def load_teams():
    resp = client.table('teams').select('id, name').execute()
    return {r['name'].lower(): r['id'] for r in (resp.data or [])}


def batch_ensure_teams(teams_cache, names):
    """Insert any team names not already in the DB, in one batch call."""
    new_names = [n for n in names if n.lower() not in teams_cache]
    if not new_names:
        return

    rows = [{'id': str(uuid.uuid4()), 'name': n} for n in new_names]
    try:
        client.table('teams').insert(rows).execute()
        for r in rows:
            teams_cache[r['name'].lower()] = r['id']
        print(f'  Created {len(rows)} new teams')
    except Exception as e:
        # Some may already exist — insert individually as fallback
        print(f'  Batch team insert failed ({e}), inserting individually...')
        for r in rows:
            try:
                client.table('teams').insert({'id': r['id'], 'name': r['name']}).execute()
                teams_cache[r['name'].lower()] = r['id']
            except Exception:
                pass  # May already exist due to race; reload below
        # Reload to catch any already-existing teams we missed
        fresh = client.table('teams').select('id, name').execute()
        for r in (fresh.data or []):
            teams_cache[r['name'].lower()] = r['id']


# ── StatsBomb helpers ─────────────────────────────────────────────────────────

def compute_match_stats(match_id, home_team, away_team):
    """Fetch events for a match and return (home_xg, away_xg, ppda_index)."""
    try:
        events = sb.events(match_id=match_id)

        shots = events[events['type'] == 'Shot']
        xg_map = shots.groupby('team')['shot_statsbomb_xg'].sum().to_dict()
        home_xg = float(xg_map.get(home_team, 0.0))
        away_xg = float(xg_map.get(away_team, 0.0))

        pressures = events[events['type'] == 'Pressure'].groupby('team').size().to_dict()
        home_press = pressures.get(home_team, 0)
        away_press = pressures.get(away_team, 0)
        total = home_press + away_press

        if total > 0:
            ppda = round(25.0 - (home_press / total) * 20.0, 2)
            ppda = max(PPDA_MIN, min(PPDA_MAX, ppda))
        else:
            ppda = PPDA_DEFAULT

        return home_xg, away_xg, ppda

    except Exception as e:
        return None, None, None


# ── Main ──────────────────────────────────────────────────────────────────────

def backfill_competition(comp_id, season_id, prefix, league_name, league_country,
                         existing_ids, leagues_cache, teams_cache):
    print(f'\n── {league_name} (comp={comp_id}, season={season_id}) ──')

    try:
        matches_df = sb.matches(competition_id=comp_id, season_id=season_id)
    except Exception as e:
        print(f'  ERROR fetching match list: {e}')
        return 0

    print(f'  {len(matches_df)} matches available')

    league_id = ensure_league(leagues_cache, league_name, league_country)

    # Pre-register all team names in a single batch call
    all_team_names = list(set(
        list(matches_df['home_team'].astype(str)) +
        list(matches_df['away_team'].astype(str))
    ))
    batch_ensure_teams(teams_cache, all_team_names)

    records = []
    skipped = 0
    failed = 0

    for _, row in matches_df.iterrows():
        match_id   = row['match_id']
        fixture_id = f'{prefix}_{match_id}'

        if fixture_id in existing_ids:
            skipped += 1
            continue

        home_team = str(row['home_team'])
        away_team = str(row['away_team'])
        home_score = int(row['home_score'])
        away_score = int(row['away_score'])
        match_date = str(row['match_date'])

        home_xg, away_xg, ppda = compute_match_stats(match_id, home_team, away_team)
        if home_xg is None:
            failed += 1
            print(f'  ✗ event fetch failed: {home_team} vs {away_team}')
            continue

        try:
            kickoff_at = datetime.strptime(match_date, '%Y-%m-%d').isoformat()
        except ValueError:
            kickoff_at = match_date

        records.append({
            'fixture_id':           fixture_id,
            'match_kickoff_at':     kickoff_at,
            'home_team_name':       home_team,
            'away_team_name':       away_team,
            'home_goals_scored':    home_score,
            'away_goals_scored':    away_score,
            'xg_created':           home_xg,
            'xg_conceded':          away_xg,
            'ppda_intensity_index': ppda,
            'model_architecture':   'ML_ENSEMBLE',
            'feature_completeness': True,
        })
        existing_ids.add(fixture_id)

        # Batch insert to avoid memory growth on large competitions
        if len(records) >= BATCH_SIZE:
            with_retry(client.table('fixture_predictions').upsert(records).execute)
            print(f'  ↑ {len(records)} rows upserted (running total: {len(existing_ids)})')
            records = []

        # Small delay to be kind to StatsBomb CDN
        time.sleep(0.05)

    # Flush remaining
    inserted = 0
    if records:
        with_retry(client.table('fixture_predictions').upsert(records).execute)
        inserted = len(records)

    total_new = len(matches_df) - skipped - failed
    print(f'  Done: {total_new} new  |  {skipped} already existed  |  {failed} failed')
    return total_new


def main():
    print('=== backfill_competitions.py ===')
    existing_ids = load_existing_fixture_ids()
    leagues_cache = load_leagues()
    teams_cache = load_teams()
    print(f'Existing fixture_predictions: {len(existing_ids)}')
    print(f'Existing leagues: {len(leagues_cache)}, teams: {len(teams_cache)}')

    grand_total = 0
    for (comp_id, season_id, prefix, league_name, league_country) in COMPETITIONS:
        n = backfill_competition(
            comp_id, season_id, prefix, league_name, league_country,
            existing_ids, leagues_cache, teams_cache,
        )
        grand_total += n

    print(f'\n✅ Done — {grand_total} new fixture_predictions rows written')
    print(f'   Total in DB: {len(existing_ids)}')
    print('\nNext steps:')
    print('  python3 ensemble/seed_team_stats.py    # compute rolling stats for all teams')
    print('  python3 ensemble/seed_matches.py       # import as completed matches')
    print('  python3 ensemble/train.py --dry-run    # check data volume')


if __name__ == '__main__':
    main()
