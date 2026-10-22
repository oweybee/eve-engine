"""rows.json (team_rows.sql output) -> data.json for team_video.py. Same selection rules as the 21 Oct pipeline:
both sides 70%+ on the stat, 8+ games each, both played within 35 days, kick-off 10:00 UK or later,
up to 3 fixtures per video, max 2 per league, a stat with fewer than 2 fixtures is skipped, a fixture is used once.
Usage: python3 make_team_data.py rows.json YYYY-MM-DD data.json"""
import json, sys, datetime as dt
ROWS, DATE, OUT = sys.argv[1:4]
day = dt.date.fromisoformat(DATE); rows = json.load(open(ROWS)) or []
ONES = ("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen "
        "eighteen nineteen twenty").split()
COMP = {"UEFA Champions League": "Champions League", "UEFA Europa League": "Europa League",
        "UEFA Europa Conference League": "Conference League"}
TEAM = {"Heart Of Midlothian": "Hearts", "1899 Hoffenheim": "Hoffenheim", "Paris Saint Germain": "PSG",
        "Manchester United": "Man United", "Manchester City": "Man City", "Wolverhampton Wanderers": "Wolves",
        "Tottenham Hotspur": "Tottenham", "Nottingham Forest": "Nottingham Forest", "Beşiktaş": "Besiktas"}
SAY = {"NEC Nijmegen": "N E C Nijmegen", "PSV Eindhoven": "P S V Eindhoven", "PSG": "P S G", "AZ Alkmaar": "A Z Alkmaar",
       "RB Leipzig": "R B Leipzig", "FC Copenhagen": "Copenhagen"}
STATS = [
 ("3plus", "o3", "3plus_Goals", "three or more goals", "3+ goals", "Which one goes big tonight?"),
 ("btts", "bt", "Both_Teams_Scored", "both teams scored", "Both teams scored", "Goals at both ends tonight?"),
 ("under2", "u2", "Tight_Games", "two goals or fewer", "2 goals or fewer", "Which one breaks the pattern?"),
]
PRE = {"FC", "SC", "AFC", "HNK", "NK", "FK", "SK", "AC", "1.", "SV", "VfB", "VfL", "CF", "RC", "KRC"}
def short(n):
    n = TEAM.get(n, n); w = n.split()
    while len(w) > 1 and w[0] in PRE: w = w[1:]
    while len(w) > 1 and w[-1] in {"FC", "SC", "CF", "AFC"}: w = w[:-1]
    return " ".join(w)
def fresh(last): return last and (day - dt.date.fromisoformat(str(last)[:10])).days <= 35
videos, used = [], set()
for key, col, fname, say, label, ask in STATS:
    cand = []
    for r in rows:
        if r["ko"] < "10:00" or r["hn_n"] < 8 or r["an_n"] < 8 or not (fresh(r.get("h_last")) and fresh(r.get("a_last"))): continue
        hs, as_ = r["h_" + col], r["a_" + col]; ph, pa = hs.count("G") / len(hs), as_.count("G") / len(as_)
        if ph < .7 or pa < .7: continue
        cand.append((-(hs + as_).count("G") / (len(hs) + len(as_)), -min(ph, pa), r["ko"], r, hs, as_))
    cand.sort(key=lambda x: x[:3]); chosen, per = [], {}
    for *_, r, hs, as_ in cand:
        fk = (r["hn"], r["an"]); lg = (r.get("country"), r.get("league"))
        if fk in used or per.get(lg, 0) >= 2: continue
        chosen.append((r, hs, as_)); per[lg] = per.get(lg, 0) + 1
        if len(chosen) == 3: break
    if len(chosen) < 2: continue
    used.update((r["hn"], r["an"]) for r, _, _ in chosen)
    # countdown: weakest first, strongest last (#1)
    chosen.sort(key=lambda c: (c[1] + c[2]).count("G") / (len(c[1]) + len(c[2])))
    r1, h1, a1 = chosen[-1]; g, tot = (h1 + a1).count("G"), len(h1) + len(a1)
    pool = day.toordinal() % 2
    hook = [f"{ONES[g].capitalize()} from {ONES[tot]} with {say}. Guess the fixture.",
            f"{ONES[g].capitalize()} from {ONES[tot]}. {say.capitalize()}. And they meet today."][pool]
    items = []
    for r, hs, as_ in chosen:
        hn, an = short(r["hn"]), short(r["an"])
        it = dict(home=hn, away=an, comp=COMP.get(r["league"], r["league"]), ko=r["ko"], hg=r["h_games"], ag=r["a_games"])
        if hn in SAY: it["home_say"] = SAY[hn]
        if an in SAY: it["away_say"] = SAY[an]
        items.append(it)
    videos.append(dict(key=f"{key}_{day.day}", file=f"MaxEdge_{fname}_{day.strftime('%d_%b')}.mp4", stat=key, hook=hook,
                       h1=f"{label} in {g} of their last {tot}", ask=ask, items=items))
json.dump({"date_label": day.strftime("%a %d %b").replace(" 0", " "), "videos": videos}, open(OUT, "w"), indent=1, ensure_ascii=False)
for v in videos: print(v["file"], "|", v["hook"], "|", [f'{i["home"]} v {i["away"]}' for i in v["items"]])
if not videos: print("no qualifying fixtures")
