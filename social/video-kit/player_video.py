"""Player hit-rate countdowns drawn as maxedge.live screens.
  python3 player_video.py script players.json outdir    -> <key>_script.txt (ONE Everygen call per video)
  python3 player_video.py build  players.json outdir astro
players.json: {"date_label": "Wed 21 Oct", "videos": [{"key","file",
   "stat": on-screen word, e.g. "Fouled" | "Shots on target" | "Tackles",  "chip": which stat chip is lit,
   "line": threshold, e.g. 1,  "n": 10,
   "hook": spoken hook, "h1": on-screen headline, "ask": closing question,
   "run_say": spoken + shown after each name, e.g. "Fouled in all ten",
   "players": [countdown order, #N first, #1 last: {"name","pos": FWD|MID|DEF|GK,"team","opp","fx": "Home v Away","ko": "20:00",
       optional "fact" (#1 twist, spoken and shown), optional "line" (per-player threshold, e.g. 2 for the #1 twist),
       "games": [{"opp","ha": H|A,"mins","value","date": "13 Oct"} x n, NEWEST FIRST]}]}]}
Layouts by rank (#5..#1): hit-rate card, bar chart, match-log table, fixture card, home/away hero. Fewer players use the last ones.
"""
import json, os, re, sys, shutil
import numpy as np, soundfile as sf
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from site_kit import CSS, JS, FIT, WORDMARK, tt_check, no_em, tick, hit, SR, plain, voice_segments, write_script

HERE = os.path.dirname(os.path.abspath(__file__))
MODE, DATA, OUT = sys.argv[1], sys.argv[2], sys.argv[3]; os.makedirs(OUT, exist_ok=True)
VOICE_MODE = sys.argv[4] if len(sys.argv) > 4 else "kokoro"
D = json.load(open(DATA))
ONES = "zero one two three four five six seven eight nine ten".split()
w = lambda n: ONES[n]
POS_WORD = {"FWD": "forward", "MID": "midfielder", "DEF": "defender", "GK": "goalkeeper"}
V = None  # current video, read by the layouts

def prep(v):
    for p in v["players"]:
        p["g"] = [(g["opp"], g["ha"], g["mins"], g["value"]) for g in p["games"]]
        p["dates"] = [g["date"] for g in p["games"]]
        p.setdefault("line", v.get("line", 1))
        mins = sum(x[2] for x in p["g"]); p["per90"] = sum(x[3] for x in p["g"]) / mins * 90 if mins else 0
        p["old"] = list(reversed(p["g"]))
        p.setdefault("ko", "20:00")
    order = ["card", "bars", "table", "fixture", "hero"]
    for p, lay in zip(v["players"], order[-len(v["players"]):]): p.setdefault("layout", lay)

def script(v):
    N = len(v["players"]); ls = [v["hook"]]
    for i, p in enumerate(v["players"]):
        rk = N - i
        if rk == 1: ls.append("One left.")
        h, a = p["fx"].split(" v ")
        lead = "And number one." if rk == 1 else f"Number {w(rk)}."
        ls.append(f"{lead} A {POS_WORD[p['pos']]}. {plain(h)} against {plain(a)}.")
        ls.append(f"It's {plain(p['name'])}. {p.get('fact') or v['run_say']}.")
    ls.append(f"{v['ask']} Comment the number.")
    return ls

CSS = """@font-face{font-family:Onest;src:url(onest.woff2) format('woff2');font-weight:100 900}
:root{--s0:#0D1116;--s1:#191C22;--s2:#24282E;--s3:#303439;--line:#23272E;--soft:#171A20;--ink:#FFFFFF;--mid:#BCC0C5;--low:#9DA1A6;--dim:#85888E;
--g:#99EC72;--gw:rgba(153,236,114,.20);--y:#FFF478;--yw:rgba(255,244,120,.09);--red:#FF3C46;--redi:#FF646B;--track:#2A2E35;--plate:#0A0D11}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1080px;height:1920px;overflow:hidden;background:var(--s0)}
body{font-family:Onest,sans-serif;color:var(--ink);font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
.num{font-variant-numeric:tabular-nums}
.bar{position:absolute;left:0;right:0;top:0;height:240px;background:var(--g);display:flex;align-items:flex-end;justify-content:center;padding-bottom:40px}
.scene{position:absolute;left:84px;right:150px;top:290px;bottom:600px}
.eyebrow{font-size:24px;font-weight:600;letter-spacing:3px;color:var(--low);text-transform:uppercase}
h1{font-size:68px;font-weight:700;line-height:1.06;letter-spacing:-1.5px}
h2{font-size:54px;font-weight:700;letter-spacing:-1px;line-height:1.08;white-space:nowrap}
.sub{font-size:30px;color:var(--mid);margin-top:12px;line-height:1.35}
.chips{display:flex;gap:12px;margin-top:26px;flex-wrap:nowrap}
.chip{border:2px solid var(--s3);color:var(--mid);border-radius:999px;padding:12px 22px;font-size:27px;font-weight:500;white-space:nowrap}
.chip.on{background:#fff;color:var(--plate);border-color:#fff;font-weight:600}
.seg{display:inline-flex;background:var(--s1);border-radius:999px;padding:6px;margin-top:20px}
.seg span{padding:10px 26px;border-radius:999px;font-size:26px;color:var(--dim);font-weight:600}.seg span.on{background:var(--s3);color:#fff}
.card{background:var(--s1);border-radius:36px;padding:34px 36px}
.plist{margin-top:26px;background:var(--s1);border-radius:36px;overflow:hidden}
.prow{display:flex;align-items:center;gap:22px;padding:22px 30px;border-top:2px solid var(--line)}.prow:first-child{border-top:none}
.prow .rk{width:30px;font-size:30px;font-weight:700;color:var(--low)}
.prow .av{width:64px;height:64px;border-radius:50%;background:var(--s2);display:grid;place-items:center;font-size:28px;font-weight:700;color:var(--g)}
.prow .tx{flex:1;min-width:0}.prow .nm{display:flex;gap:10px}.prow .nm i{display:block;height:26px;border-radius:8px;background:var(--s3)}
.prow .fx{font-size:22px;color:var(--low);margin-top:10px;white-space:nowrap}
.prow .dash{display:flex;gap:4px;margin-top:12px}.prow .dash i{width:22px;height:8px;border-radius:3px;background:var(--track)}.prow .dash i.on{background:var(--g)}
.pill{flex:none;background:var(--gw);color:var(--g);border-radius:999px;padding:8px 20px;font-size:28px;font-weight:700}
.hcx .top{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}
.hcx .mkt b{display:block;font-size:60px;font-weight:700;letter-spacing:-1px;white-space:nowrap}
.hcx .mkt s{display:block;text-decoration:none;font-size:28px;color:var(--dim);margin-top:6px}
.dial{flex:none;display:grid;place-items:center;width:150px;height:150px;border-radius:50%;background:var(--gw);color:var(--g);font-size:38px;font-weight:700}
.vsl{display:inline-block;margin-top:24px;border-radius:999px;background:var(--s2);color:var(--mid);padding:8px 20px;font-size:24px;font-weight:600}
.bp{margin-top:22px;display:flex;align-items:baseline;gap:16px}.bp b{font-size:130px;font-weight:700;letter-spacing:-2px;line-height:1}
.bp span{font-size:24px;font-weight:600;letter-spacing:2px;color:var(--low);text-transform:uppercase}
.run{margin-top:30px}.rl{display:flex;justify-content:space-between;font-size:28px;color:var(--mid);margin-bottom:12px}.rl b{color:#fff}
.bx{display:flex;gap:10px}.bx i{flex:1;height:44px;border-radius:8px;background:var(--track)}.bx i.on{background:var(--g)}
.hfoot{margin-top:36px;padding-top:24px;border-top:2px solid var(--soft);font-size:26px;color:var(--low)}.hfoot b{color:var(--mid);display:block;margin-bottom:4px}
.chart{position:relative;height:430px;margin-top:22px;display:flex;align-items:flex-end;gap:14px;padding:0 4px 0 58px}
.chart .col{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%}
.chart .v{font-size:28px;font-weight:700;color:var(--g);margin-bottom:8px}
.chart .b{width:100%;border-radius:10px 10px 4px 4px;background:var(--g);height:0}
.chart .o{font-size:20px;color:var(--low);margin-top:10px;font-weight:600;letter-spacing:1px}
.chart .ln{position:absolute;left:0;right:0;border-top:3px dashed rgba(255,255,255,.35)}
.chart .ln span{position:absolute;left:-6px;top:-18px;font-size:22px;color:var(--mid);background:var(--s1);padding:2px 10px;border-radius:8px}
table{width:100%;border-collapse:collapse;margin-top:6px}
th{text-align:left;font-size:21px;font-weight:600;letter-spacing:2px;color:var(--low);text-transform:uppercase;padding:0 10px 12px}
td{font-size:28px;padding:11px 10px;border-top:2px solid var(--line);white-space:nowrap}
td.r,th.r{text-align:right}td.d{color:var(--low)}td.op{font-weight:600}
.ha{display:inline-block;width:38px;font-size:20px;font-weight:700;color:var(--low)}
.ok{display:inline-block;background:var(--gw);color:var(--g);border-radius:8px;padding:2px 14px;font-weight:700}
.fxc .lg{display:flex;justify-content:space-between;font-size:24px;color:var(--low);font-weight:600;letter-spacing:2px;text-transform:uppercase}
.club{display:flex;align-items:center;gap:20px;margin-top:22px;font-size:44px;font-weight:700}
.crest{width:64px;height:64px;border-radius:50%;background:var(--s2);display:grid;place-items:center;font-size:24px;font-weight:700;color:var(--mid)}
.frm{display:flex;gap:10px;margin-top:6px}.frm i{flex:1;height:64px;border-radius:12px;display:grid;place-items:center;font-style:normal;font-size:30px;font-weight:700;background:var(--track);color:transparent}
.frm i.on{background:var(--gw);color:var(--g)}
.who{position:relative;min-height:66px}
.mask{position:absolute;left:0;top:6px;display:flex;gap:12px}.mask i{display:block;width:120px;height:54px;border-radius:14px;background:var(--s2)}
.rk1{display:inline-block;border-radius:999px;background:var(--s2);padding:8px 22px;font-size:30px;font-weight:700;margin-bottom:16px}.rk1.one{background:var(--g);color:var(--plate)}
.fact{display:inline-block;margin-top:20px;border:3px solid var(--g);color:var(--g);border-radius:999px;padding:10px 26px;font-size:26px;font-weight:700;letter-spacing:2px;text-transform:uppercase}
.two{display:flex;gap:18px;margin-top:20px}.two .card{flex:1;padding:24px 26px}
.beat{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center}
.beat .one{background:var(--g);color:var(--plate);border-radius:44px;padding:6px 64px;font-size:240px;font-weight:700;letter-spacing:-8px}
.beat .s{font-size:52px;font-weight:700;margin-top:30px}
.res{margin-top:24px;background:var(--s1);border-radius:36px;overflow:hidden}
.res .r{display:flex;align-items:center;gap:22px;padding:20px 30px;border-top:2px solid var(--line)}.res .r:first-child{border-top:none}
.res .n{width:56px;height:56px;border-radius:50%;background:var(--s2);display:grid;place-items:center;font-size:28px;font-weight:700}
.res .tx{flex:1;min-width:0}.res .tx b{display:block;font-size:32px;white-space:nowrap}.res .tx s{text-decoration:none;font-size:22px;color:var(--low)}
.follow{display:inline-block;margin-top:28px;background:#fff;color:var(--plate);border-radius:999px;padding:18px 34px;font-size:30px;font-weight:700}
.subs{position:absolute;left:84px;right:150px;top:1340px;height:110px;display:flex;align-items:center;justify-content:center;text-align:center;z-index:5}
.subs span{font-size:42px;font-weight:700;color:#fff;background:rgba(10,13,17,.85);border-radius:16px;padding:6px 18px;line-height:1.25}
.subs span:empty{display:none}
.foot{position:absolute;left:84px;right:150px;top:1462px;height:50px;border-top:2px solid var(--line);display:flex;justify-content:space-between;align-items:center;font-size:22px;color:var(--low)}
.prog{position:absolute;left:84px;right:150px;top:1520px;height:6px;background:var(--s2);border-radius:3px}.prog i{position:absolute;left:0;top:0;bottom:0;background:var(--g);border-radius:3px;width:0}
"""
JS = """<script>
const ease=x=>1-Math.pow(1-Math.min(1,Math.max(0,x)),3);
const back=x=>{x=Math.min(1,Math.max(0,x));const c=1.7;return 1+(c+1)*Math.pow(x-1,3)+c*Math.pow(x-1,2);};
function render(t){
 document.querySelectorAll('.scene').forEach(s=>{
  const a=+s.dataset.s,e=+s.dataset.e,l=t-a,first=a===0,last=e>=TOTAL;
  let o=first?1:Math.min(1,Math.max(0,l/0.12)); if(!last)o=Math.min(o,Math.max(0,(e-t)/0.15));
  s.style.opacity=(t>=a&&t<e+0.01)?o:0;
  s.querySelectorAll('[data-in]').forEach(el=>{const d=+el.dataset.in;
    if(d===0&&first){el.style.opacity=1;el.style.transform='none';return;}
    if(el.hasAttribute('data-pop')){const k=back((l-d)/0.4);el.style.opacity=Math.min(1,Math.max(0,(l-d)/0.08));el.style.transform=`scale(${0.75+0.25*k})`;el.style.transformOrigin='left center';}
    else{const p=ease((l-d)/0.35);el.style.opacity=p;el.style.transform=`translateY(${(1-p)*22}px)`;}
  });
  s.querySelectorAll('[data-out]').forEach(el=>{const d=+el.dataset.out;el.style.opacity=l>=d?Math.max(0,1-(l-d)/0.1):1;});
  s.querySelectorAll('[data-t]').forEach(c=>{c.classList.toggle('on',l>=+c.dataset.t);});
  s.querySelectorAll('[data-row]').forEach(c=>{const p=ease((l-(+c.dataset.row))/0.22);c.style.opacity=p;c.style.transform=`translateX(${(1-p)*-30}px)`;});
  s.querySelectorAll('[data-grow]').forEach(c=>{const p=ease((l-(+c.dataset.grow))/0.3);c.style.height=(p*(+c.dataset.h))+'px';});
  s.querySelectorAll('[data-vt]').forEach(c=>{c.style.opacity=l>=(+c.dataset.vt)?1:0;});
  s.querySelectorAll('[data-ticks]').forEach(c=>{const ts=JSON.parse(c.dataset.ticks);const k=ts.filter(x=>l>=x).length;
    c.textContent=c.dataset.fmt==='pct'?Math.round(k/ts.length*100)+'%':k+'/'+ts.length;});
 });
 document.getElementById('pg').style.width=(Math.min(1,t/TOTAL)*100)+'%';
 const sc=[...document.querySelectorAll('.scene')];let k=sc.findIndex(s=>t>=+s.dataset.s&&t<+s.dataset.e);if(k<0)k=sc.length-1;
 document.getElementById('sn').textContent=(k+1)+' / '+sc.length;
 const sb=SUBS.find(x=>t>=x[0]-0.05&&t<x[1]+0.12);document.getElementById('sb').textContent=sb?sb[2]:'';
}
render(0);
</script>"""
FIT = """<script>document.querySelectorAll('.fit').forEach(e=>{let s=parseFloat(getComputedStyle(e).fontSize);const W=e.parentElement.clientWidth;
while(e.scrollWidth>W&&s>30){s-=2;e.style.fontSize=s+'px';}});</script>"""

def initials(n): return "".join(x[0] for x in n.split()[:2]).upper()
def short(o): return {"Club Brugge": "BRU", "Slavia Praha": "SLA", "Real Sociedad": "RSO", "Aston Villa": "AVL", "Crystal Palace": "CRY",
                      "Dinamo Zagreb": "DZG", "Le Mans": "LMA", "Atletico": "ATM", "Betis": "RBB"}.get(o, o[:3].upper())

def name_block(p, rel, rk, N):
    return (f'<div class="rk1{" one" if rk == 1 else ""}" data-in=".0" data-pop>#{rk} {"of " + str(N) if rk > 1 else "The one"}</div>'
            f'<div class="who"><div class="mask" data-out="{rel:.2f}"><i></i><i></i><i></i></div>'
            f'<h2 class="fit" data-in="{rel:.2f}" data-pop>{p["name"]}</h2></div>')

def lay_card(p, f0, step, rel, rk, N):
    n = len(p["g"]); ts = [round(f0 + k * step, 3) for k in range(n)]
    boxes = "".join(f'<i data-t="{x}"></i>' for x in ts)
    return (f'<div class="rk1" data-in=".0" data-pop>#{rk} of {N}</div>'
            f'<div class="card hcx" data-in=".1"><div class="top"><div class="mkt who" style="flex:1;min-width:0">'
            f'<div class="mask" data-out="{rel:.2f}"><i></i><i></i><i></i></div>'
            f'<b class="fit" data-in="{rel:.2f}" data-pop>{p["name"]}</b><s>{p["pos"]} · {p["team"]}</s></div>'
            f'<b class="dial" data-ticks="{json.dumps(ts)}" data-fmt="pct">0%</b></div>'
            f'<span class="vsl">v {p["opp"]}</span>'
            f'<div class="bp"><b class="num">{p["per90"]:.2f}</b><span>{V["stat"]} per 90</span></div>'
            f'<div class="run"><div class="rl"><span>Last {n}</span><b class="num" data-ticks="{json.dumps(ts)}">0/{n}</b></div><div class="bx">{boxes}</div>'
            f'<div class="frm" style="margin-top:14px">{"".join(f"<i data-t={x}>{v[3]}</i>" for x, v in zip(ts, p["old"]))}</div></div>'
            f'<div class="hfoot"><b>Tonight</b>{p["ko"]} · {p["fx"]}</div></div>'), ts

def chart(p, ts, H):
    g = p["old"]; mx = max(x[3] for x in g)
    cols = "".join(f'<div class="col"><div class="v" data-vt="{t + .2}">{x[3]}</div><div class="b" data-grow="{t}" data-h="{int(H * x[3] / mx)}"></div><div class="o">{short(x[0])}</div></div>'
                   for t, x in zip(ts, g))
    lh = int(H * p["line"] / mx) + 46
    return f'{cols}<div class="ln" style="bottom:{lh}px"><span>{p["line"]}+</span></div>'

def lay_bars(p, f0, step, rel, rk, N):
    n = len(p["g"]); ts = [round(f0 + k * step, 3) for k in range(n)]
    return (name_block(p, rel, rk, N) +
            f'<div class="sub" data-in=".1">{p["pos"]} · {p["team"]} · {V["stat"]} per game, oldest first</div>'
            f'<div class="card" data-in=".15" style="margin-top:20px"><div class="chart" style="height:400px">{chart(p, ts, 310)}</div></div>'
            f'<div class="two" data-in=".2"><div class="card"><div class="eyebrow">Hit rate</div><h2 class="num" data-ticks="{json.dumps(ts)}">0/{n}</h2></div>'
            f'<div class="card"><div class="eyebrow">Per 90</div><h2 class="num">{p["per90"]:.2f}</h2></div></div>'), ts

def lay_table(p, f0, step, rel, rk, N):
    g = p["g"]; n = len(g); ts = [round(f0 + k * step, 3) for k in range(n)]
    rows = "".join(f'<tr data-row="{t}"><td class="d">{d}</td><td class="op"><span class="ha">{x[1]}</span>{x[0]}</td><td class="r d">{x[2]}\'</td><td class="r"><span class="ok">{x[3]} ✓</span></td></tr>'
                   for t, d, x in zip(ts, p["dates"], g))
    return (name_block(p, rel, rk, N) +
            f'<div class="sub" data-in=".1">{p["pos"]} · {p["team"]} · Match log, newest first</div>'
            f'<div class="card" data-in=".15" style="margin-top:18px;padding:24px 30px"><table><tr><th>Date</th><th>Opponent</th><th class="r">Mins</th><th class="r">{V["stat"]}</th></tr>{rows}</table></div>'), ts

def lay_fixture(p, f0, step, rel, rk, N):
    g = p["old"]; n = len(g); ts = [round(f0 + k * step, 3) for k in range(n)]
    h, a = p["fx"].split(" v ")
    pills = "".join(f'<i data-t="{t}">{x[3]}</i>' for t, x in zip(ts, g))
    return (name_block(p, rel, rk, N) +
            f'<div class="card fxc" data-in=".1" style="margin-top:6px"><div class="lg"><span>Tonight</span><span>{p["ko"]}</span></div>'
            f'<div class="club"><div class="crest">{initials(h)}</div>{h}</div><div class="club"><div class="crest">{initials(a)}</div>{a}</div></div>'
            f'<div class="card" data-in=".2" style="margin-top:20px"><div class="rl"><span>{p["pos"]} · {V["stat"]}, last {n}</span><b class="num" data-ticks="{json.dumps(ts)}">0/{n}</b></div>'
            f'<div class="frm">{pills}</div><div class="hfoot"><b>{p["per90"]:.2f} per 90</b>Every game, {p["line"]} or more</div></div>'), ts

def lay_hero(p, f0, step, rel, rk, N):
    g = p["old"]; n = len(g); ts = [round(f0 + k * step, 3) for k in range(n)]
    home = [t for t, x in zip(ts, g) if x[1] == "H"]; away = [t for t, x in zip(ts, g) if x[1] == "A"]
    hb = "".join(f'<i data-t="{t}"></i>' for t in home); ab = "".join(f'<i data-t="{t}"></i>' for t in away)
    return (name_block(p, rel, rk, N) +
            f'<div class="card" data-in=".1" style="margin-top:6px;padding:26px 30px"><div class="rl"><span>{p["pos"]} · {p["team"]} · {V["stat"]} {p["line"]}+</span><b class="num" data-ticks="{json.dumps(ts)}">0/{n}</b></div>'
            f'<div class="chart" style="height:300px;margin-top:6px">{chart(p, ts, 220)}</div></div>'
            f'<div class="two" data-in=".2"><div class="card"><div class="rl"><span>Home</span><b class="num" data-ticks="{json.dumps(home)}">0/{len(home)}</b></div><div class="bx">{hb}</div></div>'
            f'<div class="card"><div class="rl"><span>Away</span><b class="num" data-ticks="{json.dumps(away)}">0/{len(away)}</b></div><div class="bx">{ab}</div></div></div>'), ts

LAYOUTS = dict(card=lay_card, bars=lay_bars, table=lay_table, fixture=lay_fixture, hero=lay_hero)

def build(v):
    global V; V = v; prep(v); P = v["players"]; LS = script(v); SEG = iter(voice_segments(LS, v["key"], OUT, VOICE_MODE))
    N = len(P); n = 10
    audio = np.zeros(int(400 * SR), np.float32); subs, scenes = [], []
    def put(t, a): i = int(t * SR); audio[i:i + len(a)] += a
    def say(t0, text, cap=None, speed=1.0):
        a = next(SEG); put(t0, a); d = len(a) / SR
        if cap:
            ws = cap.split(); cs = [" ".join(ws[i:i + 4]) for i in range(0, len(ws), 4)]; L = sum(map(len, cs)); c = t0
            for x in cs: dd = d * len(x) / L; subs.append([round(c, 3), round(c + dd, 3), x]); c += dd
        return d

    hook = v["hook"]
    d = say(0, hook); end = max(d + .4, 3.5)
    chips = "".join(f'<div class="chip{" on" if c == v.get("chip", v["stat"]) else ""}">{c}</div>' for c in v.get("chips", ["Shots", "On target", "Fouled", "Tackles"]))
    rows = ""
    for i, p in enumerate(reversed(P)):
        ts = [round(.4 + i * .12 + k * .1, 2) for k in range(10)]
        dash = "".join(f'<i data-t="{x}"></i>' for x in ts)
        widths = [150, 110, 90][: 2 + (i % 2)]
        rows += (f'<div class="prow" data-row="{.15 + i * .1:.2f}"><div class="rk">{i + 1}</div><div class="av">?</div><div class="tx">'
                 f'<div class="nm">{"".join(f"<i style=width:{wd}px></i>" for wd in widths)}</div><div class="fx">{p["pos"]} · {p["fx"]}</div>'
                 f'<div class="dash">{dash}</div></div><div class="pill num" data-ticks="{json.dumps(ts)}">0/10</div></div>')
    scenes.append((0, end, f'<div class="eyebrow">Player stats · Tonight</div><h1 style="margin-top:12px">{v["h1"]}</h1>'
                   f'<div class="chips">{chips}</div><div class="seg"><span>Last 5</span><span class="on">Last 10</span></div>'
                   f'<div class="plist">{rows}</div>'))
    t = end
    for i, p in enumerate(P):
        rk = N - i
        if rk == 1:
            t0 = t + .1; d = say(t0 + .1, "One left.", "One left."); e = t0 + max(1.5, d + .5)
            scenes.append((t0, e, '<div class="beat" data-in=".0"><div class="one">#1</div><div class="s">One left.</div></div>')); t = e
        s0 = t + .1
        h, a = p["fx"].split(" v ")
        lead = "And number one." if rk == 1 else f"Number {w(rk)}."
        d1 = say(s0 + .05, f"{lead} A {POS_WORD[p['pos']]}. {h} against {a}.", f"#{rk}. A {POS_WORD[p['pos']]}. {p['fx']}.")
        f0 = max(.8, d1 * .5); step = .22
        r_rel = max(d1 + .05, f0 + (n - 1) * step + .45)
        html, ts = LAYOUTS[p["layout"]](p, f0, step, r_rel, rk, N)
        for k, x in enumerate(ts): put(s0 + x, tick(1250 + 50 * k))
        put(s0 + r_rel, hit())
        fact = p.get("fact")
        d2 = say(s0 + r_rel + .12, None, f"{p['name']}. {fact or v['run_say']}.")
        if fact: html += f'<div class="fact" data-in="{r_rel + .3:.2f}">{fact}</div>'
        e = s0 + r_rel + .12 + d2 + .5
        scenes.append((s0, e, html)); t = e
    s0 = t + .1; ask = v["ask"]
    d = say(s0 + .05, f"{ask} Comment the number.", ask)
    opts = "".join(f'<div class="r" data-row="{.2 + k * .08:.2f}"><div class="n">{k + 1}</div><div class="tx"><b class="fit">{p["name"]}</b><s>{p["fx"]} · {p["ko"]}</s></div>'
                   f'<div class="pill num">{len(p["g"])}/{len(p["g"])}</div></div>' for k, p in enumerate(reversed(P)))
    scenes.append((s0, s0 + max(3.6, d + .7), f'<div class="eyebrow">Comment the number</div><h1 style="margin-top:12px">{ask}</h1>'
                   f'<div class="res">{opts}</div><div class="follow" data-in="{.3 + N * .08:.2f}">Follow for tomorrow\'s countdown</div>'))
    total = round(scenes[-1][1], 2)
    texts = [x for _, _, x in scenes] + [x[2] for x in subs] + [hook]
    no_em(*texts); tt_check(*texts)
    wav = audio[:int(total * SR)]; wav = (wav / max(1, np.max(np.abs(wav)) / .95)).astype(np.float32)
    sf.write(os.path.join(OUT, v["key"] + ".wav"), wav, SR)
    body = "".join(f'<div class="scene" data-s="{a:.3f}" data-e="{b:.3f}">{h}</div>' for a, b, h in scenes)
    html = (f'<!doctype html><html><head><meta charset="utf-8"><style>{CSS}</style></head><body><div class="bar">{WORDMARK}</div>'
            f'{body}<div class="subs"><span id="sb"></span></div>'
            f'<div class="foot"><span>{D["date_label"]} · Last {len(P[0]["g"])} games</span><span id="sn"></span></div><div class="prog"><i id="pg"></i></div>'
            f'<script>window.TOTAL={total};window.SUBS={json.dumps(subs)};</script>{FIT}{JS}</body></html>')
    open(os.path.join(OUT, v["key"] + ".html"), "w").write(html)
    return {"html": v["key"] + ".html", "wav": v["key"] + ".wav", "total": total, "out": v["file"],
            "scenes": [(round(a, 2), round(b, 2)) for a, b, _ in scenes]}

if __name__ == "__main__":
    shutil.copy(os.path.join(HERE, "onest.woff2"), os.path.join(OUT, "onest.woff2"))
    if MODE == "script":
        for v in D["videos"]: prep(v); print(write_script(v["key"], script(v), OUT))
    else:
        man = [build(v) for v in D["videos"]]
        json.dump({"videos": man}, open(os.path.join(OUT, "manifest.json"), "w"), indent=1)
        for m in man: print(m["out"], m["total"])
