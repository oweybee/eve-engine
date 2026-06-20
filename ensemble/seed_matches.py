#!/usr/bin/env python3
"""
ensemble/seed_matches.py — Import historical fixture_predictions into matches table.

Reads all fixture_predictions rows (WC + club competitions) and inserts them as
completed match rows in the matches table so train.py has labelled training data.

Determines the league from the fixture_id prefix (e.g., wc_, copa_, euro_, ucl_, laliga_).
Skips fixtures where either team has no matching row in the teams table.

Usage:
  cd engine && export $(cat .env | xargs) && python3 ensemble/seed_matches.py
"""

import os
import sys
from datetime import datetime, timezone

from supabase import create_client

SUPABASE_URL = os.environ.get('SUPABASE_URL')
SUPABASE_KEY = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
if not SUPABASE_URL or not SUPABASE_KEY:
    sys.exit('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')

client = create_client(SUPABASE_URL, SUPABASE_KEY)

# fixture_id prefix → league name in DB
PREFIX_TO_LEAGUE = {
    'wc_':           'FIFA World Cup',
    'copa_':         'Copa América',
    'euro_':         'UEFA Euro',
    'ucl_':          'Champions League',
    'ucl2_':         'Champions League',
    'laliga_':       'La Liga',
    'ligue1_':       'Ligue 1',
    'bundesliga_':   '1. Bundesliga',
    'epl_':          'Premier League',
    'seriea_':       'Serie A',
    'afcon_':        'African Cup of Nations',
}

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
    'DR Congo':               'DR Congo',
}


def normalise(name):
    return NAME_MAP.get(name, name)


def load_team_ids():
    resp = client.table('teams').select('id, name').execute()
    return {r['name'].lower(): r['id'] for r in (resp.data or [])}


def load_league_ids():
    resp = client.table('leagues').select('id, name').execute()
    return {r['name']: r['id'] for r in (resp.data or [])}


def league_id_for_fixture(fixture_id, league_ids):
    """Derive league_id from fixture_id prefix using PREFIX_TO_LEAGUE map."""
    for prefix, league_name in PREFIX_TO_LEAGUE.items():
        if fixture_id.startswith(prefix):
            return league_ids.get(league_name)
    return None


def derive_result(home_goals, away_goals):
    if home_goals > away_goals:
        return 'home'
    if away_goals > home_goals:
        return 'away'
    return 'draw'


def main():
    print('=== seed_matches.py ===')

    # Load all source data (paginate past supabase-py 1000-row default limit)
    count_resp = client.table('fixture_predictions').select('fixture_id', count='exact').execute()
    total = count_resp.count or len(count_resp.data or [])

    PAGE = 500
    fixtures = []
    for start in range(0, total, PAGE):
        end = min(start + PAGE - 1, total - 1)
        resp = (
            client.table('fixture_predictions')
            .select('*')
            .order('match_kickoff_at', desc=False)
            .range(start, end)
            .execute()
        )
        fixtures.extend(resp.data or [])
    print(f'Loaded {len(fixtures)} fixture_predictions rows (total: {total})')

    team_ids  = load_team_ids()
    league_ids = load_league_ids()
    print(f'Teams in DB: {len(team_ids)}, Leagues: {len(league_ids)}')

    # Load all existing historical external_ids to avoid duplicates
    existing_resp = (
        client.table('matches')
        .select('external_id')
        .filter('external_id', 'not.is', 'null')
        .execute()
    )
    existing_ids = {r['external_id'] for r in (existing_resp.data or []) if r['external_id']}
    print(f'Existing historical match rows: {len(existing_ids)}')

    rows = []
    skipped_team = 0
    skipped_dup = 0
    skipped_league = 0

    for f in fixtures:
        ext_id = f['fixture_id']
        if ext_id in existing_ids:
            skipped_dup += 1
            continue

        league_id = league_id_for_fixture(ext_id, league_ids)
        if not league_id:
            skipped_league += 1
            continue

        home_name = normalise(f['home_team_name'])
        away_name = normalise(f['away_team_name'])

        home_id = team_ids.get(home_name.lower())
        away_id = team_ids.get(away_name.lower())

        if not home_id or not away_id:
            skipped_team += 1
            continue

        home_goals = int(f['home_goals_scored'])
        away_goals = int(f['away_goals_scored'])

        xg_home = float(f['xg_created'])
        xg_away = float(f['xg_conceded'])
        ppda_home = float(f['ppda_intensity_index'])
        ppda_away = round(30.0 - ppda_home, 4)
        ppda_away = max(7.5, min(15.5, ppda_away))

        rows.append({
            'external_id':       ext_id,
            'home_team_id':      home_id,
            'away_team_id':      away_id,
            'league_id':         league_id,
            'kickoff_at':        f['match_kickoff_at'],
            'status':            'completed',
            'is_bet_of_day':     False,
            'goals_home':        home_goals,
            'goals_away':        away_goals,
            'xg_home':           xg_home,
            'xg_away':           xg_away,
            'xg_conceded_home':  xg_away,
            'xg_conceded_away':  xg_home,
            'ppda_home':         ppda_home,
            'ppda_away':         ppda_away,
            'result':            derive_result(home_goals, away_goals),
            'stats_source':      'statsbomb',
            'created_at':        datetime.now(timezone.utc).isoformat(),
        })

    print(f'\nSkipped (already imported): {skipped_dup}')
    if skipped_team:
        print(f'Skipped (no team_id match): {skipped_team}')
    if skipped_league:
        print(f'Skipped (unknown league prefix): {skipped_league}')

    if not rows:
        print('\nNothing new to insert.')
        return

    print(f'\nInserting {len(rows)} completed match rows...')
    batch_size = 100
    inserted = 0
    for i in range(0, len(rows), batch_size):
        batch = rows[i:i + batch_size]
        client.table('matches').insert(batch).execute()
        inserted += len(batch)
        print(f'  {inserted}/{len(rows)} inserted')

    print(f'\n✅ Done — {inserted} historical matches now in matches table')

    # Show result distribution
    results = [r['result'] for r in rows]
    home_w = results.count('home')
    draws  = results.count('draw')
    away_w = results.count('away')
    total  = len(results)
    print(f'   Result split: home={home_w} ({home_w/total:.0%})  '
          f'draw={draws} ({draws/total:.0%})  '
          f'away={away_w} ({away_w/total:.0%})')

    print('\nNext: python3 ensemble/train.py --dry-run')


if __name__ == '__main__':
    main()
