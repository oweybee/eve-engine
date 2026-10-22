"""Football quiz drawn as maxedge.live screens.
  python3 quiz_video.py script quiz.json outdir      -> <key>_script.txt (ONE Everygen call)
  python3 quiz_video.py build  quiz.json outdir astro
quiz.json: {"key","file","date_label","subtitle","questions":[{"level": EASY|MEDIUM|HARD|KNOWS BALL, "shown","spoken",
  "options":[3], "correct": index, "reveal_shown","reveal_spoken"} x8], "bonus":{"clues":[3 lines],"say": spoken, ends "Who is he?"}}
Every spoken string must end in . ? or ! and contain no abbreviations with full stops (sentence count must match Everygen's).
Answers must be checked against matches and raw player_match_stats rows (deduped) before building.
"""
import json, os, re, sys, shutil
import numpy as np, soundfile as sf
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from site_kit import CSS, JS, FIT, WORDMARK, tt_check, no_em, SR, plain, nsent, voice_segments, write_script

HERE = os.path.dirname(os.path.abspath(__file__))
MODE, DATA, OUT = sys.argv[1], sys.argv[2], sys.argv[3]; os.makedirs(OUT, exist_ok=True)
VOICE_MODE = sys.argv[4] if len(sys.argv) > 4 else "kokoro"

D = json.load(open(DATA)); KEY = D["key"]
Q = [(q["level"], q["shown"], q["spoken"], q["options"], q["correct"], q["reveal_shown"], q["reveal_spoken"]) for q in D["questions"]]
BONUS_CLUES = D["bonus"]["clues"]; BONUS_SAY = D["bonus"]["say"]
HOOK_SAY = "Eight questions on tonight's football. Easy to knows ball. Keep score."
END_SAY = "Drop your guess in the comments. And your score out of eight."
LV = {"EASY": "l1", "MEDIUM": "l2", "HARD": "l3", "KNOWS BALL": "l4"}
THINK = 3.0

def lines():
    out = [HOOK_SAY]
    for q in Q: out += [q[2], q[6]]
    return out + [BONUS_SAY, END_SAY]

def tick(f=1500, d=.05):
    x = np.arange(int(d * SR)) / SR; return (0.22 * np.sin(2 * np.pi * f * x) * np.exp(-x * 60)).astype(np.float32)
def ding():
    x = np.arange(int(.35 * SR)) / SR
    return (0.18 * (np.sin(2 * np.pi * 880 * x) + .6 * np.sin(2 * np.pi * 1320 * x)) * np.exp(-x * 9)).astype(np.float32)

QCSS = """
.lvl{display:inline-block;border-radius:999px;padding:10px 24px;font-size:28px;font-weight:700;letter-spacing:2px;color:var(--plate)}
.l1{background:#D9F7C8}.l2{background:#C2F0A8}.l3{background:#A9EB87}.l4{background:#99EC72}
.qn{font-size:28px;color:var(--low);font-weight:600;margin-left:16px}
.qq{font-size:72px;font-weight:700;letter-spacing:-1.5px;line-height:1.08;margin-top:30px}
.ops{margin-top:40px;background:var(--s1);border-radius:36px;overflow:hidden}
.op{display:flex;align-items:center;gap:26px;padding:30px 32px;border-top:2px solid var(--line);font-size:46px;font-weight:700;transition:none}
.op:first-child{border-top:none}
.op .n{flex:none;width:68px;height:68px;border-radius:50%;background:var(--s2);display:grid;place-items:center;font-size:30px;color:var(--mid)}
.op .ck{margin-left:auto;opacity:0;background:var(--gw);color:var(--g);border-radius:999px;padding:6px 20px;font-size:28px}
.op.yes.on{background:var(--gw);color:var(--g)}.op.yes.on .n{background:var(--g);color:var(--plate)}.op.yes.on .ck{opacity:1}
.op.nah.on{opacity:.3}
.timer{margin-top:34px;display:flex;align-items:center;gap:22px}
.tm{flex:1;height:14px;border-radius:7px;background:var(--track);overflow:hidden}.tm i{display:block;height:100%;background:var(--g);width:100%}
.cd{width:60px;text-align:right;font-size:44px;font-weight:700;color:var(--g)}
.ans{margin-top:28px;opacity:0}.ans.on{opacity:1}
.ans .card{padding:26px 32px}.ans b{display:block;font-size:44px;margin-top:8px;color:#fff}
.ladder{display:flex;gap:12px;margin-top:34px;flex-wrap:wrap}
.score{margin-top:40px;display:flex;gap:18px}.score .card{flex:1}.score h2{font-size:84px;margin-top:6px}
.bq{font-size:96px;font-weight:700;letter-spacing:-2px;margin-top:22px}
.mystery{display:flex;align-items:center;gap:28px}
.sil{flex:none;width:150px;height:150px;border-radius:50%;background:var(--s2);display:grid;place-items:center;font-size:80px;font-weight:700;color:var(--g)}
.clue{display:flex;align-items:center;gap:22px;padding:28px 32px;border-top:2px solid var(--line);font-size:38px;font-weight:600}
.clue:first-child{border-top:none}.clue i{flex:none;width:18px;height:18px;border-radius:50%;background:var(--g)}
"""
QJS = """<script>(function(){const base=render;render=function(t){base(t);
document.querySelectorAll('.scene').forEach(s=>{const l=t-(+s.dataset.s);
 s.querySelectorAll('[data-r]').forEach(e=>e.classList.toggle('on',l>=+e.dataset.r));
 s.querySelectorAll('.tm').forEach(e=>{const a=+e.dataset.a,d=+e.dataset.dur,k=Math.min(1,Math.max(0,(l-a)/d));e.firstChild.style.width=(100*(1-k))+'%';});
 s.querySelectorAll('.cd').forEach(e=>{const a=+e.dataset.a,d=+e.dataset.dur;const r=Math.ceil(d-(l-a));e.textContent=l<a?'':(r>0?r:'');});
});};render(0);})();</script>"""

def build():
    ls = lines(); segs = iter(voice_segments(ls, KEY, OUT, VOICE_MODE))
    audio = np.zeros(int(200 * SR), np.float32); subs, scenes = [], []
    def put(t, a): i = int(t * SR); audio[i:i + len(a)] += a
    def say(t0, cap=None):
        a = next(segs); put(t0, a); d = len(a) / SR
        if cap:
            ws = cap.split(); cs = [" ".join(ws[i:i + 4]) for i in range(0, len(ws), 4)]; L = sum(map(len, cs)); c = t0
            for x in cs: dd = d * len(x) / L; subs.append([round(c, 3), round(c + dd, 3), x]); c += dd
        return d
    d = say(0, "8 questions on tonight's football. Keep score."); end = max(d + .4, 3.4)
    ladder = "".join(f'<div class="lvl {c}">{k}</div>' for k, c in LV.items())
    scenes.append((0, end, f'<div class="eyebrow">Quiz · {D["date_label"]} · {D["subtitle"]}</div>'
                   f'<h1 style="margin-top:14px;font-size:80px">8 questions on tonight\'s football. Keep score.</h1>'
                   f'<div class="ladder">{ladder}</div>'
                   f'<div class="score"><div class="card"><div class="eyebrow">Your score</div><h2 class="num">0/8</h2></div>'
                   f'<div class="card"><div class="eyebrow">Bonus</div><h2>Who is he?</h2></div></div>'))
    t = end
    for i, (lv, qd, qs, ops, ok, rvd, rvs) in enumerate(Q):
        st = t + .1
        d = say(st + .05)
        ta = d + .25
        for k in range(int(THINK)): put(st + ta + k, tick())
        rv = ta + THINK
        put(st + rv, ding())
        d2 = say(st + rv + .1, rvd)
        en = st + rv + .1 + d2 + .8
        opts = "".join(f'<div class="op {"yes" if j == ok else "nah"}" data-in="{.25 + j * .08:.2f}" data-r="{rv:.2f}"><span class="n">{"ABC"[j]}</span>{o}<span class="ck">✓</span></div>'
                       for j, o in enumerate(ops))
        scenes.append((st, en, f'<div data-in=".0" data-pop><span class="lvl {LV[lv]}">{lv}</span><span class="qn">{i + 1} / 8</span></div>'
                       f'<div class="qq fit2" data-in=".08">{qd}</div><div class="ops">{opts}</div>'
                       f'<div class="timer"><div class="tm" data-a="{ta:.2f}" data-dur="{THINK}"><i></i></div><div class="cd" data-a="{ta:.2f}" data-dur="{THINK}"></div></div>'
                       f'<div class="ans" data-r="{rv:.2f}"><div class="card"><div class="eyebrow">Answer</div><b>{rvd}</b></div></div>'))
        t = en
    st = t + .1; d = say(st + .05, "Bonus. Who is he?"); ta = d + .2
    for k in range(int(THINK)): put(st + ta + k, tick(1100))
    en = st + ta + THINK + .3
    clues = "".join(f'<div class="clue" data-in="{.5 + k * .5:.2f}"><i></i>{c}</div>' for k, c in enumerate(BONUS_CLUES))
    scenes.append((st, en, f'<div data-in=".0" data-pop><span class="lvl l4">BONUS · NO ANSWER</span></div>'
                   f'<div class="mystery" data-in=".1" style="margin-top:30px"><div class="sil">?</div><div class="bq">Who is he?</div></div>'
                   f'<div class="ops" style="margin-top:36px">{clues}</div>'
                   f'<div class="timer"><div class="tm" data-a="{ta:.2f}" data-dur="{THINK}"><i></i></div><div class="cd" data-a="{ta:.2f}" data-dur="{THINK}"></div></div>'))
    t = en
    st = t + .1; d = say(st + .05, "Your guess. Your score out of 8."); en = st + d + 1.4
    scenes.append((st, en, f'<div class="eyebrow">Comment below</div><h1 style="margin-top:14px">Your guess? Your score?</h1>'
                   f'<div class="res"><div class="r" data-row=".2"><div class="n">1</div><div class="tx"><b>Who is he?</b><s>Answer pinned tomorrow</s></div></div>'
                   f'<div class="r" data-row=".3"><div class="n">2</div><div class="tx"><b>Your score out of 8</b><s>Easy to knows ball</s></div><div class="pill num">?/8</div></div></div>'
                   f'<div class="follow" data-in=".6">Follow for tomorrow\'s quiz</div>'))
    total = round(en, 2)
    texts = [h for _, _, h in scenes] + [x[2] for x in subs] + ls
    no_em(*texts); tt_check(*[plain(x) for x in texts])
    wav = audio[:int(total * SR)]; wav = (wav / max(1, np.max(np.abs(wav)) / .95)).astype(np.float32)
    sf.write(os.path.join(OUT, KEY + ".wav"), wav, SR)
    body = "".join(f'<div class="scene" data-s="{a:.3f}" data-e="{b:.3f}">{h}</div>' for a, b, h in scenes)
    fit2 = """<script>document.querySelectorAll('.fit2').forEach(e=>{let s=parseFloat(getComputedStyle(e).fontSize);while(e.scrollHeight>260&&s>48){s-=2;e.style.fontSize=s+'px';}});</script>"""
    html = (f'<!doctype html><html><head><meta charset="utf-8"><style>{CSS}{QCSS}</style></head><body><div class="bar">{WORDMARK}</div>'
            f'{body}<div class="subs"><span id="sb"></span></div>'
            f'<div class="foot"><span>{D["date_label"]} · Football quiz</span><span id="sn"></span></div><div class="prog"><i id="pg"></i></div>'
            f'<script>window.TOTAL={total};window.SUBS={json.dumps(subs)};</script>{fit2}{JS}{QJS}</body></html>')
    open(os.path.join(OUT, KEY + ".html"), "w").write(html)
    return {"html": KEY + ".html", "wav": KEY + ".wav", "total": total, "out": D["file"],
            "scenes": [(round(a, 2), round(b, 2)) for a, b, _ in scenes]}

if __name__ == "__main__":
    shutil.copy(os.path.join(HERE, "onest.woff2"), os.path.join(OUT, "onest.woff2"))
    if MODE == "script":
        print(write_script(KEY, lines(), OUT))
    else:
        m = build(); json.dump({"videos": [m]}, open(os.path.join(OUT, "manifest.json"), "w"), indent=1); print(m["out"], m["total"])
