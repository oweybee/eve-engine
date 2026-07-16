#!/usr/bin/env python3
"""
ensemble/build_training_corpus.py — assemble the supermodel training corpus.

Writes models/_csv_cache_v3.csv.gz in the exact internal schema that
train_supermodel_v2.py's load_all_csvs() expects, so the trainer runs fully
offline (no football-data.co.uk fetch):

  cd engine
  python3 ensemble/build_training_corpus.py
  python3 ensemble/train_supermodel_v2.py --mode prematch

Sources
───────
  • big-5  (epl/laliga/bundesliga/seriea/ligue1): the footballcsv/cache.footballdata
           GitHub mirror of football-data.co.uk — results + HT only (no shots/cards/
           odds), which is why sot_rate/red_card_rate fall back to LEAGUE_PRIORS in
           the trainer. Season files 2005-06 → 2023-24.
  • extra  (allsvenskan, mls): the football-data 'extra league' CSVs committed under
           ensemble/data/ (SWE.csv, USA.csv) — results + closing odds.

Add a league by extending BIG5 (mirror code → key) or UPLOADS (csv → key).
"""
import io, json
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import numpy as np, pandas as pd, requests

RAW  = "https://raw.githubusercontent.com/footballcsv/cache.footballdata/master"
BIG5 = {"eng.1": "epl", "de.1": "bundesliga", "es.1": "laliga", "it.1": "seriea", "fr.1": "ligue1"}
SEASONS = [f"{y}-{str(y+1)[2:]}" for y in range(2005, 2024)]  # 2005-06 … 2023-24
DATA_DIR = Path(__file__).parent / "data"
UPLOADS = {DATA_DIR / "SWE.csv": "allsvenskan", DATA_DIR / "USA.csv": "mls"}
OUT = Path(__file__).parent / "models" / "_csv_cache_v3.csv.gz"

COLS = ["date","league","season","home","away","fthg","ftag","ftr","hthg","htag",
        "hst","ast","hr","ar","b365h","b365d","b365a","psh","psd","psa","maxh","maxd","maxa"]

def _season_code(sdir):  # '2005-06' -> '0506'
    a, b = sdir.split("-"); return a[2:] + b

def _score(s):
    try:
        h, a = str(s).split("-"); return int(h), int(a)
    except Exception:
        return None, None

def _blank(extra):
    row = {c: np.nan for c in COLS}; row.update(extra); return row

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

def load_upload(path, key):
    df = pd.read_csv(path, encoding="utf-8-sig")
    def num(v):
        try: return float(v)
        except Exception: return np.nan
    rows = []
    for _, m in df.iterrows():
        try: fthg, ftag = int(m["HG"]), int(m["AG"])
        except Exception: continue
        ftr = str(m["Res"]).strip().upper()
        if ftr not in ("H","D","A"): continue
        try: ts = pd.to_datetime(str(m["Date"]).strip(), dayfirst=True, utc=True)
        except Exception: continue
        rows.append(_blank({
            "date": ts, "league": key, "season": str(m["Season"]).strip(),
            "home": str(m["Home"]).strip(), "away": str(m["Away"]).strip(),
            "fthg": fthg, "ftag": ftag, "ftr": ftr,
            "b365h": num(m.get("B365CH")), "b365d": num(m.get("B365CD")), "b365a": num(m.get("B365CA")),
            "psh": num(m.get("PSCH")), "psd": num(m.get("PSCD")), "psa": num(m.get("PSCA")),
            "maxh": num(m.get("MaxCH")), "maxd": num(m.get("MaxCD")), "maxa": num(m.get("MaxCA"))}))
    print(f"  upload -> {key:11}: {len(rows):5} matches")
    return rows

def main():
    rows = []
    print("Downloading big-5 from footballcsv/cache.footballdata ...")
    with ThreadPoolExecutor(max_workers=5) as ex:
        for r in ex.map(fetch_big5, BIG5.items()): rows += r
    print("Loading extra leagues from ensemble/data/ ...")
    for path, key in UPLOADS.items(): rows += load_upload(path, key)
    df = pd.DataFrame(rows, columns=COLS).sort_values("date").reset_index(drop=True)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUT, index=False, compression="gzip")
    print(f"\n{len(df):,} matches -> {OUT}")
    print(df.groupby("league").size().to_string())
    print("date range:", df.date.min().date(), "->", df.date.max().date())

if __name__ == "__main__":
    main()
