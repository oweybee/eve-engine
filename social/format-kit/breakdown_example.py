"""Match breakdown: Bournemouth v AC Milan, Thu 22 Oct 20:00 (Europa League). Free Kokoro voice.
  KOKORO_DIR=../vid/tts python3 bd_bou_mil.py S.json bd_out"""
import json, os, sys, shutil
import numpy as np
from fmt_kit import Video, badge
from site_kit import trim
S = json.load(open(sys.argv[1])); OUT = sys.argv[2]; os.makedirs(OUT, exist_ok=True)
shutil.copy("onest.woff2", os.path.join(OUT, "onest.woff2"))
MODE = os.environ.get("VOICE", "script")
_rec = []
if MODE == "kokoro":
    from kokoro_onnx import Kokoro
    K = Kokoro(os.path.join(os.environ["KOKORO_DIR"], "kokoro.onnx"), os.path.join(os.environ["KOKORO_DIR"], "voices.bin"))
    def voice(s): return trim(K.create(s, voice="bm_lewis", speed=1.0, lang="en-gb")[0].astype(np.float32))
elif MODE == "script":
    def voice(s): _rec.append(s); return np.zeros(2400, np.float32)
else:
    from site_kit import voice_segments
    _lines = json.load(open(os.path.join(OUT, "lines.json")))
    _segs = iter(voice_segments(_lines, "bd_bou_mil", OUT, "astro"))
    def voice(s): return next(_segs)

A, B = "Bournemouth", "AC Milan"; AN, BN = "Bournemouth", "AC Milan"
EU = {A: [("17 Sep", "at Real Sociedad", 2, 1), ("15 Oct", "v Sturm Graz", 3, 0)],
      B: [("16 Sep", "v Benfica", 0, 2), ("15 Oct", "at Red Bull Salzburg", 4, 0)]}   # matches table
OUT_ = {A: ["Kroupi (foot)", "Alex Scott (thigh)", "Julian Araujo (thigh)"],
        B: ["Gabbia (thigh)", "Saelemaekers (ankle)", "Goncalo Ramos (calf)", "Chukwueze (hip)", "Terracciano (suspended)"]}  # player_injuries 22 Oct + team news
PLAYERS = [("Evanilson", A, 3, 2, 5, 7), ("Rayan", A, 3, 0, 6, 7), ("Diego Moreira", B, 3, 1, 3, 6), ("Alphadjo Cisse", B, 3, 0, 1, 2)]
X = """
.vsh{display:flex;align-items:center;justify-content:space-between;margin-top:36px}
.vsh .t{text-align:center;width:44%}.vsh .t .badge{margin:0 auto}
.vsh .n{font-size:54px;font-weight:700;margin-top:18px}
.vsh .v{font-size:40px;color:var(--low);font-weight:700}
.hook{font-size:70px;font-weight:700;letter-spacing:-1.5px;line-height:1.08;margin-top:46px}.hook em{font-style:normal;color:var(--g)}
.tbl{margin-top:30px;background:var(--s1);border-radius:36px;overflow:hidden}
.tbl .r{display:flex;align-items:center;gap:22px;padding:26px 30px;border-top:2px solid var(--line);font-size:40px;font-weight:700}
.tbl .r:first-child{border-top:none}.tbl .r .p{width:70px;color:var(--low);font-size:34px}.tbl .r .nm{flex:1}.tbl .r .pt{color:var(--g)}
.tbl .r.dim{opacity:.35;font-size:30px;padding:14px 30px}
.rec{display:flex;gap:16px;margin-top:28px}.rec div{flex:1;background:var(--s1);border-radius:30px;padding:26px 10px;text-align:center}
.rec b{display:block;font-size:110px;font-weight:700;letter-spacing:-3px;line-height:1;color:var(--g)}.rec b.d{color:var(--mid)}
.rec span{display:block;font-size:24px;font-weight:600;letter-spacing:2px;color:var(--low);margin-top:10px;text-transform:uppercase}
.ml{margin-top:22px;background:var(--s1);border-radius:30px;overflow:hidden}
.ml .r{display:flex;align-items:center;gap:18px;padding:14px 26px;border-top:2px solid var(--line);font-size:30px}
.ml .r:first-child{border-top:none}.ml .k{width:200px;color:var(--low);font-size:24px}.ml .s{flex:1;font-weight:700;white-space:nowrap}
.ml .s em{font-style:normal;color:var(--g);margin:0 12px}
.tot{display:flex;gap:16px;margin-top:22px}.tot .card{flex:1;padding:24px 28px}.tot h2{font-size:76px;margin-top:4px}
.gp{background:var(--s1);border-radius:28px;padding:22px 26px;margin-top:16px}
.gp .h{display:flex;justify-content:space-between;align-items:center;font-size:32px;font-weight:700}.gp .h .c{color:var(--g)}
.gp .l{font-size:22px;letter-spacing:2px;color:var(--low);font-weight:600;margin:6px 0 12px;text-transform:uppercase}
.gp .bx i{height:40px;transform:scale(.85)}.gp .bx i.on[data-on="1"]{background:var(--g)}.gp .bx i.on[data-on="0"]{background:var(--s3)}
.pl{background:var(--s1);border-radius:28px;padding:22px 28px;margin-top:14px;display:flex;align-items:center;gap:22px}
.pl .tx{flex:1}.pl .n{font-size:38px;font-weight:700}.pl .st{display:flex;gap:26px;margin-top:6px;font-size:26px;color:var(--low)}
.pl .st b{color:var(--g);font-size:38px;margin-right:6px}
.ask{font-size:76px;font-weight:700;letter-spacing:-1.5px;line-height:1.08}.ask em{font-style:normal;color:var(--g)}

.eu{background:var(--s1);border-radius:30px;padding:22px 26px;margin-top:18px}
.eu .h{display:flex;align-items:center;gap:16px;font-size:40px;font-weight:700}
.eu .r{display:flex;align-items:center;gap:16px;font-size:32px;margin-top:14px}
.eu .r .k{width:130px;color:var(--low);font-size:26px}.eu .r .s{flex:1}
.eu .r .res{border-radius:12px;padding:4px 14px;font-weight:700;font-size:26px}
.big2{font-size:64px;font-weight:700;letter-spacing:-1.5px;line-height:1.08;margin-top:30px}.big2 em{font-style:normal;color:var(--g)}
.out{background:var(--s1);border-radius:28px;padding:22px 26px;margin-top:16px}
.out .h{display:flex;align-items:center;gap:16px;font-size:38px;font-weight:700}
.out ul{margin:12px 0 0;padding:0;list-style:none;font-size:30px;color:var(--mid)}.out li{padding:6px 0}
"""

v = Video("bd_bou_mil", "Breakdown_Bournemouth_v_AC_Milan", "Match breakdown · Bournemouth v AC Milan · Thu 22 Oct", X)
def head(lbl): return f'<div class="eyebrow">{lbl}</div>'

v.scene([("say", "Bournemouth against AC Milan. Tonight, eight o'clock."), ("say", "Bournemouth's first ever European campaign, and they've won both games.")],
        lambda m, c: head("Europa League · Thursday 22 Oct · 8pm")
        + f'<div class="vsh"><div class="t"><div data-spin="0.05">{badge(A, 170)}</div><div class="n" data-in=".3">{AN}</div></div><div class="v" data-in=".5" data-pop>V</div><div class="t"><div data-spin=".35">{badge(B, 170)}</div><div class="n" data-in=".6">{BN}</div></div></div>'
        + f'<div class="hook" data-in="{m[1]:.2f}" data-pop>Bournemouth: <em><span data-count="2" data-in="{m[1]:.2f}">2</span> from 2</em> in Europe.</div>')

def eu(k, nmx, d):
    rr = ""
    for i, (dt, opp, a, b) in enumerate(EU[k]):
        r = "W" if a > b else "D" if a == b else "L"
        bg = "var(--g)" if r == "W" else "var(--s3)" if r == "D" else "var(--redi)"
        fg = "var(--plate)" if r == "W" else "#fff"
        rr += f'<div class="r" data-row="{d + .2 + i * .2:.2f}"><span class="k">{dt}</span><span class="res" style="background:{bg};color:{fg}">{r}</span><span class="s"><b>{a}-{b}</b> {opp}</span></div>'
    return f'<div class="eu" data-in="{d:.2f}"><div class="h"><span data-spin="{d:.2f}">{badge(k, 64)}</span>{nmx}</div>{rr}</div>'
v.scene([("say", "Europe so far. Bournemouth won in San Sebastian, then beat Sturm Graz three nil."),
         ("say", "Milan lost to Benfica, then won four nil in Salzburg."),
         ("say", "And Milan have won just two of their twenty two European games in England.")],
        lambda m, c: head("Europa League · so far") + eu(A, AN, .2) + eu(B, BN, m[1])
        + f'<div class="big2" data-in="{m[2]:.2f}" data-pop>Milan in England: <em><span data-count="2" data-in="{m[2]:.2f}">2</span> wins in 22.</em></div>')

def form_scene(k, nmx, say1):
    gs = S[k]["games"][:5]
    rr = "".join(f'<div class="r" data-row="{.35 + i * .16:.2f}"><span class="k">{g["d"]}</span><span class="s">'
                 f'<span class="lvl" style="padding:4px 14px;font-size:24px;margin-right:12px;background:{"var(--g)" if g["gf"] > g["ga"] else "var(--s3)" if g["gf"] == g["ga"] else "var(--redi)"};color:{"var(--plate)" if g["gf"] != g["ga"] else "#fff"}">{"W" if g["gf"] > g["ga"] else "D" if g["gf"] == g["ga"] else "L"}</span>'
                 f'{g["gf"]}-{g["ga"]} <span style="color:var(--low);font-weight:500">{"v" if g["ha"] == "H" else "at"} {g["opp"]}</span></span></div>' for i, g in enumerate(gs))
    return ([("say", say1), ("say", f"{S[k]['gf']} scored, {S[k]['ga']} conceded in their last ten.")],
            lambda m, c: head("Form · last 5, newest first") + f'<div class="club" style="margin-top:14px"><span data-spin="0">{badge(k, 90)}</span>{nmx}</div><div class="ml">{rr}</div>'
            + f'<div class="tot" data-in="{m[1]:.2f}"><div class="card"><div class="eyebrow">Scored in 10</div><h2 data-count="{S[k]["gf"]}" data-in="{m[1]:.2f}">{S[k]["gf"]}</h2></div>'
            f'<div class="card"><div class="eyebrow">Conceded in 10</div><h2 data-count="{S[k]["ga"]}" data-in="{m[1] + .2:.2f}">{S[k]["ga"]}</h2></div></div>')
w5 = lambda k: sum(g["gf"] > g["ga"] for g in S[k]["games"][:5])
W = "none one two three four five".split()
pl = lambda n: f"{W[n]} win" if n == 1 else f"{W[n]} wins"
w5 = lambda k: sum(g["gf"] > g["ga"] for g in S[k]["games"][:5])
W = "none one two three four five".split()
pl = lambda n: f"{W[n]} win" if n == 1 else f"{W[n]} wins"
v.scene(*form_scene(A, AN, f"Bournemouth. {pl(w5(A)).capitalize()} from their last five, including two clean sheets in a row."))
v.scene(*form_scene(B, BN, f"Milan. {pl(w5(B)).capitalize()} from their last five, and they beat Atalanta at the weekend."))

def seq(k, f): return [f(g) for g in S[k]["games"][::-1]]
def gp(k, nmx, lab, f, d):
    s = seq(k, f); bx = "".join(f'<i data-t="{d + .25 + .07 * i:.2f}" class="lit" data-on="{1 if x else 0}"></i>' for i, x in enumerate(s))
    return f'<div class="gp" data-in="{d:.2f}"><div class="h"><span>{nmx}</span><span class="c"><span data-count="{sum(s)}" data-in="{d + .25:.2f}">{sum(s)}</span>/10</span></div><div class="l">{lab}</div><div class="bx">{bx}</div></div>'
o3 = lambda g: g["gf"] + g["ga"] >= 3; bt = lambda g: g["gf"] > 0 and g["ga"] > 0
c3 = sum(seq(A, o3)) + sum(seq(B, o3)); cb = sum(seq(A, bt)) + sum(seq(B, bt))
v.scene([("say", f"Goals. Three or more in {c3} of their twenty recent games."), ("say", f"Both teams scored in {cb} of twenty.")],
        lambda m, c: head("Goals · last 10, oldest to newest") + gp(A, AN, "3+ goals in the game", o3, .2) + gp(B, BN, "3+ goals in the game", o3, .35)
        + gp(A, AN, "Both teams scored", bt, m[1]) + gp(B, BN, "Both teams scored", bt, m[1] + .15))

def outcard(k, nmx, d):
    li = "".join(f'<li data-row="{d + .15 + i * .1:.2f}">{p}</li>' for i, p in enumerate(OUT_[k]))
    return f'<div class="out" data-in="{d:.2f}"><div class="h"><span data-spin="{d:.2f}">{badge(k, 60)}</span>{nmx}</div><ul>{li}</ul></div>'
v.scene([("say", "Team news. Bournemouth are without Kroupi, Alex Scott and Araujo."),
         ("say", "Milan are missing Gabbia, Saelemaekers, Ramos and Chukwueze, and Terracciano is suspended.")],
        lambda m, c: head("Team news · out") + '<h1 style="margin-top:14px">Who is missing.</h1>' + outcard(A, AN, .3) + outcard(B, BN, m[1]))

cards = "".join(f'<div class="pl" data-row="{.5 + i * .35:.2f}"><span data-spin="{.5 + i * .35:.2f}">{badge(t, 64)}</span><div class="tx"><div class="n">{n}</div><div class="st"><span><b data-count="{g}" data-in="{.7 + i * .35:.2f}">{g}</b>goals</span>'
                f'<span><b data-count="{a}" data-in="{.8 + i * .35:.2f}">{a}</b>assists</span><span><b>{gm}</b>games</span></div></div></div>' for i, (n, t, g, a, so, gm) in enumerate(PLAYERS))
v.scene([("say", "In form. Evanilson, three goals and two assists in his last seven."),
         ("say", "For Milan, Alphadjo Cisse scored a hat-trick in Salzburg last week.")],
        lambda m, c: head("In form · their last games") + '<h1 style="margin-top:14px">The in-form men.</h1>' + cards)

v.scene([("say", "Three from three for Bournemouth, or do Milan finally win in England?"), ("say", "Drop your score in the comments.")],
        lambda m, c: head("Your call") + '<div class="ask" data-in=".05" data-pop>Three from three for Bournemouth, or do Milan <em>finally win in England?</em></div>'
        + '<div class="follow" data-in=".6">Your score in the comments</div>')
v.end_card()

man = {"videos": [v.build(OUT, voice, "tiktok")]}
if MODE == "script":
    from site_kit import write_script
    json.dump(_rec, open(os.path.join(OUT, "lines.json"), "w")); print(write_script("bd_bou_mil", _rec, OUT)); sys.exit()
json.dump(man, open(os.path.join(OUT, "manifest.json"), "w"), indent=1)
for x in man["videos"]: print(x["out"], x["total"])
