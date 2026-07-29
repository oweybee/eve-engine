#!/usr/bin/env python3
"""
ensemble/build_training_corpus.py — assemble the supermodel training corpus.

Writes models/_csv_cache_v3.csv.gz in the exact internal schema that
train_supermodel_v2.py's load_all_csvs() expects, so the trainer runs fully
offline (no football-data.co.uk fetch):

  cd engine
  python3 ensemble/build_training_corpus.py
  python3 ensemble/train_supermodel_v2.py --mode both

Sources
───────
  • big-5  (epl/laliga/bundesliga/seriea/ligue1): the footballcsv/cache.footballdata
           GitHub mirror of football-data.co.uk — results + HT only (no shots/cards/
           odds), which is why sot_rate/red_card_rate fall back to LEAGUE_PRIORS in
           the trainer. Season files 2005-06 → 2023-24.
  • uploads: EVERY *.csv dropped into ensemble/data/. Auto-discovered — no code
           edit needed to add a league or season. Two football-data.co.uk layouts
           are recognised automatically:

             1. "extra league" wide format (SWE.csv / USA.csv):
                Country,League,Season,Date,Time,Home,Away,HG,AG,Res,
                PSCH,PSCD,PSCA,MaxCH,MaxCD,MaxCA,...,B365CH,B365CD,B365CA
                → league + season are read per-row from the League / Season columns.

             2. standard main-league format (E0.csv, D1.csv, …):
                Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,FTR,HTHG,HTAG,HST,AST,HR,AR,
                B365H,B365D,B365A,PSH,PSD,PSA,MaxH,MaxD,MaxA,(…CH/CD/CA closing…)
                → league is derived from the Div code (or filename); season from the
                match date (European Aug–May convention).

TEACHING THE MODEL A NEW SEASON / LEAGUE
────────────────────────────────────────
  Just drop the CSV into ensemble/data/ and re-run this script + the trainer.
  No code change is required to ADD DATA.

  A league whose slug already exists (epl, laliga, bundesliga, seriea, ligue1,
  allsvenskan, mls) is a first-class citizen: it has its own one-hot column in
  the model and its own cold-start priors.

  A brand-NEW league slug is still learned — it contributes to ELO, rolling
  form and the global signal — but it shares the "other" (all-zero) one-hot
  bucket until it is promoted to a first-class league. Promoting it is a
  deliberate, contract-changing edit: add the slug to LEAGUES / LEAGUE_PRIORS
  in train_supermodel_v2.py AND to the matching hardcoded lists in
  ../lib/halftimeFeatures.js, because production builds the feature vector by
  hand and must stay column-for-column identical to *_features.json. The CI
  retrain guard (train-supermodels.yml) refuses to commit a model whose feature
  count changed, so an accidental contract drift can never ship silently.

The league slug is derived from the CSV's own League column (see LEAGUE_ALIASES),
so "Allsvenskan" → allsvenskan and "MLS" → mls exactly as before.
"""
import argparse
import io
import re
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import numpy as np, pandas as pd, requests

RAW  = "https://raw.githubusercontent.com/footballcsv/cache.footballdata/master"
BIG5 = {"eng.1": "epl", "de.1": "bundesliga", "es.1": "laliga", "it.1": "seriea", "fr.1": "ligue1"}
SEASONS = [f"{y}-{str(y+1)[2:]}" for y in range(2005, 2024)]  # 2005-06 … 2023-24
DATA_DIR = Path(__file__).parent / "data"
OUT = Path(__file__).parent / "models" / "_csv_cache_v3.csv.gz"

COLS = ["date","league","season","home","away","fthg","ftag","ftr","hthg","htag",
        "hst","ast","hr","ar","b365h","b365d","b365a","psh","psd","psa","maxh","maxd","maxa"]

# ── League-name / division-code → canonical slug ────────────────────────────────
# Preserves the exact keys production (lib/halftimeFeatures.js) and the trainer's
# LEAGUE_PRIORS depend on. Anything not listed is slugified (kept, but as an
# "other"-bucket league until promoted — see the module docstring).
LEAGUE_ALIASES = {
    # extra-league display names (SWE.csv / USA.csv and friends)
    "allsvenskan": "allsvenskan",
    "mls": "mls", "major league soccer": "mls",
    # big-5 display names
    "premier league": "epl", "epl": "epl", "english premier league": "epl", "england": "epl",
    "la liga": "laliga", "laliga": "laliga", "primera division": "laliga", "spain": "laliga",
    "bundesliga": "bundesliga", "germany": "bundesliga",
    "serie a": "seriea", "seriea": "seriea", "italy": "seriea",
    "ligue 1": "ligue1", "ligue1": "ligue1", "france": "ligue1",
    # standard football-data.co.uk division codes (main-league downloads)
    "e0": "epl", "sp1": "laliga", "d1": "bundesliga", "i1": "seriea", "f1": "ligue1",
}


def league_slug(name: str) -> str:
    """Map a free-text league name / division code to a canonical slug."""
    key = str(name).strip().lower()
    if key in LEAGUE_ALIASES:
        return LEAGUE_ALIASES[key]
    return re.sub(r"[^a-z0-9]+", "", key) or "unknown"


def _season_code(sdir):  # '2005-06' -> '0506'
    a, b = sdir.split("-"); return a[2:] + b


def _season_from_date(ts: pd.Timestamp) -> str:
    """European football season code from a match date: Aug 2015 → '1516'."""
    y = ts.year
    start = y if ts.month >= 7 else y - 1
    return f"{str(start)[2:]}{str(start + 1)[2:]}"


def _score(s):
    try:
        h, a = str(s).split("-"); return int(h), int(a)
    except Exception:
        return None, None


def _txt(v):
    """Clean string, or '' for NaN / None (NaN is truthy in Python — guard it)."""
    if v is None:
        return ""
    if isinstance(v, float) and np.isnan(v):
        return ""
    s = str(v).strip()
    return "" if s.lower() == "nan" else s


def _num(v):
    try:
        f = float(v)
        return f if not np.isnan(f) else np.nan
    except Exception:
        return np.nan


def _pick(row, *names):
    """First present, parseable numeric among candidate column names (NaN if none)."""
    for n in names:
        if n in row:
            v = _num(row[n])
            if not (isinstance(v, float) and np.isnan(v)):
                return v
    return np.nan


def _blank(extra):
    row = {c: np.nan for c in COLS}; row.update(extra); return row


# ── Big-5 GitHub mirror (results + HT only) ─────────────────────────────────────

def fetch_big5(item):
    code, key = item; rows = []
    for sdir in SEASONS:
        try:
            r = requests.get(f"{RAW}/{sdir}/{code}.csv", timeout=30)
            if r.status_code != 200: continue
            df = pd.read_csv(io.StringIO(r.text))
        except Exception as e:
            print(f"  warn {code}/{sdir}: {e}"); continue
        for _, m in df.iterrows():
            fthg, ftag = _score(m.get("FT"))
            if fthg is None: continue
            hthg, htag = _score(m.get("HT"))
            try: ts = pd.to_datetime(str(m["Date"]), utc=True)
            except Exception: continue
            rows.append(_blank({
                "date": ts, "league": key, "season": _season_code(sdir),
                "home": str(m["Team 1"]).strip(), "away": str(m["Team 2"]).strip(),
                "fthg": fthg, "ftag": ftag,
                "ftr": "H" if fthg > ftag else ("A" if ftag > fthg else "D"),
                "hthg": hthg if hthg is not None else np.nan,
                "htag": htag if htag is not None else np.nan}))
    print(f"  {code:6} -> {key:11}: {len(rows):5} matches")
    return rows


# ── Uploaded CSVs in ensemble/data/ (auto-discovered) ──────────────────────────

def _parse_extra(df):
    """football-data 'extra league' wide layout (SWE.csv / USA.csv)."""
    rows = []
    for _, m in df.iterrows():
        try: fthg, ftag = int(m["HG"]), int(m["AG"])
        except Exception: continue
        ftr = str(m["Res"]).strip().upper()
        if ftr not in ("H", "D", "A"): continue
        try: ts = pd.to_datetime(str(m["Date"]).strip(), dayfirst=True, utc=True)
        except Exception: continue
        league = league_slug(_txt(m.get("League")) or _txt(m.get("Country")))
        season = _txt(m.get("Season")) or _season_from_date(ts)
        rows.append(_blank({
            "date": ts, "league": league, "season": season,
            "home": str(m["Home"]).strip(), "away": str(m["Away"]).strip(),
            "fthg": fthg, "ftag": ftag, "ftr": ftr,
            # prefer closing odds (…C…) — that is what the extra files carry
            "b365h": _pick(m, "B365CH", "B365H"), "b365d": _pick(m, "B365CD", "B365D"), "b365a": _pick(m, "B365CA", "B365A"),
            "psh": _pick(m, "PSCH", "PSH"), "psd": _pick(m, "PSCD", "PSD"), "psa": _pick(m, "PSCA", "PSA"),
            "maxh": _pick(m, "MaxCH", "MaxH"), "maxd": _pick(m, "MaxCD", "MaxD"), "maxa": _pick(m, "MaxCA", "MaxA")}))
    return rows


def _parse_main(df, fallback_league):
    """Standard football-data.co.uk main-league layout (E0.csv, D1.csv, …)."""
    rows = []
    for _, m in df.iterrows():
        ftr = str(m.get("FTR", "")).strip().upper()
        if ftr not in ("H", "D", "A"): continue
        try: fthg, ftag = int(m["FTHG"]), int(m["FTAG"])
        except Exception: continue
        try:
            ds = str(m["Date"]).strip()
            ts = (pd.Timestamp(ds, tz="UTC") if "-" in ds
                  else pd.to_datetime(ds, dayfirst=True, utc=True))
        except Exception: continue
        div = _txt(m.get("Div"))
        league = league_slug(div) if div else fallback_league
        try: hthg, htag = int(m["HTHG"]), int(m["HTAG"])
        except Exception: hthg, htag = np.nan, np.nan
        rows.append(_blank({
            "date": ts, "league": league, "season": _season_from_date(ts),
            "home": str(m["HomeTeam"]).strip(), "away": str(m["AwayTeam"]).strip(),
            "fthg": fthg, "ftag": ftag, "ftr": ftr,
            "hthg": hthg, "htag": htag,
            "hst": _pick(m, "HST"), "ast": _pick(m, "AST"),
            "hr": _pick(m, "HR"), "ar": _pick(m, "AR"),
            "b365h": _pick(m, "B365CH", "B365H"), "b365d": _pick(m, "B365CD", "B365D"), "b365a": _pick(m, "B365CA", "B365A"),
            "psh": _pick(m, "PSCH", "PSH", "PH"), "psd": _pick(m, "PSCD", "PSD", "PD"), "psa": _pick(m, "PSCA", "PSA", "PA"),
            "maxh": _pick(m, "MaxCH", "MaxH"), "maxd": _pick(m, "MaxCD", "MaxD"), "maxa": _pick(m, "MaxCA", "MaxA")}))
    return rows


def load_upload(path: Path):
    """Auto-detect the layout of one uploaded CSV and parse it."""
    try:
        df = pd.read_csv(path, encoding="utf-8-sig")
    except Exception as e:
        print(f"  skip {path.name}: unreadable ({e})")
        return []
    cols = set(df.columns)
    if {"Home", "Away", "HG", "AG", "Res"}.issubset(cols):
        rows = _parse_extra(df)
        layout = "extra"
    elif {"HomeTeam", "AwayTeam", "FTHG", "FTAG", "FTR"}.issubset(cols):
        rows = _parse_main(df, fallback_league=league_slug(path.stem))
        layout = "main"
    else:
        print(f"  skip {path.name}: unrecognised layout (need Home/Away/HG/AG/Res "
              f"or HomeTeam/AwayTeam/FTHG/FTAG/FTR)")
        return []
    leagues = sorted({r["league"] for r in rows})
    print(f"  {path.name:16} [{layout:5}] -> {len(rows):5} matches  leagues={leagues}")
    return rows


def discover_uploads(data_dir: Path):
    """Every *.csv in data_dir (sorted for determinism)."""
    return sorted(p for p in data_dir.glob("*.csv") if p.is_file())


# ── Orchestration ───────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Build the supermodel training corpus")
    ap.add_argument("--data-dir", default=str(DATA_DIR),
                    help="directory of uploaded football-data CSVs (default: ensemble/data)")
    ap.add_argument("--out", default=str(OUT), help="output cache path (.csv.gz)")
    ap.add_argument("--no-big5", action="store_true",
                    help="skip the big-5 GitHub-mirror fetch (uploads only; offline)")
    ap.add_argument("--dry-run", action="store_true",
                    help="parse and summarise uploads; do not fetch big-5 or write the cache")
    args = ap.parse_args()

    data_dir = Path(args.data_dir)
    rows = []

    if not (args.no_big5 or args.dry_run):
        print("Downloading big-5 from footballcsv/cache.footballdata ...")
        with ThreadPoolExecutor(max_workers=5) as ex:
            for r in ex.map(fetch_big5, BIG5.items()): rows += r

    uploads = discover_uploads(data_dir)
    print(f"Loading {len(uploads)} uploaded CSV(s) from {data_dir} ...")
    for path in uploads:
        rows += load_upload(path)

    if not rows:
        print("No matches parsed — nothing to write.")
        return

    df = pd.DataFrame(rows, columns=COLS).sort_values("date").reset_index(drop=True)
    print(f"\n{len(df):,} matches parsed")
    print(df.groupby("league").size().to_string())
    print("date range:", df.date.min().date(), "->", df.date.max().date())

    if args.dry_run:
        print("\nDry run — corpus validated, cache NOT written.")
        return

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(out, index=False, compression="gzip")
    print(f"\nwrote {len(df):,} matches -> {out}")


if __name__ == "__main__":
    main()
