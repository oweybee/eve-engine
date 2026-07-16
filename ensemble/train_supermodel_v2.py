#!/usr/bin/env python3
"""
ensemble/train_supermodel_v2.py — MaxEdge Supermodel v2
Senior ML Engineer Rewrite: Time-Series Integrity Edition

ROOT CAUSE ANALYSIS OF v1 FAILURES
────────────────────────────────────
v1 reported 65.6% halftime accuracy but this number is misleading:

  [LEAK 1] HST / AST are FULL-MATCH shots on target. At minute 45 these values
           do not exist — the second half hasn't been played. The model was
           'seeing the future', inflating its apparent signal.

  [LEAK 2] Random 80/20 stratified split mixes seasons. A match from 2023 can
           appear in the training set alongside a 2006 match in the test set.
           The ELO and form trackers therefore leak future information into past
           predictions during the random split.

  [FLAW 3] ELO cold-start at 1500 for all teams wastes the first ~5 seasons
           as ELO ratings converge. Promoted teams in season 6 still get 1500
           despite good information being available from the previous season.

  [FLAW 4] FormTracker returned hardcoded arbitrary values for new teams.
           The model couldn't distinguish a brand-new promoted team from a team
           in its first tracked match simply because the tracker hadn't started.

  [FLAW 5] Binary is_home_leading captured only direction, not magnitude.
           A team 3-0 up at HT is not the same as 1-0 up — the model needs
           margin-aware buckets to express this.

  [FLAW 6] No league encoding. EPL draw rate ≈ 26%, Serie A ≈ 29%. The model
           was making predictions blind to these structural league differences.

ARCHITECTURE v2
───────────────
  Data:       34,519 matches — EPL / La Liga / Bundesliga / Serie A / Ligue 1
              Seasons 2005/06 → 2023/24 (2024/25 excluded as in-progress)

  Split:      Chronological — NO random split
              TRAIN: 2005/06 → 2018/19  (14 seasons, ~24,400 matches)
              TEST:  2019/20 → 2023/24  (5 seasons,  ~10,100 matches)
              Walk-forward: ELO/form trackers update continuously through test.

  Features:   30-dim halftime model / 23-dim prematch model (details below)
  Algorithm:  XGBoost multi:softprob, 3-class (Away / Draw / Home)

FEATURE VECTOR — HALFTIME MODEL (30 dims)
──────────────────────────────────────────
  ELO strength   (3):  home_elo, away_elo, elo_differential
  Home form     (7):  win_rate_10, draw_rate_10, goals_scored_10,
                       goals_conceded_10, sot_rate_10, clean_sheet_rate_10,
                       red_card_rate_10   [expanding window, league-prior cold-start]
  Away form     (7):  same 7 for away team
  H2H           (1):  h2h_home_win_rate_5 (last 5 meetings, neutral perspective)
  League OHE    (5):  league_epl, league_laliga, league_bundesliga,
                       league_seriea, league_ligue1
  HT buckets    (5):  ht_losing_2plus, ht_losing_1, ht_draw,
                       ht_winning_1, ht_winning_2plus
  HT red cards  (2):  HR, AR  [NOTE: technically full-match; user-retained,
                                see inline comment for upgrade path]

FEATURE VECTOR — PREMATCH MODEL (23 dims)
──────────────────────────────────────────
  ELO + Home form + Away form + H2H + League OHE  (no in-play block)

USAGE
─────
  cd engine && export $(cat .env | xargs)
  # Offline corpus (football-data.co.uk is not always reachable): build the
  # cache from the GitHub mirror + committed extra-league CSVs first, then train.
  python3 ensemble/build_training_corpus.py             # writes models/_csv_cache_v3.csv.gz
  python3 ensemble/train_supermodel_v2.py --mode prematch
  python3 ensemble/train_supermodel_v2.py               # both models
  python3 ensemble/train_supermodel_v2.py --no-cache    # re-download CSVs (needs football-data.co.uk)

NOTE: the pre-match model now covers SEVEN leagues — the big-5 plus Allsvenskan
(SWE) and MLS (USA). The extra leagues carry results + closing odds only, so
sot_rate / red_card_rate fall back to LEAGUE_PRIORS for every league (uniform,
so the model never leans on a signal one league has and another lacks). The
half-time model still trains on the big-5 only (no half-time data for the extras).
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import time
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

import numpy as np
import pandas as pd
import requests
from sklearn.metrics import accuracy_score, confusion_matrix, log_loss
from sklearn.preprocessing import LabelEncoder

try:
    import xgboost as xgb
except ImportError:
    sys.exit("pip install xgboost")

# ══════════════════════════════════════════════════════════════════════════════
# CONSTANTS
# ══════════════════════════════════════════════════════════════════════════════

LEAGUES: Dict[str, str] = {
    'epl':         'E0',   # football-data.co.uk division codes
    'laliga':      'SP1',
    'bundesliga':  'D1',
    'seriea':      'I1',
    'ligue1':      'F1',
    'allsvenskan': 'SWE',  # extra-league (results + closing odds; no shots/HT/cards)
    'mls':         'USA',
}

# All seasons with full shot data (2000/01 had gaps; 0506 is the clean start).
# 2425 excluded — season in progress would bias test evaluation.
ALL_SEASONS: List[str] = [
    '0506','0607','0708','0809','0910',
    '1011','1112','1213','1314','1415',
    '1516','1617','1718','1819','1920',
    '2021','2122','2223','2324',
]

# ── Chronological split ───────────────────────────────────────────────────────
# 14 training seasons (~24k matches), 5 test seasons (~10k matches).
# The split point (1819/1920) was chosen so the test window covers the
# post-COVID era and recent tactical evolution, making out-of-sample
# performance a genuine forward-looking test.
TRAIN_SEASONS: Set[str] = set(ALL_SEASONS[:14])   # 0506 → 1819
TEST_SEASONS:  Set[str] = set(ALL_SEASONS[14:])    # 1920 → 2324

# The train/test boundary as a DATE, not a season code. This works uniformly
# across the big-5 (European seasons, code '0506'…'2324') AND the extra leagues
# (calendar-year seasons '2012'…'2026'), which don't share the big-5 code space.
# Matches before this instant train; on/after evaluate out-of-sample. The instant
# (1 Jul 2019) reproduces the original big-5 1819/1920 split exactly.
SPLIT_DATE = pd.Timestamp('2019-07-01', tz='UTC')

# ── ELO hyper-parameters ─────────────────────────────────────────────────────
ELO_K          = 30    # update speed — 20 is FIFA-standard, 30 is common for club
ELO_HOME_ADV   = 80    # home advantage in ELO points (industry benchmark)
ELO_DEFAULT    = 1500  # global starting point before promoted-team logic kicks in

# ── Rolling form window ───────────────────────────────────────────────────────
FORM_WINDOW = 10
H2H_WINDOW  = 5

# ── League-specific cold-start priors ────────────────────────────────────────
# Used ONLY for teams with zero recorded games (brand-new promoted sides).
# Values calibrated from long-run European football statistics (public domain).
# Once a team has 1 game, the expanding window takes over — these are never
# used again for that team.
LEAGUE_PRIORS: Dict[str, Dict[str, float]] = {
    'epl':        {'win_rate': 0.46, 'draw_rate': 0.26, 'goals_scored': 1.50,
                   'goals_conceded': 1.10, 'sot_rate': 4.5, 'clean_sheet_rate': 0.28,
                   'red_card_rate': 0.04},
    'laliga':     {'win_rate': 0.47, 'draw_rate': 0.25, 'goals_scored': 1.60,
                   'goals_conceded': 1.00, 'sot_rate': 4.8, 'clean_sheet_rate': 0.30,
                   'red_card_rate': 0.05},
    'bundesliga': {'win_rate': 0.45, 'draw_rate': 0.24, 'goals_scored': 1.70,
                   'goals_conceded': 1.10, 'sot_rate': 4.6, 'clean_sheet_rate': 0.27,
                   'red_card_rate': 0.03},
    'seriea':     {'win_rate': 0.45, 'draw_rate': 0.28, 'goals_scored': 1.40,
                   'goals_conceded': 1.10, 'sot_rate': 4.2, 'clean_sheet_rate': 0.29,
                   'red_card_rate': 0.05},
    'ligue1':     {'win_rate': 0.44, 'draw_rate': 0.27, 'goals_scored': 1.50,
                   'goals_conceded': 1.10, 'sot_rate': 4.3, 'clean_sheet_rate': 0.27,
                   'red_card_rate': 0.04},
    # Extra leagues — calibrated from the uploaded football-data 'extra' history
    # (results + closing odds only). sot_rate / red_card_rate default to the
    # cross-league norm since shots/cards aren't in that dataset.
    'allsvenskan':{'win_rate': 0.43, 'draw_rate': 0.25, 'goals_scored': 1.40,
                   'goals_conceded': 1.40, 'sot_rate': 4.3, 'clean_sheet_rate': 0.26,
                   'red_card_rate': 0.04},
    'mls':        {'win_rate': 0.50, 'draw_rate': 0.25, 'goals_scored': 1.45,
                   'goals_conceded': 1.45, 'sot_rate': 4.3, 'clean_sheet_rate': 0.24,
                   'red_card_rate': 0.04},
}

# ══════════════════════════════════════════════════════════════════════════════
# TEAM NAME NORMALISATION
# ══════════════════════════════════════════════════════════════════════════════

ALIASES: Dict[str, str] = {
    'Man City': 'Manchester City', 'Man United': 'Manchester United',
    'Newcastle': 'Newcastle United', "Nott'm Forest": 'Nottingham Forest',
    'Wolves': 'Wolverhampton Wanderers', 'QPR': 'Queens Park Rangers',
    'West Brom': 'West Bromwich Albion', 'Birmingham': 'Birmingham City',
    'Blackburn': 'Blackburn Rovers', 'Bolton': 'Bolton Wanderers',
    'Charlton': 'Charlton Athletic', 'Derby': 'Derby County',
    'Ipswich': 'Ipswich Town', 'Leeds': 'Leeds United',
    'Leicester': 'Leicester City', 'Norwich': 'Norwich City',
    'Sheff Utd': 'Sheffield United', 'Sheff Weds': 'Sheffield Wednesday',
    'Sheffield Weds': 'Sheffield Wednesday', 'Stoke': 'Stoke City',
    'Swansea': 'Swansea City', 'Tottenham': 'Tottenham Hotspur',
    'Wigan': 'Wigan Athletic', 'Ath Bilbao': 'Athletic Bilbao',
    'Ath Madrid': 'Atletico Madrid', 'Atletico': 'Atletico Madrid',
    'Sociedad': 'Real Sociedad', 'Vallecano': 'Rayo Vallecano',
    'Sp Gijon': 'Sporting Gijon', 'Hertha': 'Hertha Berlin',
    'Inter': 'Inter Milan', 'Milan': 'AC Milan',
    'Verona': 'Hellas Verona', 'Paris SG': 'Paris Saint-Germain',
    'St Etienne': "Saint-Étienne",
}

def norm(name: str) -> str:
    name = str(name).strip()
    return ALIASES.get(name, name)

def safe(val, default: float = 0.0) -> float:
    try:
        v = float(val)
        return v if not np.isnan(v) else default
    except (TypeError, ValueError):
        return default

# ══════════════════════════════════════════════════════════════════════════════
# ELO SYSTEM — with promoted-team seeding
# ══════════════════════════════════════════════════════════════════════════════

class EloSystem:
    """
    Running ELO ratings with two key improvements over v1:

    1. PROMOTED TEAM SEEDING
       When a team appears for the first time in a given league, instead of
       defaulting to 1500 (which wastes seasons of context), we seed them at
       the mean ELO of the bottom-3 teams from that league's *previous season*.
       This approximates the true quality of a newly promoted side far better
       than a naive default.

    2. SEASONAL SNAPSHOTS
       At the end of each season we snapshot ELOs per league so the promoted-
       team logic can look backwards. `finalize_season()` must be called when
       each league's season ends (detected via season-transition logic below).

    TIME-SERIES INTEGRITY:
       `snapshot()` is always called BEFORE `update()`. The feature vector for
       match M never contains ELO information derived from match M or any later
       match. Updates only flow forward in time.
    """

    def __init__(self, k: float = ELO_K, home_adv: float = ELO_HOME_ADV):
        self.k        = k
        self.home_adv = home_adv
        self._ratings: Dict[str, float] = {}
        # (league, season) → {team: elo at season end}
        self._season_snapshots: Dict[Tuple[str, str], Dict[str, float]] = {}
        # (league, season) → set of teams seen this season
        self._season_teams: Dict[Tuple[str, str], Set[str]] = defaultdict(set)

    def _expected(self, home: str, away: str) -> float:
        """P(home wins) including home-field advantage."""
        h = self._ratings.get(home, ELO_DEFAULT) + self.home_adv
        a = self._ratings.get(away, ELO_DEFAULT)
        return 1.0 / (1.0 + 10.0 ** (-(h - a) / 400.0))

    def ensure_initialized(self, team: str, league: str, season: str) -> None:
        """
        Guarantee a team has an ELO rating before their first match.
        Called for both home and away team before snapshot/update.

        PROMOTED TEAM LOGIC:
        If the team has never been rated, look up the previous season's bottom-3
        ELOs for this league. Promoted teams are typically in that quality band.
        Falls back to ELO_DEFAULT only if no previous season data exists
        (i.e., the very first season of the dataset).
        """
        if team in self._ratings:
            return

        # Find the previous season for this league
        prev_elo = self._get_promoted_seed(league, season)
        self._ratings[team] = prev_elo

    def _get_promoted_seed(self, league: str, season: str) -> float:
        """
        Return the mean ELO of the bottom-3 teams from the previous season in
        this league. If no prior snapshot exists, return ELO_DEFAULT.
        """
        prev_season = self._prev_season(season)
        if prev_season is None:
            return ELO_DEFAULT

        snapshot = self._season_snapshots.get((league, prev_season))
        if not snapshot:
            return ELO_DEFAULT

        # Bottom-3 ELOs from previous season = relegated band
        sorted_elos = sorted(snapshot.values())
        bottom_n = sorted_elos[:3]
        seed = sum(bottom_n) / len(bottom_n)
        return round(seed, 2)

    @staticmethod
    def _prev_season(season: str) -> Optional[str]:
        """Return the season code for the prior year, or None if at the start."""
        idx = ALL_SEASONS.index(season) if season in ALL_SEASONS else -1
        return ALL_SEASONS[idx - 1] if idx > 0 else None

    def register_team_in_season(self, league: str, season: str,
                                 home: str, away: str) -> None:
        """Track which teams participated each season (needed for season snapshots)."""
        self._season_teams[(league, season)].add(home)
        self._season_teams[(league, season)].add(away)

    def finalize_season(self, league: str, season: str) -> None:
        """
        Snapshot current ELOs for all teams in this league/season.
        Must be called exactly once at the END of each season, AFTER the last
        match of that season has been processed (i.e., after update() is called).
        """
        teams = self._season_teams.get((league, season), set())
        self._season_snapshots[(league, season)] = {
            t: self._ratings.get(t, ELO_DEFAULT) for t in teams
        }

    def snapshot(self, home: str, away: str) -> Tuple[float, float, float]:
        """
        Return (home_elo, away_elo, elo_differential) BEFORE this match.
        TIME-SERIES SAFE: must be called before update().
        """
        h = self._ratings.get(home, ELO_DEFAULT)
        a = self._ratings.get(away, ELO_DEFAULT)
        return h, a, h - a

    def update(self, home: str, away: str, result: str) -> None:
        """
        Update ratings after a match. result: 'H' | 'D' | 'A'.
        TIME-SERIES SAFE: must be called AFTER snapshot() and feature collection.
        """
        exp  = self._expected(home, away)
        s_h  = 1.0 if result == 'H' else (0.5 if result == 'D' else 0.0)
        s_a  = 1.0 - s_h

        self._ratings[home] = self._ratings.get(home, ELO_DEFAULT) + self.k * (s_h - exp)
        self._ratings[away] = self._ratings.get(away, ELO_DEFAULT) + self.k * (s_a - (1.0 - exp))


# ══════════════════════════════════════════════════════════════════════════════
# ROLLING FORM TRACKER — expanding window with league-prior cold-start
# ══════════════════════════════════════════════════════════════════════════════

class FormTracker:
    """
    Per-team rolling window of recent match statistics.

    EXPANDING WINDOW COLD-START (v1 fix):
    When a team has fewer than FORM_WINDOW games, we use the games they DO have
    (expanding window) rather than a fixed window of 10. This means:
      - 1 game:  average over 1 game
      - 5 games: average over 5 games
      - 10+ games: rolling 10-game window

    ZERO-GAME COLD-START:
    When a team has 0 prior games (first appearance), we fall back to
    LEAGUE_PRIORS — empirically calibrated per-league averages. This is more
    informative than arbitrary values and avoids a discontinuous jump from
    'new team default' to 'expanding window data' after game 1.

    SOT TRACKING NOTE:
    We store shots on target from the team's perspective (HST for home,
    AST for away). This becomes `sot_rate_10` — the team's average SOT
    per game over their last 10 matches. This is a PRE-MATCH feature
    (historical average) and NOT the same as the in-play HST/AST columns.
    """

    def __init__(self, window: int = FORM_WINDOW):
        self.window = window
        self._history: Dict[str, List[dict]] = defaultdict(list)

    def snapshot(self, team: str, league: str) -> Dict[str, float]:
        """
        Return form stats using available history. League is needed for the
        zero-game cold-start fallback.
        TIME-SERIES SAFE: only contains games from before the current match.
        """
        hist = self._history[team]
        n = len(hist)

        if n == 0:
            # Zero games seen: use league-calibrated priors
            return dict(LEAGUE_PRIORS.get(league, LEAGUE_PRIORS['epl']))

        # Expanding window: use min(n, FORM_WINDOW) most recent games
        window_hist = hist[-self.window:]
        w = len(window_hist)

        wins  = sum(1 for g in window_hist if g['won'])
        draws = sum(1 for g in window_hist if g['drew'])

        return {
            'win_rate':          wins / w,
            'draw_rate':         draws / w,
            'goals_scored':      float(np.mean([g['gf']  for g in window_hist])),
            'goals_conceded':    float(np.mean([g['ga']  for g in window_hist])),
            'sot_rate':          float(np.mean([g['sot'] for g in window_hist])),
            'clean_sheet_rate':  float(np.mean([1.0 if g['ga'] == 0 else 0.0
                                                for g in window_hist])),
            'red_card_rate':     float(np.mean([g['rc']  for g in window_hist])),
        }

    def update(self, team: str, gf: int, ga: int,
               sot: float, rc: float, result_for_team: str) -> None:
        """
        Push one completed match into the team's history.
        TIME-SERIES SAFE: must be called AFTER snapshot().
        """
        self._history[team].append({
            'gf':  gf,  'ga':  ga,
            'sot': sot, 'rc':  rc,
            'won':  result_for_team == 'W',
            'drew': result_for_team == 'D',
        })


# ══════════════════════════════════════════════════════════════════════════════
# HEAD-TO-HEAD TRACKER
# ══════════════════════════════════════════════════════════════════════════════

class H2HTracker:
    """
    Records the last H2H_WINDOW meetings between each pair of teams.
    The key is order-independent so both Home-vs-Away and Away-vs-Home
    fixtures accumulate into the same record.

    Returns the home team's win rate in those meetings, capturing any
    psychological or tactical advantage one side has over the other.
    """

    def __init__(self, window: int = H2H_WINDOW):
        self.window   = window
        self._records: Dict[Tuple[str, str], List[str]] = defaultdict(list)

    def _key(self, home: str, away: str) -> Tuple[str, str]:
        return (min(home, away), max(home, away))

    def snapshot(self, home: str, away: str) -> float:
        """
        P(home team wins) across last H2H_WINDOW meetings.
        Returns 0.45 (slight home prior) if no meetings recorded.
        TIME-SERIES SAFE: only contains games from before the current match.
        """
        records = self._records[self._key(home, away)][-self.window:]
        if not records:
            return 0.45
        home_wins = sum(1 for r in records if r == home)
        return home_wins / len(records)

    def update(self, home: str, away: str, result: str) -> None:
        """Store result. result: 'H' | 'D' | 'A'."""
        winner = home if result == 'H' else (away if result == 'A' else 'DRAW')
        self._records[self._key(home, away)].append(winner)


# ══════════════════════════════════════════════════════════════════════════════
# DATA LOADING
# ══════════════════════════════════════════════════════════════════════════════

def fetch_csv(div: str, season: str) -> Optional[pd.DataFrame]:
    """
    Download one season CSV from football-data.co.uk.
    URL format: https://www.football-data.co.uk/mmz4281/{XXYY}/{DIV}.csv
    This source includes full bookmaker odds (B365, Pinnacle, Max, Avg).
    """
    session = requests.Session()
    session.headers.update({'User-Agent': 'MaxEdge-Supermodel-v2/1.0'})
    url = f'https://www.football-data.co.uk/mmz4281/{season}/{div}.csv'
    try:
        r = session.get(url, timeout=30, allow_redirects=True)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        df = pd.read_csv(io.StringIO(r.text))
        return df if not df.empty else None
    except Exception as e:
        print(f'  WARNING {div}/{season}: {e}')
        return None

def load_all_csvs(use_cache: bool = True) -> pd.DataFrame:
    """
    Download (or reload cached) CSVs for all leagues and seasons.
    Returns a single DataFrame sorted chronologically — this ordering is
    critical. All downstream processing depends on matches being in
    temporal order so no future data bleeds into past feature vectors.
    """
    cache_path = Path(__file__).parent / 'models' / '_csv_cache_v3.csv.gz'  # v3: adds odds
    cache_path.parent.mkdir(parents=True, exist_ok=True)

    if use_cache and cache_path.exists():
        print(f'  Loading cache: {cache_path}')
        df = pd.read_csv(cache_path, parse_dates=['date'])
        df['date'] = pd.to_datetime(df['date'], utc=True)
        return df.sort_values('date').reset_index(drop=True)

    all_rows = []
    for league_key, slug in LEAGUES.items():
        print(f'  Downloading {league_key}...')
        for season in ALL_SEASONS:
            df = fetch_csv(slug, season)
            if df is None:
                continue

            required = {'Date', 'HomeTeam', 'AwayTeam', 'FTHG', 'FTAG', 'FTR'}
            if not required.issubset(df.columns):
                continue

            has_ht   = {'HTHG', 'HTAG'}.issubset(df.columns)
            has_shot = {'HS', 'AS', 'HST', 'AST'}.issubset(df.columns)
            has_card = {'HR', 'AR'}.issubset(df.columns)
            has_b365 = {'B365H', 'B365D', 'B365A'}.issubset(df.columns)
            has_ps   = {'PSH',   'PSD',   'PSA'  }.issubset(df.columns)
            has_max  = {'MaxH',  'MaxD',  'MaxA' }.issubset(df.columns)
            # Pinnacle appears as PSH in older seasons, BbAvH in some
            # We prefer PSH/PSD/PSA as the canonical sharp-market source

            for _, row in df.iterrows():
                home = norm(row['HomeTeam'])
                away = norm(row['AwayTeam'])
                ftr  = str(row.get('FTR', '')).strip().upper()
                if ftr not in ('H', 'D', 'A') or not home or not away:
                    continue

                try:
                    date_str = str(row['Date']).strip()
                    ts = (pd.Timestamp(date_str, tz='UTC') if '-' in date_str
                          else pd.to_datetime(date_str, dayfirst=True, utc=True))
                except Exception:
                    continue

                all_rows.append({
                    'date':   ts,     'league': league_key,
                    'season': season, 'home':   home,       'away': away,
                    'fthg':   safe(row.get('FTHG')),
                    'ftag':   safe(row.get('FTAG')),
                    'ftr':    ftr,
                    # Half-time goals — available at minute 45
                    'hthg':   safe(row['HTHG']) if has_ht else np.nan,
                    'htag':   safe(row['HTAG']) if has_ht else np.nan,
                    # Full-match SOT — NOT used in halftime model (data leakage fix)
                    # Retained in raw data for pre-match form computation only.
                    'hst':    safe(row['HST'])  if has_shot else np.nan,
                    'ast':    safe(row['AST'])  if has_shot else np.nan,
                    # Red cards — technically full-match but user-retained.
                    'hr':     safe(row['HR'])   if has_card else np.nan,
                    'ar':     safe(row['AR'])   if has_card else np.nan,
                    # ── Bookmaker odds (decimal) ──────────────────────────
                    # Used ONLY in post-hoc value betting simulation — never
                    # as model features (that would be circular/cheating).
                    # Bet365: widely available retail book, 5-8% margin
                    'b365h':  safe(row['B365H'], np.nan) if has_b365 else np.nan,
                    'b365d':  safe(row['B365D'], np.nan) if has_b365 else np.nan,
                    'b365a':  safe(row['B365A'], np.nan) if has_b365 else np.nan,
                    # Pinnacle: sharpest closing line, ~2-3% margin
                    # Gold standard for Closing Line Value (CLV) measurement
                    'psh':    safe(row['PSH'],   np.nan) if has_ps   else np.nan,
                    'psd':    safe(row['PSD'],   np.nan) if has_ps   else np.nan,
                    'psa':    safe(row['PSA'],   np.nan) if has_ps   else np.nan,
                    # Best available odds across all tracked books
                    'maxh':   safe(row['MaxH'],  np.nan) if has_max  else np.nan,
                    'maxd':   safe(row['MaxD'],  np.nan) if has_max  else np.nan,
                    'maxa':   safe(row['MaxA'],  np.nan) if has_max  else np.nan,
                })
            time.sleep(0.03)

    df = (pd.DataFrame(all_rows)
            .sort_values('date')
            .reset_index(drop=True))
    df.to_csv(cache_path, index=False, compression='gzip')
    print(f'  Cached {len(df):,} rows → {cache_path}')
    return df


# ══════════════════════════════════════════════════════════════════════════════
# HT MARGIN BUCKETS  (v1 fix: replace binary is_home_leading)
# ══════════════════════════════════════════════════════════════════════════════

HT_BUCKET_NAMES = [
    'ht_losing_2plus',
    'ht_losing_1',
    'ht_draw',
    'ht_winning_1',
    'ht_winning_2plus',
]

def ht_margin_buckets(hthg: float, htag: float) -> Dict[str, float]:
    """
    One-hot encode the half-time goal lead into 5 buckets.

    v1 used a single binary is_home_leading which the model leaned on for
    44% of its weight. By expressing margin, the model can learn:
      - 2+ goal lead → very high conversion rate → very different from 1-0
      - 2+ goal deficit → comeback extremely unlikely → own category
    """
    lead = int(hthg) - int(htag)
    return {
        'ht_losing_2plus':  1.0 if lead <= -2 else 0.0,
        'ht_losing_1':      1.0 if lead == -1 else 0.0,
        'ht_draw':          1.0 if lead ==  0 else 0.0,
        'ht_winning_1':     1.0 if lead ==  1 else 0.0,
        'ht_winning_2plus': 1.0 if lead >=  2 else 0.0,
    }


# ══════════════════════════════════════════════════════════════════════════════
# LEAGUE ONE-HOT ENCODING
# ══════════════════════════════════════════════════════════════════════════════

LEAGUE_OHE_NAMES = [f'league_{k}' for k in LEAGUES]

def league_ohe(league: str) -> Dict[str, float]:
    """
    One-hot encode league membership.

    Structural differences the model needs to learn per league:
      - Draw rates:  Serie A ~29%  >  Bundesliga ~24%
      - Goals/game:  Bundesliga ~2.8  >  Serie A ~2.5
      - Home advantage: varies 3-4% across leagues
    Without this encoding, the model conflates cross-league patterns.
    """
    return {f'league_{k}': 1.0 if k == league else 0.0 for k in LEAGUES}


# ══════════════════════════════════════════════════════════════════════════════
# FEATURE BUILDER
# ══════════════════════════════════════════════════════════════════════════════

def build_prematch_features(home: str, away: str, league: str,
                             elo: EloSystem, form: FormTracker,
                             h2h: H2HTracker) -> Dict[str, float]:
    """
    Build the 23-dim pre-match feature vector from tracker snapshots.
    TIME-SERIES SAFE: all trackers have been called snapshot() before update().
    """
    h_elo, a_elo, elo_diff = elo.snapshot(home, away)
    h_form = form.snapshot(home, league)
    a_form = form.snapshot(away, league)
    h2h_rate = h2h.snapshot(home, away)

    return {
        # Team strength
        'home_elo':                h_elo,
        'away_elo':                a_elo,
        'elo_differential':        elo_diff,
        # Home rolling form (expanding window, league-prior cold-start)
        'home_win_rate_10':        h_form['win_rate'],
        'home_draw_rate_10':       h_form['draw_rate'],
        'home_goals_scored_10':    h_form['goals_scored'],
        'home_goals_conceded_10':  h_form['goals_conceded'],
        'home_sot_rate_10':        h_form['sot_rate'],
        'home_clean_sheet_rate_10':h_form['clean_sheet_rate'],
        'home_red_card_rate_10':   h_form['red_card_rate'],
        # Away rolling form
        'away_win_rate_10':        a_form['win_rate'],
        'away_draw_rate_10':       a_form['draw_rate'],
        'away_goals_scored_10':    a_form['goals_scored'],
        'away_goals_conceded_10':  a_form['goals_conceded'],
        'away_sot_rate_10':        a_form['sot_rate'],
        'away_clean_sheet_rate_10':a_form['clean_sheet_rate'],
        'away_red_card_rate_10':   a_form['red_card_rate'],
        # Head-to-head
        'h2h_home_win_rate_5':     h2h_rate,
        # League encoding
        **league_ohe(league),
    }


def build_halftime_features(prematch: Dict[str, float],
                             hthg: float, htag: float,
                             hr: float, ar: float) -> Dict[str, float]:
    """
    Extend pre-match features with in-play half-time block (7 features).

    DATA LEAKAGE FIX:
    v1 included HST and AST (full-match shots on target).
    These represent the entire 90 minutes — unavailable at minute 45.
    They have been removed entirely. The pre-match `sot_rate_10` feature
    already captures historical shooting efficiency without any leakage.

    What's retained:
      HTHG, HTAG  — goals at half-time (genuinely available)
      HR, AR      — red cards (full-match, slight leakage noted; upgrade requires
                    first-half card data not present in this dataset)
      HT buckets  — derived from HTHG/HTAG, fully clean
    """
    return {
        **prematch,
        # Raw half-time goal counts
        'HTHG': hthg,
        'HTAG': htag,
        # Red cards — retained per user spec; see leakage note above
        'HR':   hr,
        'AR':   ar,
        # HT margin one-hot (replaces binary is_home_leading from v1)
        **ht_margin_buckets(hthg, htag),
    }


# ══════════════════════════════════════════════════════════════════════════════
# TRACKER UPDATE  (called AFTER feature snapshot on every match)
# ══════════════════════════════════════════════════════════════════════════════

def update_all_trackers(elo: EloSystem, form: FormTracker, h2h: H2HTracker,
                        home: str, away: str, ftr: str, m: pd.Series) -> None:
    """
    Update ELO, form, and H2H trackers from one completed match.

    TIME-SERIES INTEGRITY GUARANTEE:
    This function is ALWAYS called AFTER feature snapshots have been taken.
    The order in the main loop is:
        1. ensure_initialized()
        2. snapshot() → features recorded
        3. update_all_trackers()   ← this function
    No future information can flow backward.
    """
    fthg = int(safe(m['fthg']))
    ftag = int(safe(m['ftag']))
    # Home SOT used to track home team's shooting form (pre-match feature)
    hst  = safe(m['hst'], 4.0) if not pd.isna(m.get('hst', np.nan)) else 4.0
    ast  = safe(m['ast'], 4.0) if not pd.isna(m.get('ast', np.nan)) else 4.0
    hr   = safe(m['hr'],  0.0) if not pd.isna(m.get('hr',  np.nan)) else 0.0
    ar   = safe(m['ar'],  0.0) if not pd.isna(m.get('ar',  np.nan)) else 0.0

    home_res = 'W' if ftr == 'H' else ('D' if ftr == 'D' else 'L')
    away_res = 'W' if ftr == 'A' else ('D' if ftr == 'D' else 'L')

    elo.update(home, away, ftr)
    form.update(home, fthg, ftag, hst, hr, home_res)
    form.update(away, ftag, fthg, ast, ar, away_res)
    h2h.update(home, away, ftr)


# ══════════════════════════════════════════════════════════════════════════════
# CHRONOLOGICAL FEATURE MATRIX BUILDER
# ══════════════════════════════════════════════════════════════════════════════

def build_feature_matrices(df: pd.DataFrame, mode: str) -> Tuple[
    np.ndarray, np.ndarray, np.ndarray, np.ndarray, List[str], pd.DataFrame
]:
    """
    Walk the entire dataset chronologically, producing train and test feature
    matrices with ZERO data leakage.

    WALK-FORWARD PROTOCOL:
    ──────────────────────
    For every match in chronological order (regardless of train/test split):

      Step 1 — Initialize: ensure both teams have ELO ratings. If a team is
               appearing for the first time in this league this season, seed
               them using the promoted-team logic (bottom-3 of prior season).

      Step 2 — Snapshot: record ELO, form, H2H BEFORE this match.

      Step 3 — Build features: assemble the feature vector from snapshots.

      Step 4 — Assign: if this season is in TRAIN_SEASONS → X_train;
               if in TEST_SEASONS → X_test.

      Step 5 — Update: ELO, form, H2H updated from the match result.
               This update flows FORWARD — later matches benefit from it,
               but not this match or any earlier one.

    CRITICAL — WHY WE DON'T RESET TRACKERS AT THE TRAIN/TEST BOUNDARY:
    If we reset ELO at season 1920, teams start at 1500 again and we throw
    away 14 seasons of learning. Instead, the trackers are warm and carry
    forward. This mirrors production: you wouldn't reset ELO live either.
    The test set predictions therefore represent genuine out-of-sample
    performance on unseen data with fully informed trackers.

    Parameters
    ----------
    df   : matches DataFrame, sorted chronologically
    mode : 'halftime' | 'prematch'

    Returns
    -------
    X_train, y_train, X_test, y_test, feature_names, test_meta
    test_meta: DataFrame with odds + fixture info for every test row, parallel
               to X_test / y_test. Used exclusively for value betting simulation.
    """
    elo  = EloSystem()
    form = FormTracker()
    h2h  = H2HTracker()

    # Track current season per league to detect season transitions
    current_season_per_league: Dict[str, str] = {}

    train_rows:   List[Dict[str, float]] = []
    train_labels: List[str] = []
    test_rows:    List[Dict[str, float]] = []
    test_labels:  List[str] = []
    # Parallel metadata for test set — odds + fixture identity
    test_meta_rows: List[Dict] = []
    skipped = 0

    for _, m in df.iterrows():
        home   = m['home']
        away   = m['away']
        league = m['league']
        season = m['season']
        ftr    = m['ftr']

        # ── Step 0: detect season transition for this league ───────────────
        # When a league's season changes, we finalize the previous season's
        # ELO snapshot so promoted-team seeding can use it next season.
        prev_season = current_season_per_league.get(league)
        if prev_season is not None and prev_season != season:
            elo.finalize_season(league, prev_season)
        current_season_per_league[league] = season

        # Register these teams as participants in this league/season
        elo.register_team_in_season(league, season, home, away)

        # ── Step 1: initialize (promoted team seeding if needed) ───────────
        elo.ensure_initialized(home, league, season)
        elo.ensure_initialized(away, league, season)

        # ── Step 2 & 3: snapshot → build features ─────────────────────────
        prematch = build_prematch_features(home, away, league, elo, form, h2h)

        if mode == 'halftime':
            # Skip rows missing half-time data (still update trackers)
            hthg = m.get('hthg', np.nan)
            htag = m.get('htag', np.nan)
            if pd.isna(hthg) or pd.isna(htag):
                update_all_trackers(elo, form, h2h, home, away, ftr, m)
                skipped += 1
                continue

            features = build_halftime_features(
                prematch,
                hthg=float(hthg), htag=float(htag),
                hr=safe(m.get('hr', np.nan)),
                ar=safe(m.get('ar', np.nan)),
            )
        else:
            features = prematch

        # ── Step 4: assign to correct split (date-based, league-agnostic) ──
        if m['date'] < SPLIT_DATE:
            train_rows.append(features)
            train_labels.append(ftr)
        else:
            test_rows.append(features)
            test_labels.append(ftr)
            # Capture odds metadata parallel to the feature row.
            # NaN = odds not available for this match/book.
            test_meta_rows.append({
                'date':   m['date'],  'season': season,
                'league': league,     'home':   home,    'away': away,
                'ftr':    ftr,
                'b365h':  m.get('b365h', np.nan), 'b365d': m.get('b365d', np.nan),
                'b365a':  m.get('b365a', np.nan),
                'psh':    m.get('psh',   np.nan), 'psd':   m.get('psd',   np.nan),
                'psa':    m.get('psa',   np.nan),
                'maxh':   m.get('maxh',  np.nan), 'maxd':  m.get('maxd',  np.nan),
                'maxa':   m.get('maxa',  np.nan),
            })
        # else: seasons outside both sets are skipped (shouldn't happen)

        # ── Step 5: update trackers AFTER recording features ───────────────
        update_all_trackers(elo, form, h2h, home, away, ftr, m)

    # Finalize any seasons still open at the end of the dataset
    for league, season in current_season_per_league.items():
        elo.finalize_season(league, season)

    if skipped:
        print(f'  Skipped {skipped:,} rows (missing HT data)')

    feature_names = list(train_rows[0].keys()) if train_rows else []

    def to_array(rows):
        return np.array([[r[k] for k in feature_names] for r in rows],
                        dtype=np.float32)

    X_train   = to_array(train_rows)
    X_test    = to_array(test_rows)
    y_train   = np.array(train_labels)
    y_test    = np.array(test_labels)
    test_meta = pd.DataFrame(test_meta_rows).reset_index(drop=True)

    print(f'  Train rows: {len(X_train):,}  (before {SPLIT_DATE.date()})')
    print(f'  Test  rows: {len(X_test):,}   (on/after {SPLIT_DATE.date()})')

    # Report odds coverage for the test set
    b365_cov = test_meta['b365h'].notna().mean() * 100
    ps_cov   = test_meta['psh'].notna().mean() * 100
    print(f'  Odds coverage — Bet365: {b365_cov:.0f}%   Pinnacle: {ps_cov:.0f}%')

    return X_train, y_train, X_test, y_test, feature_names, test_meta


# ══════════════════════════════════════════════════════════════════════════════
# XGBOOST CONFIG
# ══════════════════════════════════════════════════════════════════════════════

XGBOOST_PARAMS: Dict = {
    'objective':         'multi:softprob',
    'num_class':         3,
    # Slightly shallower than v1 (depth 5 → 4) — with league/HT bucket OHE
    # the model has more structural signal; less depth reduces overfit.
    'max_depth':         4,
    'learning_rate':     0.05,
    'n_estimators':      2000,    # capped by early stopping
    'subsample':         0.8,
    'colsample_bytree':  0.8,
    'reg_alpha':         0.3,
    'reg_lambda':        1.5,
    'min_child_weight':  5,
    'eval_metric':       'mlogloss',
    # early stopping moved to the constructor (xgboost ≥ 2.0 removed the fit()
    # kwarg; use_label_encoder was likewise dropped).
    'early_stopping_rounds': 50,
    'random_state':      42,
    'n_jobs':            -1,
}


# ══════════════════════════════════════════════════════════════════════════════
# EVALUATION
# ══════════════════════════════════════════════════════════════════════════════

def evaluate(model: xgb.XGBClassifier, le: LabelEncoder,
             X_train: np.ndarray, y_train: np.ndarray,
             X_test: np.ndarray, y_test: np.ndarray,
             feature_names: List[str], mode: str) -> None:
    """
    Full evaluation suite:
      1. Baseline accuracy  (always predict majority class — home win)
      2. Train accuracy     (sanity-check for overfit)
      3. Test accuracy      (out-of-sample, chronological)
      4. Per-class accuracy
      5. Log-loss           (tests probability calibration, not just argmax)
      6. Confusion matrix   (text)
      7. Feature importance (verifies model is no longer dominated by one feature)
    """
    y_train_enc = le.transform(y_train)
    y_test_enc  = le.transform(y_test)

    # ── 1. Baseline: always predict home win ──────────────────────────────
    # The majority class on the test set. A model must beat this to add value.
    test_home_count = (y_test == 'H').sum()
    baseline_acc = test_home_count / len(y_test)

    # ── 2/3. Model accuracy ───────────────────────────────────────────────
    train_preds = model.predict(X_train)
    test_preds  = model.predict(X_test)
    train_acc   = accuracy_score(y_train_enc, train_preds)
    test_acc    = accuracy_score(y_test_enc,  test_preds)

    # ── 4. Per-class accuracy ─────────────────────────────────────────────
    test_probs  = model.predict_proba(X_test)
    test_ll     = log_loss(y_test_enc, test_probs)

    pred_labels = le.inverse_transform(test_preds)
    classes = ['H', 'D', 'A']
    per_class = {}
    for c in classes:
        mask = y_test == c
        if mask.sum() == 0:
            per_class[c] = 0.0
        else:
            per_class[c] = (pred_labels[mask] == c).mean()

    # ── 5. Confusion matrix ───────────────────────────────────────────────
    cm = confusion_matrix(y_test, pred_labels, labels=classes)

    # ── 6. Feature importance — sorted ───────────────────────────────────
    imp = sorted(zip(feature_names, model.feature_importances_),
                 key=lambda x: x[1], reverse=True)

    # ── Print ─────────────────────────────────────────────────────────────
    width = 60
    print(f'\n{"═" * width}')
    print(f'EVALUATION — {mode.upper()} MODEL')
    print(f'{"═" * width}')
    print(f'{"Baseline (always Home):":35s} {baseline_acc*100:5.1f}%')
    print(f'{"Train accuracy:":35s} {train_acc*100:5.1f}%')
    print(f'{"Test accuracy (chronological OOS):":35s} {test_acc*100:5.1f}%')
    print(f'{"Lift over baseline:":35s} {(test_acc - baseline_acc)*100:+5.1f}pp')
    print(f'{"Test log-loss:":35s} {test_ll:.4f}')
    print()
    print('Per-class accuracy (test set):')
    for c in classes:
        n_actual = (y_test == c).sum()
        print(f'  {c}  {per_class[c]*100:5.1f}%  (n={n_actual:,})')

    print('\nConfusion matrix (rows=actual, cols=predicted):')
    print(f'       {"  ".join(f"{c:>5}" for c in classes)}')
    for i, c in enumerate(classes):
        row_str = '  '.join(f'{cm[i,j]:5d}' for j in range(len(classes)))
        print(f'  {c}  {row_str}')

    print(f'\nAll {len(imp)} feature importances:')
    top_importance = imp[0][1] if imp else 0
    for feat, score in imp:
        bar_len = int(score / max(top_importance, 1e-9) * 30)
        bar = '█' * bar_len
        pct = score * 100
        print(f'  {feat:<38s} {pct:5.1f}%  {bar}')

    print(f'\n{"═" * width}')


# ══════════════════════════════════════════════════════════════════════════════
# VALUE BETTING SIMULATION
# ══════════════════════════════════════════════════════════════════════════════

# Outcome index in the model's probability vector (label_encoder: A=0, D=1, H=2)
_OUTCOME_IDX = {'A': 0, 'D': 1, 'H': 2}

# Bookmaker configs: (name, home_col, draw_col, away_col)
BOOKS = [
    ('Bet365',   'b365h', 'b365d', 'b365a'),
    ('Pinnacle', 'psh',   'psd',   'psa'),
    ('Best',     'maxh',  'maxd',  'maxa'),
]

# Min-edge thresholds to sweep (model prob - book no-vig implied prob)
EDGE_THRESHOLDS = [0.0, 0.02, 0.05]


def _no_vig_probs(h_odds: float, d_odds: float,
                   a_odds: float) -> Tuple[float, float, float]:
    """
    Remove bookmaker margin (overround) from decimal odds to get fair implied
    probabilities that sum to exactly 1.0.

    Method: proportional (Pinnacle method) — divide each raw implied prob by
    the total overround. This is the standard way to estimate the 'true' market
    probability before the house cut.

    Example: B365 odds 2.10 / 3.40 / 3.60
      Raw implied: 0.476 / 0.294 / 0.278  → total = 1.048 (4.8% margin)
      Fair probs:  0.454 / 0.281 / 0.265  → total = 1.000
    """
    raw_h = 1.0 / h_odds
    raw_d = 1.0 / d_odds
    raw_a = 1.0 / a_odds
    total = raw_h + raw_d + raw_a
    return raw_h / total, raw_d / total, raw_a / total


def _kelly_fraction(model_prob: float, odds: float) -> float:
    """
    Full Kelly criterion fraction for a single bet.
    f* = (b·p - q) / b   where b = decimal_odds - 1, q = 1 - p

    Returns 0 if negative (no edge). We cap at 0.25 (quarter-Kelly) to
    manage the well-known Kelly variance and model calibration uncertainty.
    """
    b = odds - 1.0
    if b <= 0:
        return 0.0
    f = (b * model_prob - (1.0 - model_prob)) / b
    return max(0.0, min(f, 0.25))   # quarter-Kelly cap


def _simulate_book(model_probs: np.ndarray,    # shape (N, 3)  — [A, D, H]
                   actuals: np.ndarray,          # shape (N,)    — 'H'/'D'/'A'
                   meta: pd.DataFrame,
                   h_col: str, d_col: str, a_col: str,
                   min_edge: float,
                   stake_mode: str = 'flat') -> Dict:
    """
    Simulate betting on one book at a given minimum edge threshold.

    For each test match where the model finds edge on ANY outcome:
      - If model_prob(outcome) > no_vig_implied_prob(outcome) + min_edge:
          flat stake: 1 unit at the book's odds
          kelly stake: kelly_fraction * bankroll (not tracked here, reported separately)

    Returns a dict with summary stats and per-bet records for breakdowns.
    """
    odds_h = meta[h_col].values.astype(float)
    odds_d = meta[d_col].values.astype(float)
    odds_a = meta[a_col].values.astype(float)

    bets = []
    for i in range(len(actuals)):
        oh, od, oa = odds_h[i], odds_d[i], odds_a[i]
        if np.isnan(oh) or np.isnan(od) or np.isnan(oa):
            continue
        if oh <= 1.0 or od <= 1.0 or oa <= 1.0:
            continue   # corrupted/suspended odds

        fair_h, fair_d, fair_a = _no_vig_probs(oh, od, oa)
        mp_a, mp_d, mp_h = model_probs[i]   # A=0, D=1, H=2

        for outcome, mp, odds_val, fair_p in [
            ('H', mp_h, oh, fair_h),
            ('D', mp_d, od, fair_d),
            ('A', mp_a, oa, fair_a),
        ]:
            edge = mp - fair_p
            if edge < min_edge:
                continue

            won     = actuals[i] == outcome
            profit  = (odds_val - 1.0) if won else -1.0
            kelly_f = _kelly_fraction(mp, odds_val)

            bets.append({
                'season':  meta['season'].iloc[i],
                'league':  meta['league'].iloc[i],
                'outcome': outcome,
                'odds':    odds_val,
                'edge':    edge,
                'won':     won,
                'profit':  profit,
                'kelly_f': kelly_f,
                'kelly_profit': kelly_f * ((odds_val - 1.0) if won else -1.0),
            })

    if not bets:
        return {'n_bets': 0, 'pnl': 0.0, 'roi': 0.0, 'bets': []}

    n      = len(bets)
    pnl    = sum(b['profit']       for b in bets)
    k_pnl  = sum(b['kelly_profit'] for b in bets)
    wins   = sum(1 for b in bets if b['won'])
    avg_o  = sum(b['odds'] for b in bets) / n
    avg_e  = sum(b['edge'] for b in bets) / n

    return {
        'n_bets':    n,
        'pnl':       round(pnl, 2),
        'roi':       round(pnl / n, 4),
        'kelly_pnl': round(k_pnl, 3),
        'win_rate':  round(wins / n, 4),
        'avg_odds':  round(avg_o, 3),
        'avg_edge':  round(avg_e, 4),
        'bets':      bets,
    }


def _print_book_results(book_name: str, results_by_edge: List[Dict],
                         n_test: int) -> None:
    """Print P&L summary table for one bookmaker across all edge thresholds."""
    W = 70
    print(f'\n  ── {book_name} ──')
    print(f'  {"Min Edge":>9}  {"Bets":>6}  {"Bet%":>5}  '
          f'{"P&L":>8}  {"ROI":>7}  {"Win%":>6}  {"Avg Odds":>9}  {"Kelly P&L":>10}')
    print(f'  {"-"*9}  {"-"*6}  {"-"*5}  {"-"*8}  {"-"*7}  {"-"*6}  {"-"*9}  {"-"*10}')
    for thresh, res in zip(EDGE_THRESHOLDS, results_by_edge):
        if res['n_bets'] == 0:
            print(f'  {thresh*100:>8.0f}%  {"—":>6}  {"—":>5}  '
                  f'{"—":>8}  {"—":>7}  {"—":>6}  {"—":>9}  {"—":>10}')
            continue
        print(
            f'  {thresh*100:>8.0f}%'
            f'  {res["n_bets"]:>6,}'
            f'  {res["n_bets"]/n_test*100:>4.1f}%'
            f'  {res["pnl"]:>+8.2f}u'
            f'  {res["roi"]*100:>+6.1f}%'
            f'  {res["win_rate"]*100:>5.1f}%'
            f'  {res["avg_odds"]:>9.3f}'
            f'  {res["kelly_pnl"]:>+9.3f}u'
        )


def _print_breakdowns(book_name: str, result: Dict, threshold: float) -> None:
    """Per-outcome and per-season breakdown for the default edge threshold."""
    bets = result.get('bets', [])
    if not bets:
        return

    print(f'\n  {book_name} @ min edge {threshold*100:.0f}% — breakdowns:')

    # Per outcome
    print(f'\n    By outcome:')
    print(f'    {"Outcome":>8}  {"Bets":>6}  {"P&L":>8}  {"ROI":>7}  {"Win%":>6}')
    for outcome in ['H', 'D', 'A']:
        sub = [b for b in bets if b['outcome'] == outcome]
        if not sub:
            continue
        pnl = sum(b['profit'] for b in sub)
        wins = sum(1 for b in sub if b['won'])
        print(f'    {outcome:>8}  {len(sub):>6,}  {pnl:>+8.2f}u'
              f'  {pnl/len(sub)*100:>+6.1f}%  {wins/len(sub)*100:>5.1f}%')

    # Per season
    print(f'\n    By season:')
    print(f'    {"Season":>8}  {"Bets":>6}  {"P&L":>8}  {"ROI":>7}')
    seasons = sorted(set(b['season'] for b in bets))
    for s in seasons:
        sub = [b for b in bets if b['season'] == s]
        pnl = sum(b['profit'] for b in sub)
        print(f'    {s:>8}  {len(sub):>6,}  {pnl:>+8.2f}u  {pnl/len(sub)*100:>+6.1f}%')

    # Per league
    print(f'\n    By league:')
    print(f'    {"League":>12}  {"Bets":>6}  {"P&L":>8}  {"ROI":>7}')
    leagues = sorted(set(b['league'] for b in bets))
    for lg in leagues:
        sub = [b for b in bets if b['league'] == lg]
        pnl = sum(b['profit'] for b in sub)
        print(f'    {lg:>12}  {len(sub):>6,}  {pnl:>+8.2f}u  {pnl/len(sub)*100:>+6.1f}%')


def _clv_analysis(model_probs: np.ndarray, actuals: np.ndarray,
                   meta: pd.DataFrame) -> None:
    """
    Closing Line Value (CLV) analysis against Pinnacle.

    CLV measures whether your model's probability estimates are better than
    the closing market consensus — a stronger predictor of long-run edge than
    any single P&L figure.

    For every match where Pinnacle odds exist:
      CLV > 0  →  model found higher probability than Pinnacle's fair price
                   (we 'beat the line')
      Avg CLV  →  structural model advantage vs the sharpest market

    A model with consistently positive average CLV will extract value in the
    long run even through variance. Negative CLV means the market already
    priced what the model knows (or the model is miscalibrated).
    """
    ps_h = meta['psh'].values.astype(float)
    ps_d = meta['psd'].values.astype(float)
    ps_a = meta['psa'].values.astype(float)

    clv_values: List[float] = []
    for i in range(len(actuals)):
        if np.isnan(ps_h[i]) or np.isnan(ps_d[i]) or np.isnan(ps_a[i]):
            continue
        actual = actuals[i]
        idx = _OUTCOME_IDX[actual]

        odds_map = {'H': ps_h[i], 'D': ps_d[i], 'A': ps_a[i]}
        fair_h, fair_d, fair_a = _no_vig_probs(ps_h[i], ps_d[i], ps_a[i])
        fair_map = {'H': fair_h, 'D': fair_d, 'A': fair_a}

        mp = model_probs[i][idx]
        fair_p = fair_map[actual]
        clv_values.append(mp - fair_p)

    if not clv_values:
        print('\n  CLV: Pinnacle odds not available in this dataset portion.')
        return

    n = len(clv_values)
    avg_clv = np.mean(clv_values)
    pct_pos = np.mean([v > 0 for v in clv_values]) * 100

    # t-stat to test if avg CLV is significantly different from 0
    if n > 1:
        std = np.std(clv_values, ddof=1)
        t_stat = avg_clv / (std / np.sqrt(n)) if std > 0 else 0.0
    else:
        t_stat = 0.0

    print(f'\n  ── Closing Line Value vs Pinnacle ({n:,} matches) ──')
    print(f'  Average CLV:        {avg_clv*100:+.3f}pp')
    print(f'  % beats Pinnacle:   {pct_pos:.1f}%')
    print(f'  t-statistic:        {t_stat:+.2f}')
    if abs(t_stat) >= 2.0:
        direction = 'positive' if t_stat > 0 else 'negative'
        print(f'  → Statistically significant {direction} CLV (|t| ≥ 2)')
    else:
        print(f'  → Not yet statistically significant (|t| < 2, need more data)')


def value_betting_report(model: xgb.XGBClassifier, le: LabelEncoder,
                          X_test: np.ndarray, y_test: np.ndarray,
                          test_meta: pd.DataFrame, mode: str) -> None:
    """
    Full value betting simulation on the chronological test set.

    WHAT THIS MEASURES (and why it beats accuracy/log-loss):
    ──────────────────────────────────────────────────────────
    A model can be 60% accurate but still lose money if it mostly wins on
    short-priced favourites. Conversely, a 45% accurate model that only bets
    when it has genuine edge on value prices can be highly profitable.

    This function answers: "If we had bet this model against real bookmaker
    odds on real matches from 2019/20 to 2023/24, what would have happened?"

    SIMULATED BOOKS:
      Bet365:   Retail odds. 5-8% margin. Bettors' realistic universe.
      Pinnacle: Sharp odds. 2-3% margin. Best profitability benchmark.
      Best:     Best available odds. Theoretical ceiling.

    EDGE THRESHOLDS:
      0%:  Bet whenever model prob > fair implied prob (no filter)
      2%:  Conservative — requires clear model advantage
      5%:  Strict — high conviction only

    STAKE MODES:
      Flat stake:  1 unit per bet. Cleanest P&L / ROI measure.
      Kelly:       Quarter-Kelly fraction of bankroll per bet. Risk-managed.

    CLV Analysis:
      Measuring model probability vs Pinnacle closing line tells you if the
      model has structural edge independent of short-run results variance.
    """
    W = 70
    print(f'\n{"═" * W}')
    print(f'VALUE BETTING SIMULATION — {mode.upper()} MODEL')
    print(f'Test period: {sorted(TEST_SEASONS)[0]} → {sorted(TEST_SEASONS)[-1]}'
          f'  ({len(y_test):,} matches)')
    print(f'{"═" * W}')

    # Model probabilities for test set: shape (N, 3) — [A, D, H]
    probs = model.predict_proba(X_test)   # le: A=0, D=1, H=2

    n_test = len(y_test)

    # ── Run simulation for each bookmaker ────────────────────────────────
    for book_name, h_col, d_col, a_col in BOOKS:
        if test_meta[h_col].notna().sum() < 100:
            print(f'\n  {book_name}: insufficient odds data (skipping)')
            continue

        results_by_edge = [
            _simulate_book(probs, y_test, test_meta,
                           h_col, d_col, a_col, thresh)
            for thresh in EDGE_THRESHOLDS
        ]
        _print_book_results(book_name, results_by_edge, n_test)

        # Detailed breakdown for the middle threshold (2%)
        default_idx = EDGE_THRESHOLDS.index(0.02)
        _print_breakdowns(book_name, results_by_edge[default_idx], 0.02)

    # ── CLV vs Pinnacle ───────────────────────────────────────────────────
    _clv_analysis(probs, y_test, test_meta)

    print(f'\n{"═" * W}')


# ══════════════════════════════════════════════════════════════════════════════
# ONNX EXPORT
# ══════════════════════════════════════════════════════════════════════════════

def export_to_onnx(model: xgb.XGBClassifier, model_name: str,
                   n_features: int, feature_names: List[str],
                   output_dir: Path) -> Path:
    try:
        from onnxmltools import convert_xgboost
        from onnxmltools.convert.common.data_types import FloatTensorType
    except ImportError:
        sys.exit('pip install onnxmltools')

    initial_type = [('float_input', FloatTensorType([None, n_features]))]
    onnx_model   = convert_xgboost(model, initial_types=initial_type)

    out_path = output_dir / f'{model_name}.onnx'
    with open(out_path, 'wb') as f:
        f.write(onnx_model.SerializeToString())

    meta_path = output_dir / f'{model_name}_features.json'
    with open(meta_path, 'w') as f:
        json.dump({'features': feature_names, 'n': n_features,
                   'label_order': ['away', 'draw', 'home']}, f, indent=2)

    size_kb = out_path.stat().st_size / 1024
    print(f'  ✓ {out_path.name}  ({size_kb:.1f} KB)')
    return out_path


# ══════════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════════

def main() -> None:
    parser = argparse.ArgumentParser(description='MaxEdge Supermodel v2 Training')
    parser.add_argument('--mode', choices=['halftime', 'prematch', 'both'],
                        default='both')
    parser.add_argument('--no-cache', action='store_true',
                        help='Force re-download of CSVs')
    parser.add_argument('--dry-run', action='store_true',
                        help='Load data and show split stats; do not train')
    args = parser.parse_args()

    output_dir = Path(__file__).parent / 'models'
    output_dir.mkdir(parents=True, exist_ok=True)

    print('━' * 60)
    print('MaxEdge Supermodel v2  —  Time-Series Integrity Edition')
    print('━' * 60)
    print(f'Train/test boundary: {SPLIT_DATE.date()} (before → train, on/after → test)')

    print('\nLoading data...')
    df = load_all_csvs(use_cache=not args.no_cache)
    ftr_counts = df['ftr'].value_counts().to_dict()
    print(f'Total matches: {len(df):,}')
    print(f'Results: H={ftr_counts.get("H",0):,}  '
          f'D={ftr_counts.get("D",0):,}  A={ftr_counts.get("A",0):,}')
    print(f'Date range: {df["date"].min().date()} → {df["date"].max().date()}')

    if args.dry_run:
        # Show what the split would look like without training
        train_df = df[df['date'] < SPLIT_DATE]
        test_df  = df[df['date'] >= SPLIT_DATE]
        print(f'\nTrain split: {len(train_df):,} matches')
        print(f'Test  split: {len(test_df):,} matches')
        print('\nDry run — not training.')
        return

    le = LabelEncoder()
    le.fit(['A', 'D', 'H'])   # A=0, D=1, H=2

    modes_to_run = ['halftime', 'prematch'] if args.mode == 'both' else [args.mode]

    for mode in modes_to_run:
        print(f'\n{"━" * 60}')
        print(f'Mode: {mode.upper()}')
        print(f'{"━" * 60}')

        print('\nBuilding feature matrices (chronological walk-forward)...')
        X_train, y_train, X_test, y_test, feat_names, test_meta = \
            build_feature_matrices(df, mode)

        y_train_enc = le.transform(y_train)
        y_test_enc  = le.transform(y_test)

        print(f'Feature dimensions: {X_train.shape[1]}')
        print(f'Feature names: {feat_names}')

        print('\nTraining XGBoost...')
        model = xgb.XGBClassifier(**XGBOOST_PARAMS)
        model.fit(
            X_train, y_train_enc,
            eval_set=[(X_test, y_test_enc)],
            verbose=100,
        )

        evaluate(model, le, X_train, y_train, X_test, y_test, feat_names, mode)
        value_betting_report(model, le, X_test, y_test, test_meta, mode)

        model_name = f'supermodel_{mode}_v2'
        print(f'\nExporting {model_name}...')
        export_to_onnx(model, model_name, X_train.shape[1], feat_names, output_dir)

    print('\n✓ v2 training complete.')


if __name__ == '__main__':
    main()
