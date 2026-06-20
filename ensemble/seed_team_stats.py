#!/usr/bin/env python3
"""
ensemble/seed_team_stats.py — Compute rolling team stats for ALL teams in fixture_predictions.

Generalised replacement for seed_world_cup.py. Reads all historical fixtures,
builds rolling 5 and 10-game averages for every team, and upserts into team_stats_cache.

Teams not in the teams table are auto-registered (name-only, no crest/country).

Usage:
  cd engine && export $(cat .env | xargs) && python3 ensemble/seed_team_stats.py
"""

import os
import sys
from datetime import datetime, timezone

import pandas as pd
from supabase import create_client

SUPABASE_URL = os.environ.get('SUPABASE_URL')
SUPABASE_KEY = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
if not SUPABASE_URL or not SUPABASE_KEY:
    sys.exit('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')

client = create_client(SUPABASE_URL, SUPABASE_KEY)

SOT_RATIO_BASELINE = 0.38   # no per-shot data in fixture_predictions
WINDOWS = [5, 10]
BATCH_SIZE = 200

# StatsBomb name → canonical DB name (extend as needed)
NAME_MAP = {
    'United States':          'USA',
    'Korea Republic':         'South Korea',
    'South Korea':            'South Korea',
    "Côte d'Ivoire":          'Ivory Coast',
    "Cote d'Ivoire":          'Ivory Coast',
    'IR Iran':                'Iran',
    'Bosnia and Herzegovina': 'Bosnia & Herzegovina',
    'Türkiye':                'Turkey',
    'Czechia':                'Czech Republic',
}


def normalise(name):
    return NAME_MAP.get(name, name)


def load_all_fixtures():
    # First get exact count, then fetch all in pages using range()
    count_resp = (
        client.table('fixture_predictions')
        .select('fixture_id', count='exact')
        .execute()
    )
    total = count_resp.count or len(count_resp.data or [])

    PAGE = 500
    all_rows = []
    for start in range(0, total, PAGE):
        end = min(start + PAGE - 1, total - 1)
        resp = (
            client.table('fixture_predictions')
            .select('home_team_name, away_team_name, match_kickoff_at, '
                    'home_goals_scored, away_goals_scored, '
                    'xg_created, xg_conceded, ppda_intensity_index')
            .order('match_kickoff_at', desc=False)
            .range(start, end)
            .execute()
        )
        batch = resp.data or []
        all_rows.extend(batch)

    print(f'Loaded {len(all_rows)} fixture_predictions rows (total in DB: {total})')
    return pd.DataFrame(all_rows)


def load_team_ids():
    resp = client.table('teams').select('id, name').execute()
    return {r['name'].lower(): r['id'] for r in (resp.data or [])}


def ensure_team(teams_cache, name):
    """Return team_id, inserting a new row if not present."""
    key = name.lower()
    if key in teams_cache:
        return teams_cache[key]
    import uuid
    new_id = str(uuid.uuid4())
    try:
        client.table('teams').insert({'id': new_id, 'name': name}).execute()
        teams_cache[key] = new_id
        print(f'  New team added: {name}')
    except Exception as e:
        print(f'  ⚠ Could not insert team "{name}": {e}')
    return teams_cache.get(key)


def build_game_log(df):
    """Expand each fixture into two team-perspective rows."""
    df = df.copy()
    df['ppda_intensity_index'] = pd.to_numeric(df['ppda_intensity_index'], errors='coerce').fillna(11.5)
    df['xg_created']   = pd.to_numeric(df['xg_created'],   errors='coerce').fillna(0.0)
    df['xg_conceded']  = pd.to_numeric(df['xg_conceded'],  errors='coerce').fillna(0.0)
    df['home_goals_scored'] = pd.to_numeric(df['home_goals_scored'], errors='coerce').fillna(0)
    df['away_goals_scored'] = pd.to_numeric(df['away_goals_scored'], errors='coerce').fillna(0)

    home_rows = pd.DataFrame({
        'team':           df['home_team_name'].apply(normalise),
        'kickoff_at':     pd.to_datetime(df['match_kickoff_at']),
        'goals_scored':   df['home_goals_scored'],
        'goals_conceded': df['away_goals_scored'],
        'xg_created':     df['xg_created'],
        'xg_conceded':    df['xg_conceded'],
        'ppda_index':     df['ppda_intensity_index'],
    })

    ppda_away = (30.0 - df['ppda_intensity_index']).clip(7.5, 15.5)
    away_rows = pd.DataFrame({
        'team':           df['away_team_name'].apply(normalise),
        'kickoff_at':     pd.to_datetime(df['match_kickoff_at']),
        'goals_scored':   df['away_goals_scored'],
        'goals_conceded': df['home_goals_scored'],
        'xg_created':     df['xg_conceded'],
        'xg_conceded':    df['xg_created'],
        'ppda_index':     ppda_away,
    })

    log = pd.concat([home_rows, away_rows], ignore_index=True)
    return log.sort_values('kickoff_at').reset_index(drop=True)


def compute_rolling(log, window):
    METRICS = ['goals_scored', 'goals_conceded', 'xg_created', 'xg_conceded', 'ppda_index']
    records = []

    for team, group in log.groupby('team'):
        group = group.sort_values('kickoff_at')
        if len(group) < 1:
            continue
        tail = group.tail(window)
        avgs = tail[METRICS].mean()
        records.append({
            'team_name':      team,
            'roll_window':    window,
            'as_of':          tail['kickoff_at'].max().isoformat(),
            'games_played':   len(tail),
            'xg_created':     round(float(avgs['xg_created']),    4),
            'xg_conceded':    round(float(avgs['xg_conceded']),   4),
            'ppda_index':     round(float(avgs['ppda_index']),     4),
            'sot_ratio':      SOT_RATIO_BASELINE,
            'shots_per_game': None,
            'goals_scored':   round(float(avgs['goals_scored']),  4),
            'goals_conceded': round(float(avgs['goals_conceded']), 4),
        })

    return records


def upsert_stats(records, teams_cache):
    rows = []
    for r in records:
        team_id = ensure_team(teams_cache, r['team_name'])
        if not team_id:
            continue
        rows.append({
            'team_id':        team_id,
            'roll_window':    r['roll_window'],
            'as_of':          r['as_of'],
            'games_played':   r['games_played'],
            'xg_created':     r['xg_created'],
            'xg_conceded':    r['xg_conceded'],
            'ppda_index':     r['ppda_index'],
            'sot_ratio':      r['sot_ratio'],
            'shots_per_game': r['shots_per_game'],
            'goals_scored':   r['goals_scored'],
            'goals_conceded': r['goals_conceded'],
            'updated_at':     datetime.now(timezone.utc).isoformat(),
        })

    if not rows:
        return 0

    # Delete existing rows for these team_ids + window, then insert fresh
    window = rows[0]['roll_window']
    team_ids = list({r['team_id'] for r in rows})

    # Delete in batches (Supabase .in_() can struggle with very long lists)
    for i in range(0, len(team_ids), 100):
        batch = team_ids[i:i + 100]
        client.table('team_stats_cache').delete() \
            .in_('team_id', batch).eq('roll_window', window).execute()

    for i in range(0, len(rows), BATCH_SIZE):
        client.table('team_stats_cache').insert(rows[i:i + BATCH_SIZE]).execute()

    return len(rows)


def main():
    print('=== seed_team_stats.py ===')

    df = load_all_fixtures()
    if df.empty:
        sys.exit('No fixture_predictions found')

    teams_cache = load_team_ids()
    print(f'Teams in DB: {len(teams_cache)}')

    log = build_game_log(df)
    unique_teams = log['team'].nunique()
    print(f'Game log: {len(log)} rows across {unique_teams} unique teams')

    total = 0
    for w in WINDOWS:
        records = compute_rolling(log, w)
        n = upsert_stats(records, teams_cache)
        print(f'  window={w}: {n} rows upserted')
        total += n

    print(f'\n✅ Done — {total} team_stats_cache rows written across {unique_teams} teams')
    print('Next: python3 ensemble/seed_matches.py')


if __name__ == '__main__':
    main()
