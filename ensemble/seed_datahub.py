#!/usr/bin/env python3
"""
ensemble/seed_datahub.py — Import historical top-5 European league data from datahub.io

Downloads CSVs for EPL, La Liga, Bundesliga, Serie A, Ligue 1 (2005/06 onwards,
when full shot data became available) and inserts them into:

  1. fixture_predictions — game log row per match (home team's perspective),
     with xG proxy derived from shots on target (HST * 0.35).
     Used by train.py and seed_team_stats.py to build rolling team stats.

  2. matches — one labelled row per match with full stats and result.
     Used by train.py as the primary training target.

xG proxy:   HST * 0.35  (home xg_created),  AST * 0.35  (away = home xg_conceded)
PPDA proxy: 11.5 baseline (pass counts unavailable in this dataset)
SOT ratio:  HST / max(HS, 1)  — real value, not hardcoded baseline

The script is fully idempotent — re-running it skips rows already imported.

Usage:
  cd engine && export $(cat .env | xargs) && python3 ensemble/seed_datahub.py

Optional flags:
  --leagues epl,laliga       Only import specific leagues (default: all 5)
  --from-season 1617         Start from this season code (default: 0506)
  --dry-run                  Download and parse CSVs but do not write to DB
"""

import argparse
import io
import os
import re
import sys
import time
import uuid
from datetime import datetime, timezone
from typing import Dict, List, Optional, Set, Tuple

import pandas as pd
import requests
from supabase import create_client

# ── Configuration ──────────────────────────────────────────────────────────────

SUPABASE_URL = os.environ.get('SUPABASE_URL')
SUPABASE_KEY = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
if not SUPABASE_URL or not SUPABASE_KEY:
    sys.exit('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')

XG_CONVERSION = 0.35   # SOT → xG proxy (industry-standard approximation)
PPDA_BASELINE = 11.5   # used when pass data is unavailable
BATCH_SIZE    = 200    # Supabase upsert batch size

# ── League definitions ─────────────────────────────────────────────────────────
#   key        → CLI flag name
#   url_slug   → datahub.io URL path segment
#   db_name    → name in leagues table
#   country    → leagues.country

LEAGUES = {
    'epl': {
        'url_slug': 'english-premier-league',
        'db_name': 'Premier League',
        'country': 'England',
    },
    'laliga': {
        'url_slug': 'spanish-la-liga',
        'db_name': 'La Liga',
        'country': 'Spain',
    },
    'bundesliga': {
        'url_slug': 'german-bundesliga',
        'db_name': '1. Bundesliga',
        'country': 'Germany',
    },
    'seriea': {
        'url_slug': 'italian-serie-a',
        'db_name': 'Serie A',
        'country': 'Italy',
    },
    'ligue1': {
        'url_slug': 'french-ligue-1',
        'db_name': 'Ligue 1',
        'country': 'France',
    },
}

# Seasons with full shot data (HS/AS/HST/AST). Earlier seasons omit these cols.
# 0506 = 2005/06 … 2425 = 2024/25
ALL_SEASONS = [
    '0506','0607','0708','0809','0910',
    '1011','1112','1213','1314','1415',
    '1516','1617','1718','1819','1920',
    '2021','2122','2223','2324','2425',
]

# ── Team name normalisation ────────────────────────────────────────────────────
# datahub.io uses abbreviated names for some clubs. Map to canonical long names
# so rolling stats accumulate correctly across seasons.

TEAM_ALIASES = {
    # EPL
    'Man City':    'Manchester City',
    'Man United':  'Manchester United',
    'Newcastle':   'Newcastle United',
    'Nott\'m Forest': 'Nottingham Forest',
    'Wolves':      'Wolverhampton Wanderers',
    'QPR':         'Queens Park Rangers',
    'West Brom':   'West Bromwich Albion',
    'Birmingham':  'Birmingham City',
    'Blackburn':   'Blackburn Rovers',
    'Bolton':      'Bolton Wanderers',
    'Bradford':    'Bradford City',
    'Charlton':    'Charlton Athletic',
    'Coventry':    'Coventry City',
    'Derby':       'Derby County',
    'Ipswich':     'Ipswich Town',
    'Leeds':       'Leeds United',
    'Leicester':   'Leicester City',
    'Norwich':     'Norwich City',
    'Oldham':      'Oldham Athletic',
    'Sheffield Weds': 'Sheffield Wednesday',
    'Sheff Weds':  'Sheffield Wednesday',
    'Sheff Utd':   'Sheffield United',
    'Stoke':       'Stoke City',
    'Sunderland':  'Sunderland',
    'Swansea':     'Swansea City',
    'Tottenham':   'Tottenham Hotspur',
    'Spurs':       'Tottenham Hotspur',
    'Wigan':       'Wigan Athletic',
    # La Liga
    'Ath Bilbao':  'Athletic Bilbao',
    'Ath Madrid':  'Atletico Madrid',
    'Atletico':    'Atletico Madrid',
    'Dep La Coruna': 'Deportivo La Coruna',
    'Sociedad':    'Real Sociedad',
    'Vallecano':   'Rayo Vallecano',
    'Sp Gijon':    'Sporting Gijon',
    'Malaga':      'Málaga',
    'Leganes':     'Leganés',
    'Alaves':      'Deportivo Alavés',
    # Bundesliga
    'Bayer Leverkusen': 'Bayer Leverkusen',
    'Bayern Munich': 'Bayern Munich',
    'Dortmund':    'Borussia Dortmund',
    'Hertha':      'Hertha Berlin',
    'Greuther Furth': 'SpVgg Greuther Fürth',
    # Serie A
    'Inter':       'Inter Milan',
    'Milan':       'AC Milan',
    'Verona':      'Hellas Verona',
    'Lazio':       'Lazio',
    # Ligue 1
    'Paris SG':    'Paris Saint-Germain',
    'PSG':         'Paris Saint-Germain',
    'St Etienne':  "Saint-Étienne",
    'Nantes':      'Nantes',
}

def normalise_team(name: str) -> str:
    name = name.strip()
    return TEAM_ALIASES.get(name, name)

# ── HTTP helpers ───────────────────────────────────────────────────────────────

SESSION = requests.Session()
SESSION.headers.update({'User-Agent': 'MaxEdge-DataSeeder/1.0'})

def fetch_csv(league_slug: str, season: str) -> Optional[pd.DataFrame]:
    """Download a season CSV from datahub.io. Returns None if not found."""
    url = f'https://datahub.io/football/{league_slug}/_r/-/season-{season}.csv'
    try:
        resp = SESSION.get(url, timeout=30, allow_redirects=True)
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        df = pd.read_csv(io.StringIO(resp.text))
        return df if not df.empty else None
    except Exception as e:
        print(f'    WARNING: failed to fetch {url}: {e}')
        return None

# ── DB helpers ─────────────────────────────────────────────────────────────────

def upsert_league(client, name, country):
    # type: (object, str, str) -> str
    """Ensure league exists; return its UUID."""
    resp = client.table('leagues').select('id').eq('name', name).execute()
    rows = resp.data or []
    if rows:
        return rows[0]['id']
    new_id = str(uuid.uuid4())
    client.table('leagues').insert({'id': new_id, 'name': name, 'country': country}).execute()
    print(f'  Created league: {name}')
    return new_id

def upsert_teams_bulk(client, names):
    # type: (object, List[str]) -> Dict[str, str]
    """Ensure all team names exist; return {name: uuid} mapping."""
    existing = client.table('teams').select('id,name').execute().data or []
    name_to_id = {r['name']: r['id'] for r in existing}
    to_create = [n for n in names if n not in name_to_id]
    if to_create:
        rows = [{'id': str(uuid.uuid4()), 'name': n} for n in to_create]
        # Batch inserts to avoid request size limits
        for i in range(0, len(rows), BATCH_SIZE):
            client.table('teams').insert(rows[i:i+BATCH_SIZE]).execute()
        for r in rows:
            name_to_id[r['name']] = r['id']
        print(f'  Created {len(to_create)} new teams')
    return name_to_id

def existing_datahub_ids(client):
    """Return (fixture_prediction_ids, match_external_ids) already imported from datahub."""
    # Only check rows we inserted — all datahub rows use 'datahub_' prefix.
    # Supabase v0.7 doesn't expose .like() cleanly, so we use raw SQL via rpc
    # or just fetch all from fixture_predictions where model_architecture matches.
    fp_resp = (client.table('fixture_predictions')
               .select('fixture_id')
               .eq('model_architecture', 'DATAHUB_CSV')
               .execute())
    fp_ids = {r['fixture_id'] for r in (fp_resp.data or [])}

    m_resp = (client.table('matches')
              .select('external_id')
              .eq('stats_source', 'datahub_csv')
              .execute())
    m_ids = {r['external_id'] for r in (m_resp.data or []) if r.get('external_id')}

    return fp_ids, m_ids

def slugify(s: str) -> str:
    return re.sub(r'[^a-z0-9]+', '_', s.lower()).strip('_')

# ── Row processing ─────────────────────────────────────────────────────────────

def parse_date(date_str):
    # type: (str) -> Optional[str]
    """Parse datahub.io date formats: YYYY-MM-DD or DD/MM/YY."""
    for fmt in ('%Y-%m-%d', '%d/%m/%y', '%d/%m/%Y'):
        try:
            dt = datetime.strptime(date_str.strip(), fmt)
            return dt.replace(hour=12, tzinfo=timezone.utc).isoformat()
        except ValueError:
            continue
    return None

def ftr_to_result(ftr):
    # type: (str) -> Optional[str]
    return {'H': 'home', 'D': 'draw', 'A': 'away'}.get(str(ftr).strip().upper())

def safe_int(val, default=None):
    try:
        return int(val)
    except (ValueError, TypeError):
        return default

def safe_float(val, default=None):
    try:
        return float(val)
    except (ValueError, TypeError):
        return default

def build_rows(df, league_key, season, league_id, team_to_id):
    # type: (pd.DataFrame, str, str, str, dict) -> Tuple[list, list]
    """
    Convert one season's CSV DataFrame into (fp_rows, match_rows).
    Returns only rows that pass basic validation.
    """
    fp_rows    = []
    match_rows = []

    required_cols = {'Date', 'HomeTeam', 'AwayTeam', 'FTHG', 'FTAG', 'FTR'}
    if not required_cols.issubset(df.columns):
        return fp_rows, match_rows

    has_shots = {'HS', 'AS', 'HST', 'AST'}.issubset(df.columns)

    for _, row in df.iterrows():
        home_raw = str(row.get('HomeTeam', '')).strip()
        away_raw = str(row.get('AwayTeam', '')).strip()
        if not home_raw or not away_raw:
            continue

        home = normalise_team(home_raw)
        away = normalise_team(away_raw)

        date_str = str(row.get('Date', '')).strip()
        kickoff  = parse_date(date_str)
        if not kickoff:
            continue

        fthg = safe_int(row.get('FTHG'))
        ftag = safe_int(row.get('FTAG'))
        result = ftr_to_result(row.get('FTR'))
        if fthg is None or ftag is None or result is None:
            continue

        # Shots — only available from 2005/06
        hs  = safe_int(row.get('HS'))
        as_ = safe_int(row.get('AS'))
        hst = safe_int(row.get('HST'))
        ast = safe_int(row.get('AST'))

        xg_home    = round(hst * XG_CONVERSION, 3) if hst is not None else None
        xg_away    = round(ast * XG_CONVERSION, 3) if ast is not None else None
        # ppda: home team's index (higher = pressing less); baseline when unavailable
        ppda_home  = PPDA_BASELINE

        fixture_id = f'datahub_{league_key}_{season}_{slugify(date_str)}_{slugify(home)}_{slugify(away)}'

        # fixture_predictions row (home team's perspective)
        fp_rows.append({
            'fixture_id':           fixture_id,
            'match_kickoff_at':     kickoff,
            'home_team_name':       home,
            'away_team_name':       away,
            'home_goals_scored':    fthg,
            'away_goals_scored':    ftag,
            'xg_created':           xg_home,
            'xg_conceded':          xg_away,
            'ppda_intensity_index': ppda_home,
            'model_architecture':   'DATAHUB_CSV',
            'feature_completeness': False,
        })

        # matches row
        home_id = team_to_id.get(home)
        away_id = team_to_id.get(away)
        if not home_id or not away_id:
            continue

        match_rows.append({
            'id':                      str(uuid.uuid4()),
            'external_id':             fixture_id,
            'home_team_id':            home_id,
            'away_team_id':            away_id,
            'league_id':               league_id,
            'kickoff_at':              kickoff,
            'status':                  'completed',
            'is_bet_of_day':           False,
            'goals_home':              fthg,
            'goals_away':              ftag,
            'shots_home':              hs,
            'shots_away':              as_,
            'shots_on_target_home':    hst,
            'shots_on_target_away':    ast,
            'xg_home':                 xg_home,
            'xg_away':                 xg_away,
            'result':                  result,
            'stats_source':            'datahub_csv',
        })

    return fp_rows, match_rows

# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Seed datahub.io top-5 league data into MaxEdge DB')
    parser.add_argument('--leagues', default='epl,laliga,bundesliga,seriea,ligue1',
                        help='Comma-separated league keys (default: all 5)')
    parser.add_argument('--from-season', default='0506',
                        help='Start season code, e.g. 1617 (default: 0506)')
    parser.add_argument('--dry-run', action='store_true',
                        help='Download and parse CSVs only — do not write to DB')
    args = parser.parse_args()

    selected_leagues = [k.strip() for k in args.leagues.split(',') if k.strip() in LEAGUES]
    if not selected_leagues:
        sys.exit(f'ERROR: no valid leagues in --leagues. Choose from: {", ".join(LEAGUES)}')

    from_idx = ALL_SEASONS.index(args.from_season) if args.from_season in ALL_SEASONS else 0
    seasons  = ALL_SEASONS[from_idx:]

    print(f'Leagues: {", ".join(selected_leagues)}')
    print(f'Seasons: {seasons[0]} → {seasons[-1]}  ({len(seasons)} seasons)')
    print(f'Dry run: {args.dry_run}')
    print()

    client = create_client(SUPABASE_URL, SUPABASE_KEY)

    # ── Pre-load existing datahub IDs to skip on re-runs ──────────────────────
    print('Loading existing datahub fixture IDs from DB...')
    seen_fixture_ids, seen_external_ids = existing_datahub_ids(client)
    print(f'  fixture_predictions (datahub): {len(seen_fixture_ids)} existing rows')
    print(f'  matches (datahub):             {len(seen_external_ids)} existing rows')
    print()

    # ── Discover all team names across all CSVs first ──────────────────────────
    print('Scanning CSVs to collect all team names...')
    all_team_names = set()
    csv_cache = {}   # (league_key, season) → DataFrame | None

    for league_key in selected_leagues:
        slug = LEAGUES[league_key]['url_slug']
        for season in seasons:
            df = fetch_csv(slug, season)
            csv_cache[(league_key, season)] = df
            if df is not None and {'HomeTeam', 'AwayTeam'}.issubset(df.columns):
                for col in ('HomeTeam', 'AwayTeam'):
                    for name in df[col].dropna().unique():
                        all_team_names.add(normalise_team(str(name).strip()))
            time.sleep(0.05)   # polite rate limit

    print(f'  Found {len(all_team_names)} unique teams across all CSVs')

    if args.dry_run:
        print('\nDry run — not writing to DB.')
        return

    # ── Ensure leagues and teams exist in DB ───────────────────────────────────
    print('\nEnsuring leagues exist in DB...')
    league_ids = {}
    for key in selected_leagues:
        cfg = LEAGUES[key]
        league_ids[key] = upsert_league(client, cfg['db_name'], cfg['country'])

    print('Ensuring teams exist in DB...')
    team_to_id = upsert_teams_bulk(client, sorted(all_team_names))

    # ── Insert rows ────────────────────────────────────────────────────────────
    total_fp    = 0
    total_match = 0
    skipped     = 0

    for league_key in selected_leagues:
        league_id = league_ids[league_key]
        print(f'\n[{LEAGUES[league_key]["db_name"]}]')

        for season in seasons:
            df = csv_cache.get((league_key, season))
            if df is None:
                continue

            fp_rows, match_rows = build_rows(df, league_key, season, league_id, team_to_id)

            # Filter out already-imported rows
            new_fp    = [r for r in fp_rows    if r['fixture_id']  not in seen_fixture_ids]
            new_match = [r for r in match_rows if r['external_id'] not in seen_external_ids]

            skipped += len(fp_rows) - len(new_fp)

            if not new_fp and not new_match:
                continue

            # Insert fixture_predictions (pre-filtered, so no conflict expected)
            for i in range(0, len(new_fp), BATCH_SIZE):
                client.table('fixture_predictions').insert(
                    new_fp[i:i+BATCH_SIZE]
                ).execute()
                for r in new_fp[i:i+BATCH_SIZE]:
                    seen_fixture_ids.add(r['fixture_id'])

            # Insert matches (no upsert — external_id is nullable so no unique constraint)
            for i in range(0, len(new_match), BATCH_SIZE):
                client.table('matches').insert(new_match[i:i+BATCH_SIZE]).execute()
                for r in new_match[i:i+BATCH_SIZE]:
                    seen_external_ids.add(r['external_id'])

            total_fp    += len(new_fp)
            total_match += len(new_match)
            print(f'  {season}: +{len(new_fp)} fp rows, +{len(new_match)} match rows')

    print(f'\n✓ Done.')
    print(f'  fixture_predictions inserted: {total_fp}')
    print(f'  matches inserted:             {total_match}')
    print(f'  rows skipped (already exist): {skipped}')
    print()
    print('Next steps:')
    print('  1. python3 ensemble/seed_team_stats.py   # recompute rolling stats')
    print('  2. python3 ensemble/train.py              # retrain on full dataset')


if __name__ == '__main__':
    main()
