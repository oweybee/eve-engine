"""rows.json (from team_stats.sql) -> S.json, the per-club shape the examples read:
{club: {"games": [newest first, {d, ha, opp, gf, ga}], "form", "gf", "ga", "w", "cs", "btts", "o3", ...}}
League position and points are not here: read them from league_standings on the day and type them in."""
import json, sys
rows = json.load(open(sys.argv[1]))
if isinstance(rows, dict): rows = list(rows.values())[0]
S = {}
for r in rows: S.setdefault(r["team"], {"games": []})["games"].append({k: r[k] for k in ("d", "ha", "opp", "gf", "ga")})
res = lambda g: "W" if g["gf"] > g["ga"] else "D" if g["gf"] == g["ga"] else "L"
def streak(gs, f):
    n = 0
    for g in gs:
        if not f(g): break
        n += 1
    return n
for k, s in S.items():
    gs = s["games"]
    s.update(form="".join(map(res, gs)), gf=sum(g["gf"] for g in gs), ga=sum(g["ga"] for g in gs), w=sum(res(g) == "W" for g in gs),
             cs=sum(g["ga"] == 0 for g in gs), btts=sum(g["gf"] > 0 and g["ga"] > 0 for g in gs), o3=sum(g["gf"] + g["ga"] >= 3 for g in gs),
             unb=streak(gs, lambda g: g["gf"] >= g["ga"]), wins=streak(gs, lambda g: g["gf"] > g["ga"]), nwin=streak(gs, lambda g: g["gf"] <= g["ga"]),
             lst=streak(gs, lambda g: g["gf"] < g["ga"]), o3s=streak(gs, lambda g: g["gf"] + g["ga"] >= 3), bts=streak(gs, lambda g: g["gf"] > 0 and g["ga"] > 0))
json.dump(S, open(sys.argv[2], "w"), indent=1)
print({k: (s["form"], s["gf"], s["ga"]) for k, s in S.items()})
