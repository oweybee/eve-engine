"""Team hit-rate countdowns drawn as maxedge.live screens.
  python3 team_video.py script data.json outdir            -> <key>_script.txt per video (send each to Everygen in ONE call)
  python3 team_video.py build  data.json outdir astro      -> needs <key>_astro.wav + <key>_astro.json in outdir
  KOKORO_DIR=tts python3 team_video.py build data.json outdir kokoro   (free preview)
data.json:
{"date_label": "Thu 22 Oct",
 "videos": [{"key": "goals3_22", "file": "MaxEdge_3plus_Goals_22_Oct.mp4", "stat": "3plus" | "btts" | "under2",
   "hook": spoken+subtitled hook, number spelled out (e.g. "Fifteen from twenty with three or more goals. Guess the fixture."),
   "h1": on-screen headline (e.g. "3+ goals in 15 of their last 20"), "ask": closing question,
   "items": [ countdown order, #N first, #1 last:
     {"home": "Trabzonspor", "away": "Hearts", "comp": "Conference League", "ko": "17:45",
      "hg": "H|Besiktas|2-0|19 Oct;A|KuPS|2-4|15 Oct;...",   home side's last 10, NEWEST FIRST, score as home-away of that game
      "ag": "...",                                            away side's last 10
      optional: "home_say"/"away_say" (pronunciation, e.g. "N E C Nijmegen"), "layout"}]}]}
"""
import json, os, sys, shutil
import numpy as np, soundfile as sf
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from site_kit import CSS, JS, FIT, WORDMARK, tt_check, no_em, tick, hit, SR, plain, voice_segments, write_script, say_time, badge, END_LINES, END_CSS, add_end, write_cuts

HERE = os.path.dirname(os.path.abspath(__file__))
MODE, DATA, OUT = sys.argv[1], sys.argv[2], sys.argv[3]; os.makedirs(OUT, exist_ok=True)
VOICE_MODE = sys.argv[4] if len(sys.argv) > 4 else "kokoro"
D = json.load(open(DATA))
ONES = ("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen "
        "eighteen nineteen twenty").split()

STATS = {
 "3plus": dict(pred=lambda g: g["h"] + g["a"] >= 3, label="3+ goals", chip="3+ goals", line=3, bars=True),
 "btts": dict(pred=lambda g: g["h"] > 0 and g["a"] > 0, label="Both teams scored", chip="Both score", line=None, bars=False,
              legend=("Green: both scored", "Red: one side blank")),
 "under2": dict(pred=lambda g: g["h"] + g["a"] <= 2, label="2 goals or fewer", chip="2 or fewer", line=2, bars=True, under=True),
}
SHORT = {"Borussia Mönchengladbach": "Gladbach", "Borussia Monchengladbach": "Gladbach", "Paris Saint Germain": "PSG",
         "Heart Of Midlothian": "Hearts", "1899 Hoffenheim": "Hoffenheim", "Manchester United": "Man United", "Manchester City": "Man City"}

def parse(s):
    out = []
    for g in s.split(";"):
        ha, opp, sc, d = g.split("|"); h, a = map(int, sc.split("-"))
        out.append(dict(ha=ha, opp=SHORT.get(opp, opp).replace("ST ", "St "), sc=sc, h=h, a=a, d=d))
    if not 8 <= len(out) <= 10: raise ValueError(f"need 8 to 10 games, got {len(out)}: {s[:60]}")
    return out

def layouts(n, stat):
    top = "bars" if STATS[stat]["bars"] else "card"
    rest = {1: [], 2: ["pills"], 3: ["card", "results"], 4: ["pills", "card", "results"], 5: ["pills", "card", "results", "pills"]}[n]
    if top == "card": rest = [("results" if x == "card" else x) for x in rest]
    return rest + [top]

def prep(v):
    S = STATS[v["stat"]]; N = len(v["items"]); lays = layouts(N, v["stat"]); seen = set()
    for i, it in enumerate(v["items"]):
        it["hg_"], it["ag_"] = parse(it["hg"]), parse(it["ag"])
        it["tot"] = sum(map(S["pred"], it["hg_"])) + sum(map(S["pred"], it["ag_"])); it["n"] = len(it["hg_"]) + len(it["ag_"])
        it.setdefault("layout", lays[i])
        it.setdefault("home_say", plain(it["home"])); it.setdefault("away_say", plain(it["away"]))
        first = it["comp"] not in seen; seen.add(it["comp"])
        it.setdefault("comp_say", f"A {it['comp']} game" if first else f"{it['comp']} again")
        it.setdefault("ko_say", f"kicking off at {say_time(it['ko'])}")
    return S

def script(v):
    N = len(v["items"]); ls = [v["hook"]]
    for i, it in enumerate(v["items"]):
        rk = N - i
        if rk == 1: ls.append("One left.")
        ls.append(f"{'And number one.' if rk == 1 else f'Number {ONES[rk]}.'} {it['comp_say']}, {it['ko_say']}.")
        ls.append(f"It's {it['home_say']} against {it['away_say']}. {ONES[it['tot']].capitalize()} from {ONES[it['n']]}.")
    ls.append(f"{v['ask']} Comment the number.")
    return ls + END_LINES

COLS = {}
def crest(name, rel):
    """Hidden '?' disc, then the club-colour badge pops in on the reveal (rule, 22 Oct 2026)."""
    return f'<div class="crest"><span data-out="{rel:.2f}">?</span><span class="ci" data-in="{rel:.2f}" data-pop>{badge(name, 76, COLS.get(name))}</span></div>'

def teamname(name, rel, cls="tn"):
    w = min(320, 40 + 22 * len(name))
    return (f'<span class="{cls} who"><span class="mask" data-out="{rel:.2f}"><i style="width:{w}px"></i></span>'
            f'<span data-in="{rel:.2f}" data-pop>{name}</span></span>')

def oks(ts, games, pred): return [t for t, g in zip(ts, games) if pred(g)]

def boxrow(label, games, ts, pred):
    old = list(reversed(games))
    bx = "".join(f'<i class="{"" if pred(g) else "n"}" data-t="{t}"></i>' for t, g in zip(ts, old))
    return (f'<div class="run"><div class="rl"><span>{label}</span><b class="num" data-ticks="{json.dumps(oks(ts, old, pred))}" data-of="{len(old)}">0/{len(old)}</b></div>'
            f'<div class="bx">{bx}</div></div>')

def rkchip(rk, N): return f'<div class="rk1{" one" if rk == 1 else ""}" data-in=".0" data-pop>#{rk} {"of " + str(N) if rk > 1 else "The one"}</div>'

def lay_card(S, it, rel, rk, N, th, ta):
    p = S["pred"]; ok = oks(th, list(reversed(it["hg_"])), p) + oks(ta, list(reversed(it["ag_"])), p)
    return (rkchip(rk, N) + f'<div class="card hcx" data-in=".1"><div class="top"><div class="fx2">'
            f'<div class="sd">{crest(it["home"], rel)}{teamname(it["home"], rel)}</div>'
            f'<div class="sd">{crest(it["away"], rel)}{teamname(it["away"], rel)}</div></div>'
            f'<b class="dial" data-ticks="{json.dumps(ok)}" data-of="{it['n']}" data-fmt="pct">0%</b></div>'
            f'<span class="vsl">{S["label"]} · last 10 each</span>'
            f'<div class="bp"><b class="num" data-ticks="{json.dumps(ok)}" data-of="{it['n']}">0/{it['n']}</b><span>{S["label"]}</span></div>'
            + boxrow("Home side", it["hg_"], th, p) + boxrow("Away side", it["ag_"], ta, p) +
            f'<div class="hfoot"><b>Tonight {it["ko"]}</b>{it["comp"]}</div></div>')

def side_table(name, games, ts, pred, rel):
    rows = "".join(f'<tr data-row="{t}"><td class="op"><span class="ha">{g["ha"]}</span>{g["opp"]}</td><td class="r">'
                   f'<span class="{"ok" if pred(g) else "no"}">{g["sc"]}</span></td></tr>' for t, g in zip(ts, games))
    return (f'<div class="card half"><div class="rl"><span class="trunc">{teamname(name, rel, "tn sm")}</span><b class="num" data-ticks="{json.dumps(oks(ts, games, pred))}" data-of="{len(games)}">0/{len(games)}</b></div>'
            f'<table class="mini">{rows}</table></div>')

def lay_results(S, it, rel, rk, N, th, ta):
    return (rkchip(rk, N) + f'<h2 data-in=".05">Last 10 results</h2>'
            f'<div class="sub" data-in=".1">{it["comp"]} · Tonight {it["ko"]} · newest first</div>'
            f'<div class="two" data-in=".15">{side_table(it["home"], it["hg_"], th, S["pred"], rel)}{side_table(it["away"], it["ag_"], ta, S["pred"], rel)}</div>')

def goalchart(S, games, ts):
    old = list(reversed(games)); H = 250; mx = max(7, max(g["h"] + g["a"] for g in old))
    cols = "".join(f'<div class="col"><div class="v" data-vt="{t + .2}">{g["h"] + g["a"]}</div>'
                   f'<div class="b{"" if S["pred"](g) else " miss"}" data-grow="{t}" data-h="{max(6, int(H * (g["h"] + g["a"]) / mx))}"></div>'
                   f'<div class="o">{plain(g["opp"])[:3].upper()}</div></div>' for t, g in zip(ts, old))
    ln = S["line"] + (0.5 if S.get("under") else 0)
    lbl = f'{S["line"]} or fewer' if S.get("under") else f'{S["line"]}+'
    return f'<div class="chart" style="height:340px;margin-top:4px">{cols}<div class="ln" style="bottom:{int(H * ln / mx) + 46}px"><span>{lbl}</span></div></div>'

def lay_bars(S, it, rel, rk, N, th, ta):
    p = S["pred"]; okh = oks(th, list(reversed(it["hg_"])), p); oka = oks(ta, list(reversed(it["ag_"])), p)
    return (rkchip(rk, N) + f'<div class="sub" data-in=".05" style="margin-top:0">Total goals per game, oldest first · {it["comp"]} · {it["ko"]}</div>'
            f'<div class="card" data-in=".1" style="margin-top:14px;padding:22px 28px"><div class="rl">{teamname(it["home"], rel, "tn sm")}<b class="num" data-ticks="{json.dumps(okh)}" data-of="{len(okh) if False else len(it['hg_'])}">0/{len(it['hg_'])}</b></div>{goalchart(S, it["hg_"], th)}</div>'
            f'<div class="card" data-in=".15" style="margin-top:16px;padding:22px 28px"><div class="rl">{teamname(it["away"], rel, "tn sm")}<b class="num" data-ticks="{json.dumps(oka)}" data-of="{len(it['ag_'])}">0/{len(it['ag_'])}</b></div>{goalchart(S, it["ag_"], ta)}</div>')

def lay_pills(S, it, rel, rk, N, th, ta):
    p = S["pred"]; ho, ao = list(reversed(it["hg_"])), list(reversed(it["ag_"]))
    pills = lambda games, ts: "".join(f'<i class="{"" if p(g) else "n"}" data-t="{t}">{g["sc"]}</i>' for t, g in zip(ts, games))
    leg = S.get("legend", (f"Green: {S['label'].lower()}", "Red: not"))
    return (rkchip(rk, N) + f'<div class="card fxc" data-in=".1"><div class="lg"><span>{it["comp"]}</span><span>Tonight {it["ko"]}</span></div>'
            f'<div class="club">{crest(it["home"], rel)}{teamname(it["home"], rel)}</div><div class="club">{crest(it["away"], rel)}{teamname(it["away"], rel)}</div></div>'
            f'<div class="card" data-in=".15" style="margin-top:18px"><div class="rl"><span>Home side · scores, oldest first</span><b class="num" data-ticks="{json.dumps(oks(th, ho, p))}" data-of="{len(ho)}">0/{len(ho)}</b></div>'
            f'<div class="frm sc">{pills(ho, th)}</div>'
            f'<div class="rl" style="margin-top:26px"><span>Away side</span><b class="num" data-ticks="{json.dumps(oks(ta, ao, p))}" data-of="{len(ao)}">0/{len(ao)}</b></div>'
            f'<div class="frm sc">{pills(ao, ta)}</div><div class="hfoot"><b>{leg[0]}</b>{leg[1]}</div></div>')

LAYOUTS = dict(card=lay_card, results=lay_results, bars=lay_bars, pills=lay_pills)

EXTRA_CSS = """
.bx i.n.on{background:var(--red)}.prow .dash i.n.on{background:var(--red)}
.frm i.n.on{background:rgba(255,60,70,.18);color:var(--redi)}
.chart .b.miss{background:var(--redi)}
.fx2{display:flex;flex-direction:column;gap:16px;min-width:0;flex:1}
.sd{display:flex;align-items:center;gap:18px;font-size:56px;font-weight:700;letter-spacing:-1px}
.crest{position:relative;flex:none;width:76px;height:76px}.crest span{position:absolute;inset:0;display:grid;place-items:center}.crest .ci{color:var(--mid)}
.crest>span:first-child{color:var(--g);font-size:30px}
.tn{position:relative;display:inline-block;min-height:56px;white-space:nowrap}.tn .mask{top:4px}.tn .mask i{height:48px}
.tn.sm{font-size:30px;font-weight:700;color:#fff;min-height:38px}.tn.sm .mask i{height:34px;width:200px!important}
.half{flex:1;min-width:0;padding:22px 22px!important}.trunc{min-width:0;overflow:hidden}
table.mini td{font-size:27px;padding:14px 4px}table.mini td.op{max-width:250px;overflow:hidden;text-overflow:ellipsis}
.ha{width:30px;font-size:18px}
.no{display:inline-block;background:rgba(255,60,70,.18);color:var(--redi);border-radius:8px;padding:2px 12px;font-weight:700}.ok{padding:2px 12px}
.bp b{font-size:120px}
.hcx{padding:40px 40px!important}.hcx .run{margin-top:40px}.hcx .bx i{height:60px;border-radius:10px}.hcx .hfoot{margin-top:44px}
.prow{padding:40px 30px}.prow .dash i{width:12px;height:12px}.prow .av{width:76px;height:76px}.prow .fx{font-size:26px}
.fxc .club{font-size:52px;margin-top:28px}.frm.sc i{height:76px;font-size:24px}.res .r{padding:32px 30px}
"""
JS2 = JS.replace("k+'/'+ts.length", "k+'/'+(c.dataset.of||ts.length)").replace("Math.round(k/ts.length*100)", "Math.round(k/(+(c.dataset.of)||ts.length)*100)")

def build(v):
    for it in v["items"]: COLS[it["home"]] = it.get("home_col"); COLS[it["away"]] = it.get("away_col")
    S = prep(v); ls = script(v); segs = iter(voice_segments(ls, v["key"], OUT, VOICE_MODE))
    N = len(v["items"]); audio = np.zeros(int(300 * SR), np.float32); subs, scenes = [], []
    def put(t, a): i = int(t * SR); audio[i:i + len(a)] += a
    def say(t0, cap):
        a = next(segs); put(t0, a); d = len(a) / SR
        ws = cap.split(); cs = [" ".join(ws[i:i + 4]) for i in range(0, len(ws), 4)]; L = sum(map(len, cs)); c = t0
        for x in cs: dd = d * len(x) / L; subs.append([round(c, 3), round(c + dd, 3), x]); c += dd
        return d
    d = say(0, v["hook"]); end = max(d + .5, 3.6)
    chips = "".join(f'<div class="chip{" on" if c == S["chip"] else ""}">{c}</div>' for c in ["Goals", "3+ goals", "Both score", "2 or fewer"])
    rows = ""
    for i, it in enumerate(reversed(v["items"])):
        both = list(reversed(it["hg_"])) + list(reversed(it["ag_"]))
        ts = [round(.5 + i * .15 + k * .07, 2) for k in range(len(both))]
        dash = "".join(f'<i class="{"" if S["pred"](g) else "n"}" data-t="{t}"></i>' for t, g in zip(ts, both))
        rows += (f'<div class="prow" data-row="{.15 + i * .1:.2f}"><div class="rk">{i + 1}</div><div class="av">?</div><div class="tx">'
                 f'<div class="nm"><i style="width:170px"></i><i style="width:30px;background:none"></i><i style="width:150px"></i></div><div class="fx">{it["comp"]} · {it["ko"]}</div>'
                 f'<div class="dash">{dash}</div></div><div class="pill num" data-ticks="{json.dumps(oks(ts, both, S["pred"]))}" data-of="{it['n']}">0/{it['n']}</div></div>')
    scenes.append((0, end, f'<div class="eyebrow">Hit rates · Tonight</div><h1 style="margin-top:12px">{v["h1"]}</h1>'
                   f'<div class="chips">{chips}</div><div class="seg"><span>Last 5</span><span class="on">Last 10</span></div><div class="plist">{rows}</div>'))
    t = end
    for i, it in enumerate(v["items"]):
        rk = N - i
        if rk == 1:
            t0 = t + .1; d = say(t0 + .1, "One left."); e = t0 + max(1.5, d + .5)
            scenes.append((t0, e, '<div class="beat" data-in=".0"><div class="one">#1</div><div class="s">One left.</div></div>')); t = e
        s0 = t + .1
        d1 = say(s0 + .05, f"#{rk}. {it['comp']}, {it['ko']}.")
        f0 = max(.7, d1 * .45); step = .14
        nh, na = len(it["hg_"]), len(it["ag_"])
        th = [round(f0 + k * step, 3) for k in range(nh)]; ta = [round(f0 + (nh + k) * step, 3) for k in range(na)]
        rel = max(d1 + .1, ta[-1] + .5)
        html = LAYOUTS[it["layout"]](S, it, rel, rk, N, th, ta)
        for k, x in enumerate(th + ta): put(s0 + x, tick(1200 + 25 * k))
        put(s0 + rel, hit())
        d2 = say(s0 + rel + .12, f"{it['home']} v {it['away']}. {it['tot']} from {it['n']}.")
        e = s0 + rel + .12 + d2 + .6
        scenes.append((s0, e, html)); t = e
    s0 = t + .1; d = say(s0 + .05, v["ask"])
    opts = "".join(f'<div class="r" data-row="{.2 + k * .08:.2f}"><div class="n">{k + 1}</div><div class="tx"><b>{it["home"]} v {it["away"]}</b><s>{it["comp"]} · {it["ko"]}</s></div>'
                   f'<div class="pill num">{it["tot"]}/{it["n"]}</div></div>' for k, it in enumerate(reversed(v["items"])))
    scenes.append((s0, s0 + max(3.6, d + .9), f'<div class="eyebrow">Comment the number</div><h1 style="margin-top:12px">{v["ask"]}</h1>'
                   f'<div class="res">{opts}</div><div class="follow" data-in="{.3 + N * .08:.2f}">Follow for tomorrow\'s countdown</div>'))
    texts = [x for _, _, x in scenes] + [x[2] for x in subs] + ls[:-len(END_LINES)]
    no_em(*texts); tt_check(*[plain(x) for x in texts])
    fin = add_end(scenes, say, scenes[-1][1])
    page = lambda body, total, subs: (f'<!doctype html><html><head><meta charset="utf-8"><style>{CSS}{EXTRA_CSS}{END_CSS}</style></head><body><div class="bar">{WORDMARK}</div>'
            f'{body}<div class="subs"><span id="sb"></span></div>'
            f'<div class="foot"><span>{D["date_label"]} · Last 10 games each side</span><span id="sn"></span></div><div class="prog"><i id="pg"></i></div>'
            f'<script>window.TOTAL={total};window.SUBS={json.dumps(subs)};</script>{FIT}{JS2}</body></html>')
    return write_cuts(OUT, v["key"], v["file"], scenes, subs, audio, fin, page)

if __name__ == "__main__":
    shutil.copy(os.path.join(HERE, "onest.woff2"), os.path.join(OUT, "onest.woff2"))
    if MODE == "script":
        for v in D["videos"]:
            prep(v); print(write_script(v["key"], script(v), OUT))
    else:
        man = [m for v in D["videos"] for m in build(v)]
        json.dump({"videos": man}, open(os.path.join(OUT, "manifest.json"), "w"), indent=1)
        for m in man: print(m["out"], m["total"])
