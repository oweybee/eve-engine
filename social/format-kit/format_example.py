"""Predict the weekend and Streak watch, 23 Oct 2026. Data from matches/league_standings queried 23 Oct ~11:05.
  VOICE=script python3 fmt_23.py out23   -> writes <key>_script.txt + lines_<key>.json
  VOICE=astro  python3 fmt_23.py out23   -> needs <key>_astro.wav + <key>_astro.json"""
import json, os, sys, shutil
import numpy as np
from fmt_kit import Video, badge
from site_kit import trim, write_script, voice_segments
OUT = sys.argv[1]; os.makedirs(OUT, exist_ok=True); shutil.copy("onest.woff2", os.path.join(OUT, "onest.woff2"))
MODE = os.environ.get("VOICE", "script")

X = """
.fx{background:var(--s1);border-radius:26px;padding:16px 26px;margin-top:12px}
.fx .top{display:flex;justify-content:space-between;font-size:22px;color:var(--low);font-weight:600;letter-spacing:2px;text-transform:uppercase}
.fx .row{display:flex;align-items:center;gap:14px;margin-top:8px}
.fx .row .t{flex:1;font-size:34px;font-weight:700;white-space:nowrap}
.fx .row .p{font-size:24px;color:var(--low);width:56px}
.fx .row .sc{font-size:34px;font-weight:700;color:var(--g);width:40px;text-align:center}
.mini{display:flex;gap:6px}.mini b{width:38px;height:38px;border-radius:8px;display:grid;place-items:center;font-size:20px;font-weight:700}
.mini b.W{background:var(--gw);color:var(--g)}.mini b.D{background:var(--s3);color:var(--mid)}.mini b.L{background:rgba(255,60,70,.18);color:var(--redi)}
.stk{background:var(--s1);border-radius:30px;padding:24px 28px;margin-top:16px}
.stk .h{display:flex;align-items:center;gap:16px}
.stk .h b{font-size:38px;flex:1}.stk .h span{font-size:24px;color:var(--low)}
.stk .w{font-size:28px;color:var(--mid);margin-top:8px}
.stk .bx{display:flex;gap:8px;margin-top:14px}.stk .bx i{flex:1;height:30px;border-radius:8px;background:var(--s3)}
.stk .bx i.on{background:var(--g)}.stk .bx i.off{background:var(--s3)!important}.stk .bx i.red{background:var(--redi)}
.big{font-size:84px;font-weight:700;letter-spacing:-2px;line-height:1.04;margin-top:30px}.big em{font-style:normal;color:var(--g)}
.ask{font-size:76px;font-weight:700;letter-spacing:-1.5px;line-height:1.08}.ask em{font-style:normal;color:var(--g)}
"""
NAME = {"Bayern München": "Bayern", "Manchester United": "Man United", "Tottenham": "Spurs", "SC Freiburg": "Freiburg", "AS Roma": "Roma",
        "Borussia Mönchengladbach": "Gladbach", "FC Augsburg": "Augsburg"}
nm = lambda k: NAME.get(k, k)
FORM = {"Chelsea": "WWLDW", "Tottenham": "WDLLD", "Napoli": "WLLWD", "AS Roma": "WWLDD", "Liverpool": "WWWLW", "Brighton": "DWWWW",
        "SC Freiburg": "LLWWD", "Bayern München": "DWDDW", "Barcelona": "LWWWW", "Real Madrid": "WWWWL"}   # newest first
POS = {"Chelsea": "4th", "Tottenham": "16th", "Napoli": "9th", "AS Roma": "3rd", "Liverpool": "5th", "Brighton": "3rd",
       "SC Freiburg": "3rd", "Bayern München": "1st", "Barcelona": "1st", "Real Madrid": "3rd"}
FX = [("Sat 5pm", "Serie A", "Napoli", "AS Roma"), ("Sat 5:30pm", "Premier League", "Chelsea", "Tottenham"),
      ("Sun 2pm", "Premier League", "Liverpool", "Brighton"), ("Sun 4:30pm", "Bundesliga", "SC Freiburg", "Bayern München"),
      ("Sun 8pm", "La Liga", "Barcelona", "Real Madrid")]
head = lambda l: f'<div class="eyebrow">{l}</div>'
videos = []

# Predict the weekend
v = Video("predict_23", "Predict_the_weekend_23_Oct", "Predict the weekend · 24 to 25 Oct", X)
v.scene([("say", "Predict the weekend."), ("say", "Five big games. Drop your five scores in the comments, and we'll check them on Monday.")],
        lambda m, c: head("Predict the weekend") + '<div class="big" data-in=".05" data-pop>Five games. <em>Five scores.</em></div>'
        + f'<div class="follow" data-in="{m[1]:.2f}">Checked on Monday</div>')
def mini(k): return "".join(f'<b class="{x}">{x}</b>' for x in FORM[k][::-1])
def hp(m, c):
    cards = ""
    for j, (ko, lg, a, b) in enumerate(FX):
        rows = "".join(f'<div class="row"><span class="p">{POS[k]}</span>{badge(k, 44)}<span class="t">{nm(k)}</span><div class="mini">{mini(k)}</div><span class="sc">?</span></div>' for k in (a, b))
        cards += f'<div class="fx" data-in="{m[j]:.2f}"><div class="top"><span>{lg}</span><span>{ko}</span></div>{rows}</div>'
    return head("Last five, oldest to latest · league position") + cards
v.scene([("say", "Napoli against Roma. Roma are third, and have kept six clean sheets in their last ten."),
         ("say", "Chelsea against Spurs. Chelsea are fourth, Spurs sixteenth."),
         ("say", "Liverpool against Brighton. Brighton are unbeaten in eight."),
         ("say", "Freiburg against Bayern. Bayern are top, and unbeaten in ten."),
         ("say", "And the big one. Barcelona against Real Madrid, first against third."), ("pause", 1.2)], hp)
v.scene([("say", "Five scores, one comment."), ("say", "Best predictor gets a shout out on Monday.")],
        lambda m, c: head("Your call") + '<div class="ask" data-in=".05" data-pop>Your <em>five scores</em> in the comments.</div>'
        + f'<div class="follow" data-in="{m[1]:.2f}">Shout out on Monday</div>')
v.end_card(); videos.append(v)

# Streak watch
ST = [("Bayern München", "Unbeaten in 10", 10, "on", "Freiburg away, Sunday", "Bayern are unbeaten in ten. They go to Freiburg on Sunday."),
      ("Barcelona", "3 or more goals in 10 straight games", 10, "on", "Real Madrid, Sunday", "Barcelona games have had three or more goals ten times in a row. Real Madrid on Sunday."),
      ("FC Augsburg", "3 or more goals in 9 straight games", 9, "on", "Union Berlin, Saturday", "Augsburg. Three or more goals in nine straight games. Union Berlin on Saturday."),
      ("Manchester United", "No win in 7", 7, "red", "Bournemouth, Sunday", "Man United have gone seven without a win. Bournemouth on Sunday."),
      ("Borussia Mönchengladbach", "Lost 6 in a row", 6, "red", "Stuttgart away, tonight", "Gladbach have lost six in a row. They go to Stuttgart tonight.")]
v = Video("streak_23", "Streak_watch_23_Oct", "Streak watch · going into the weekend", X)
v.scene([("say", "Streak watch."), ("say", "Five runs going into the weekend. Which ones survive?")],
        lambda m, c: head("Streak watch") + '<div class="big" data-in=".05" data-pop>Five runs. <em>Which survive?</em></div>')
def hs(m, c):
    out = head("Last 10 games · current run")
    for j, (k, lab, n, col, nx, _) in enumerate(ST):
        bx = "".join((f'<i class="{col}" data-t="{m[j] + .3 + .05 * q:.2f}"></i>' if q < n else '<i class="off"></i>') for q in range(10))
        out += (f'<div class="stk" data-in="{m[j]:.2f}"><div class="h">{badge(k, 52)}<b>{nm(k)}</b><span>{nx}</span></div>'
                f'<div class="w">{lab}</div><div class="bx">{bx}</div></div>')
    return out
v.scene([("say", s[5]) for s in ST] + [("pause", 1.0)], hs)
v.scene([("say", "Which run breaks first?"), ("say", "Comment the club, and we'll check on Monday.")],
        lambda m, c: head("Your call") + '<div class="ask" data-in=".05" data-pop>Which run <em>breaks first?</em></div>'
        + f'<div class="follow" data-in="{m[1]:.2f}">Checked on Monday</div>')
v.end_card(); videos.append(v)

man = []
for v in videos:
    rec = []
    if MODE == "script":
        def voice(s): rec.append(s); return np.zeros(2400, np.float32)
        v.build(OUT, voice, "tiktok"); json.dump(rec, open(os.path.join(OUT, f"lines_{v.key}.json"), "w"))
        print(write_script(v.key, rec, OUT)); continue
    segs = iter(voice_segments(json.load(open(os.path.join(OUT, f"lines_{v.key}.json"))), v.key, OUT, "astro"))
    man.append(v.build(OUT, lambda s: next(segs), "tiktok"))
if man: json.dump({"videos": man}, open(os.path.join(OUT, "manifest.json"), "w"), indent=1); [print(x["out"], x["total"]) for x in man]
