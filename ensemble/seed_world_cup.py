#!/usr/bin/env python3
"""
ensemble/seed_world_cup.py — Seed team_stats_cache from World Cup fixture history

Reads fixture_predictions (backfilled from StatsBomb 2018 + 2022) and computes
rolling 5-game and 10-game stats per team, writing them into team_stats_cache so
that train.py has features to work with.

Usage:
  cd engine && export $(cat .env | xargs) && python3 ensemble/seed_world_cup.py
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

SOT_RATIO_BASELINE = 0.38   # no shot data in fixture_predictions — use league avg
WINDOWS = [5, 10]

# StatsBomb team names → teams table names where they differ
NAME_MAP = {
    'United States':    'USA',
    'Korea Republic':   'South Korea',
    'South Korea':      'South Korea',
    'Côte d\'Ivoire':   'Ivory Coast',
    'Cote d\'Ivoire':   'Ivory Coast',
    'IR Iran':          'Iran',
    'Bosnia and Herzegovina': 'Bosnia & Herzegovina',
    'Türkiye':          'Turkey',
    'Czechia':          'Czech Republic',
    'DR Congo':         'DR Congo',
    'Wales':            'Wales',
    'Iceland':          'Iceland',
    'Russia':           'Russia',
    'Panama':           'Panama',
    'Peru':             'Peru',
    'Costa Rica':       'Costa Rica',
    'Saudi Arabia':     'Saudi Arabia',
    'Tunisia':          'Tunisia',
    'Qatar':            'Qatar',
}


def normalise(name):
    return NAME_MAP.get(name, name)


def load_fixture_predictions():
    resp = (
        client.table('fixture_predictions')
        .select('*')
        .order('match_kickoff_at', desc=False)
        .execute()
    )
    rows = resp.data or []
    print(f'Loaded {len(rows)} fixture_predictions rows')
    return pd.DataFrame(rows)


def load_team_ids():
    """Returns dict: lower(name) → team_id"""
    resp = client.table('teams').select('id, name').execute()
    return {r['name'].lower(): r['id'] for r in (resp.data or [])}


def build_game_log(df):
    """
    Expand each fixture into two team-perspective rows.
    home ppda = ppda_intensity_index (already home-centric)
    away ppda = 30.0 − ppda_intensity_index (inverse derivation)
    """
    home_rows = df.rename(columns={
        'home_team_name':   'team',
        'away_team_name':   'opponent',
        'home_goals_scored': 'goals_scored',
        'away_goals_scored': 'goals_conceded',
        'xg_created':        'xg_created',
        'xg_conceded':       'xg_conceded',
    }).assign(
        ppda_index=df['ppda_intensity_index'],
        kickoff_at=df['match_kickoff_at'],
    )[['team', 'opponent', 'kickoff_at', 'goals_scored', 'goals_conceded',
       'xg_created', 'xg_conceded', 'ppda_index']]

    away_rows = df.rename(columns={
        'away_team_name':    'team',
        'home_team_name':    'opponent',
        'away_goals_scored': 'goals_scored',
        'home_goals_scored': 'goals_conceded',
        'xg_conceded':       'xg_created',   # away's xg created = home's xg conceded
        'xg_created':        'xg_conceded',
    }).assign(
        ppda_index=(30.0 - df['ppda_intensity_index']).clip(7.5, 15.5),
        kickoff_at=df['match_kickoff_at'],
    )[['team', 'opponent', 'kickoff_at', 'goals_scored', 'goals_conceded',
       'xg_created', 'xg_conceded', 'ppda_index']]

    log = pd.concat([home_rows, away_rows], ignore_index=True)
    log['kickoff_at'] = pd.to_datetime(log['kickoff_at'])
    log['team'] = log['team'].apply(normalise)
    return log.sort_values('kickoff_at').reset_index(drop=True)


def compute_rolling(log, window):
    """
    For each team, compute rolling N-game averages as of their most recent game.
    Returns list of dicts ready for upsert into team_stats_cache.
    """
    METRICS = ['goals_scored', 'goals_conceded', 'xg_created', 'xg_conceded', 'ppda_index']
    records = []

    for team, group in log.groupby('team'):
        group = group.sort_values('kickoff_at')
        if len(group) < 1:
            continue

        # Take the last N games available (may be fewer than window for new teams)
        tail = group.tail(window)
        n = len(tail)
        avgs = tail[METRICS].mean()

        records.append({
            'team_name':      team,
            'roll_window':    window,
            'as_of':          tail['kickoff_at'].max().isoformat(),
            'games_played':   n,
            'xg_created':     round(float(avgs['xg_created']),    4),
            'xg_conceded':    round(float(avgs['xg_conceded']),   4),
            'ppda_index':     round(float(avgs['ppda_index']),     4),
            'sot_ratio':      SOT_RATIO_BASELINE,
            'shots_per_game': None,
            'goals_scored':   round(float(avgs['goals_scored']),  4),
            'goals_conceded': round(float(avgs['goals_conceded']), 4),
        })

    return records


def upsert_stats(records, team_ids):
    rows = []
    unmatched = []

    for r in records:
        name_lower = r['team_name'].lower()
        team_id = team_ids.get(name_lower)
        if not team_id:
            unmatched.append(r['team_name'])
            continue
        rows.append({
            'team_id':       team_id,
            'roll_window':   r['roll_window'],
            'as_of':         r['as_of'],
            'games_played':  r['games_played'],
            'xg_created':    r['xg_created'],
            'xg_conceded':   r['xg_conceded'],
            'ppda_index':    r['ppda_index'],
            'sot_ratio':     r['sot_ratio'],
            'shots_per_game': r['shots_per_game'],
            'goals_scored':  r['goals_scored'],
            'goals_conceded': r['goals_conceded'],
            'updated_at':    datetime.now(timezone.utc).isoformat(),
        })

    if unmatched:
        print(f'  ⚠ No team_id match for: {sorted(set(unmatched))}')

    if not rows:
        print('  Nothing to upsert')
        return 0

    # Delete existing rows for these team_ids + window, then insert fresh.
    # (supabase-py 0.7.x doesn't support on_conflict kwarg)
    team_ids_to_replace = list({r['team_id'] for r in rows})
    window = rows[0]['roll_window']
    client.table('team_stats_cache').delete() \
        .in_('team_id', team_ids_to_replace) \
        .eq('roll_window', window) \
        .execute()

    client.table('team_stats_cache').insert(rows).execute()
    return len(rows)


def main():
    print('=== seed_world_cup.py ===')

    df = load_fixture_predictions()
    if df.empty:
        sys.exit('No fixture_predictions found — run backfill_fixtures.py first')

    team_ids = load_team_ids()
    print(f'Teams in DB: {len(team_ids)}')

    log = build_game_log(df)
    print(f'Game log: {len(log)} team-game rows across {log["team"].nunique()} teams')

    total = 0
    for w in WINDOWS:
        records = compute_rolling(log, w)
        n = upsert_stats(records, team_ids)
        print(f'  window={w}: {n} rows upserted')
        total += n

    print(f'\n✅ Done — {total} team_stats_cache rows written')
    print('Next: python3 ensemble/train.py --dry-run  (check data volume before training)')


if __name__ == '__main__':
    main()
