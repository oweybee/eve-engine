"""Shared engine for MaxEdge format videos (quiz-style formats and match breakdowns).
Rules built in (22 Oct 2026, Owen):
  1. Club badges are PATTERNED CIRCLES in the club's kit colours (solid, stripes, hoops, halves, centre stripe),
     never initials and never the real crest. Unknown clubs fall back to lineups.team_colors, then to a plain disc.
  2. Every video ends on the end card: Like + Follow for more + maxedge.live.
     Two cuts from ONE voiceover: the 'site' cut (X, Instagram, Facebook) speaks and shows maxedge.live;
     the 'tiktok' cut stops one sentence early and shows Like + Follow only (TikTok rule: no site link).
"""
import json, os
import re, numpy as np, soundfile as sf
from site_kit import CSS, JS, FIT, WORDMARK, tt_check, no_em, SR, plain, trim

# ------------------------------------------------------------------ badges
# (pattern, main colour, second colour). Kit colours, not crests.
KITS = {
 "Arsenal": ("sleeves", "#DB0007", "#FFFFFF"), "Chelsea": ("solid", "#034694", "#FFFFFF"), "Tottenham": ("solid", "#FFFFFF", "#132257"),
 "Manchester City": ("solid", "#6CABDD", "#FFFFFF"), "Manchester United": ("solid", "#DA291C", "#111111"), "Liverpool": ("solid", "#C8102E", "#FFFFFF"),
 "Brighton": ("stripes", "#0057B8", "#FFFFFF"), "Newcastle": ("stripes", "#111111", "#FFFFFF"), "Aston Villa": ("sleeves", "#670E36", "#95BFE5"),
 "Brentford": ("stripes", "#E30613", "#FFFFFF"), "Everton": ("solid", "#003399", "#FFFFFF"), "Crystal Palace": ("stripes", "#C4122E", "#1B458F"),
 "Bournemouth": ("stripes", "#DA291C", "#111111"), "Fulham": ("solid", "#FFFFFF", "#111111"), "Nottingham Forest": ("solid", "#DD0000", "#FFFFFF"),
 "Leeds": ("solid", "#FFFFFF", "#1D428A"), "Sunderland": ("stripes", "#EB172B", "#FFFFFF"), "Coventry": ("solid", "#77B5E6", "#FFFFFF"),
 "Hull City": ("stripes", "#F5A12D", "#111111"), "Ipswich": ("solid", "#0E63AD", "#FFFFFF"), "West Ham": ("sleeves", "#7A263A", "#1BB1E7"),
 "Wolves": ("solid", "#FDB913", "#231F20"), "Barcelona": ("stripes", "#A50044", "#004D98"), "Real Madrid": ("solid", "#FFFFFF", "#FEBE10"),
 "Atletico Madrid": ("stripes", "#CB3524", "#FFFFFF"), "Bayern München": ("solid", "#DC052D", "#FFFFFF"), "Borussia Dortmund": ("solid", "#FDE100", "#111111"),
 "Bayer Leverkusen": ("solid", "#E32221", "#111111"), "Inter": ("stripes", "#0068A8", "#111111"), "AC Milan": ("wide", "#FB090B", "#111111"),
 "Juventus": ("stripes", "#111111", "#FFFFFF"), "Napoli": ("solid", "#12A0D7", "#FFFFFF"), "AS Roma": ("solid", "#8E1F2F", "#F0BC42"),
 "Lazio": ("solid", "#87D8F7", "#FFFFFF"), "Paris Saint Germain": ("centre", "#004170", "#DA291C"), "Celtic": ("hoops", "#018749", "#FFFFFF"),
 "Rangers": ("solid", "#1B458F", "#FFFFFF"), "Heart Of Midlothian": ("solid", "#8C1D40", "#FFFFFF"), "Aberdeen": ("solid", "#C8102E", "#FFFFFF"),
 "SC Freiburg": ("solid", "#E2001A", "#111111"), "FC Augsburg": ("halves", "#BA3733", "#46714D"), "Borussia Mönchengladbach": ("solid", "#FFFFFF", "#111111"),
 "RB Leipzig": ("solid", "#FFFFFF", "#DD0741"), "Eintracht Frankfurt": ("solid", "#111111", "#E1000F"), "VfB Stuttgart": ("solid", "#FFFFFF", "#E32219"),
 "Benfica": ("solid", "#E83030", "#FFFFFF"), "FC Porto": ("stripes", "#00428C", "#FFFFFF"), "Sporting CP": ("hoops", "#008057", "#FFFFFF"),
 "Ajax": ("centre", "#FFFFFF", "#D2122E"), "Feyenoord": ("halves", "#E3000B", "#FFFFFF"), "PSV Eindhoven": ("stripes", "#ED1C24", "#FFFFFF"),
 "Marseille": ("solid", "#FFFFFF", "#2FAEE0"), "Lyon": ("solid", "#FFFFFF", "#DA0812"), "Monaco": ("halves", "#E7001E", "#FFFFFF"),
 "Galatasaray": ("halves", "#A90432", "#FDB912"), "Fenerbahçe": ("stripes", "#163962", "#FFED00"), "Beşiktaş": ("stripes", "#111111", "#FFFFFF"),
 "Real Betis": ("stripes", "#00954C", "#FFFFFF"), "Sevilla": ("solid", "#FFFFFF", "#D81E05"), "Villarreal": ("solid", "#FFE667", "#005187"),
 "Athletic Club": ("stripes", "#EE2523", "#FFFFFF"), "Real Sociedad": ("stripes", "#0067B1", "#FFFFFF"), "Valencia": ("solid", "#FFFFFF", "#111111"),
}
_LINEUP = {}   # filled from lineups.team_colors by the caller when a club is not in KITS: {name: (primary, number)}

def _pat(kind, a, b, uid):
    if kind == "stripes": return "".join(f'<rect x="{x}" y="0" width="12" height="100" fill="{b}"/>' for x in (14, 38, 62, 86))
    if kind == "wide": return "".join(f'<rect x="{x}" y="0" width="25" height="100" fill="{b}"/>' for x in (0, 50))
    if kind == "hoops": return "".join(f'<rect x="0" y="{y}" width="100" height="12" fill="{b}"/>' for y in (14, 38, 62, 86))
    if kind == "halves": return f'<rect x="50" y="0" width="50" height="100" fill="{b}"/>'
    if kind == "centre": return f'<rect x="36" y="0" width="28" height="100" fill="{b}"/>'
    if kind == "sleeves": return f'<rect x="0" y="0" width="22" height="100" fill="{b}"/><rect x="78" y="0" width="22" height="100" fill="{b}"/>'
    return ""

def _shorts(kind, b):
    """Every badge carries a lower band in the second colour (shirt over shorts), so a plain kit never reads as a blank disc."""
    return f'<rect x="0" y="70" width="100" height="30" fill="{b}"/><rect x="0" y="68" width="100" height="3" fill="#0A0D11" opacity=".25"/>'

def badge(name, size=76):
    """Patterned club-colour disc. Same size the initials disc used."""
    if name in KITS: kind, a, b = KITS[name]
    elif name in _LINEUP: kind, (a, b) = "solid", _LINEUP[name]
    else: kind, a, b = "solid", "#303439", "#85888E"
    uid = abs(hash(name)) % 10**8
    ring = "#30343A" if a.upper() in ("#FFFFFF", "#111111") else "rgba(255,255,255,.18)"
    return (f'<svg class="badge" width="{size}" height="{size}" viewBox="0 0 100 100" aria-hidden="true">'
            f'<defs><clipPath id="c{uid}"><circle cx="50" cy="50" r="48"/></clipPath></defs>'
            f'<g clip-path="url(#c{uid})"><rect width="100" height="100" fill="{a}"/>{_pat(kind, a, b, uid)}{_shorts(kind, b)}</g>'
            f'<circle cx="50" cy="50" r="48" fill="none" stroke="{ring}" stroke-width="4"/></svg>')

# ------------------------------------------------------------------ sounds
def tick(f=1500, d=.05):
    x = np.arange(int(d * SR)) / SR; return (0.22 * np.sin(2 * np.pi * f * x) * np.exp(-x * 60)).astype(np.float32)
def ding():
    x = np.arange(int(.35 * SR)) / SR
    return (0.18 * (np.sin(2 * np.pi * 880 * x) + .6 * np.sin(2 * np.pi * 1320 * x)) * np.exp(-x * 9)).astype(np.float32)

def whoosh(d=.32):
    rng = np.random.default_rng(7); n = int(d * SR); x = np.arange(n) / SR
    w = rng.standard_normal(n).astype(np.float32); k = np.ones(24) / 24; w = np.convolve(w, k, "same")
    env = np.sin(np.pi * np.minimum(1, x / d)) ** 2
    return (0.22 * w * env * (0.4 + 0.6 * x / d)).astype(np.float32)
def pop(f=620):
    x = np.arange(int(.09 * SR)) / SR
    return (0.16 * np.sin(2 * np.pi * (f + 900 * np.exp(-x * 60)) * x) * np.exp(-x * 38)).astype(np.float32)
def thud():
    x = np.arange(int(.45 * SR)) / SR
    return (.34 * np.sin(2 * np.pi * 70 * x) * np.exp(-x / .14) + .14 * np.sin(2 * np.pi * 140 * x) * np.exp(-x / .06)).astype(np.float32)
def roll(n=8, d=.6, f0=900):
    out = np.zeros(int((d + .06) * SR), np.float32)
    for k in range(n):
        t = d * (1 - (1 - k / n) ** 2); a = tick(f0 + 60 * k, .03); i = int(t * SR); out[i:i + len(a)] += .7 * a
    return out
_SFX = re.compile(r'data-(in|pop|t|row|count|spin)="?([0-9.]*)"?')
def scene_sfx(html):
    """Sparse cues (Owen 22 Oct: the first pass was too busy). Only the scene's key moments make a sound:
    the first headline pop (thud) and the first count-up (one soft tick). Rows, boxes and badges are silent."""
    cues = []
    for tag in re.findall(r"<[a-z][^>]*>", html):
        a = dict((k, v) for k, v in re.findall(r'data-(in|count|pop)(?:="([^"]*)")?', tag))
        if "pop" in a and a.get("in") and not any(k == "thud" for _, k in cues): cues.append((float(a["in"]), "thud"))
        elif "count" in a and a.get("in") and not any(k == "tick" for _, k in cues): cues.append((float(a["in"]) + .55, "tick"))
    return sorted(cues)

XCSS = """
.scene{display:flex;flex-direction:column;justify-content:center}.scene>.in{width:100%}
h1{font-size:84px}
.badge{flex:none;display:block}
.lvl{display:inline-block;border-radius:999px;padding:10px 24px;font-size:28px;font-weight:700;letter-spacing:2px;color:var(--plate);background:var(--g)}
.qn{font-size:28px;color:var(--low);font-weight:600;margin-left:16px}
.hide{opacity:0}.hide.on{opacity:1}.gone.on{opacity:0}
.timer{margin-top:30px;display:flex;align-items:center;gap:22px}
.tm{flex:1;height:14px;border-radius:7px;background:var(--track);overflow:hidden}.tm i{display:block;height:100%;background:var(--g);width:100%}
.cd{width:60px;text-align:right;font-size:44px;font-weight:700;color:var(--g)}
.club{display:flex;align-items:center;gap:22px;font-size:46px;font-weight:700}
.form{display:flex;gap:8px;margin-top:22px}.form div{flex:1;text-align:center}
.form b{display:grid;place-items:center;height:72px;border-radius:12px;font-size:32px;font-weight:700}
.form b.W{background:var(--gw);color:var(--g)}.form b.D{background:var(--s3);color:var(--mid)}.form b.L{background:rgba(255,60,70,.18);color:var(--redi)}
.form s{display:block;text-decoration:none;font-size:22px;color:var(--low);margin-top:8px}
.endc{text-align:center}
.endc .site{display:inline-block;margin-top:40px;background:var(--g);color:var(--plate);border-radius:999px;padding:22px 52px;font-size:58px;font-weight:700;letter-spacing:-1px}
.endc .acts{display:flex;justify-content:center;gap:20px;margin-top:40px}
.endc .acts div{border-radius:999px;padding:22px 40px;font-size:38px;font-weight:700;background:var(--s2);color:#fff}
.endc .acts div.f{background:#fff;color:var(--plate)}
.endc .tag{font-size:34px;color:var(--mid);margin-top:26px}
"""
XJS = """<script>(function(){const base=render;const E=x=>1-Math.pow(1-Math.min(1,Math.max(0,x)),3);
const B=x=>{x=Math.min(1,Math.max(0,x));const c=2.2;return 1+(c+1)*Math.pow(x-1,3)+c*Math.pow(x-1,2);};
render=function(t){base(t);
document.querySelectorAll('.scene').forEach(s=>{const l=t-(+s.dataset.s),r=(+s.dataset.e)-t,first=+s.dataset.s===0,last=+s.dataset.e>=TOTAL;
 const inn=s.firstElementChild,pi=first?1:E(l/0.38),po=last?0:E((0.22-r)/0.22);
 inn.style.transform=`translateX(${(1-pi)*90-po*90}px) scale(${1+0.025*Math.min(1,l/6)})`;
 s.querySelectorAll('[data-count]').forEach(e=>{const d=+(e.dataset.in||0),n=+e.dataset.count,k=E((l-d)/0.6);
   e.textContent=(e.dataset.pre||'')+Math.round(n*k)+(e.dataset.suf||'');});
 s.querySelectorAll('[data-spin]').forEach(e=>{const k=B((l-(+e.dataset.spin))/0.55);e.style.opacity=Math.min(1,Math.max(0,(l-(+e.dataset.spin))/0.1));
   e.style.transform=`scale(${0.3+0.7*k}) rotate(${(1-Math.min(1,k))*-120}deg)`;});
 s.querySelectorAll('[data-t]').forEach(e=>{const k=B((l-(+e.dataset.t))/0.3);if(l>=+e.dataset.t)e.style.transform=`scale(${0.6+0.4*k})`;else e.style.transform='scale(.85)';});
 s.querySelectorAll('[data-bar]').forEach(e=>{const k=E((l-(+e.dataset.bar))/0.7);e.style.width=(k*(+e.dataset.w))+'%';});
 s.querySelectorAll('[data-r]').forEach(e=>e.classList.toggle('on',l>=+e.dataset.r));
 s.querySelectorAll('.tm').forEach(e=>{const a=+e.dataset.a,d=+e.dataset.dur,k=Math.min(1,Math.max(0,(l-a)/d));e.firstChild.style.width=(100*(1-k))+'%';});
 s.querySelectorAll('.cd').forEach(e=>{const a=+e.dataset.a,d=+e.dataset.dur;const r=Math.ceil(d-(l-a));e.textContent=l<a?'':(r>0?r:'');});
});};render(0);})();</script>"""

def timer(a, d): return (f'<div class="timer"><div class="tm" data-a="{a:.2f}" data-dur="{d}"><i></i></div>'
                        f'<div class="cd" data-a="{a:.2f}" data-dur="{d}"></div></div>')

END_SAY = "Like and follow for more."
SITE_SAY = "Every match, every stat, at max edge dot live."

class Video:
    """scenes: list of (steps, html(m)). steps: ('say', text[, caption]) | ('think', secs[, freq]) | ('ding',) | ('pause', secs) | ('site', text)
    'site' steps are spoken only in the site cut. html(m, cut) may branch on cut."""
    def __init__(s, key, title, label, extra_css=""):
        s.key, s.title, s.label, s.extra = key, title, label, extra_css; s.scenes = []
    def scene(s, steps, html): s.scenes.append((steps, html))
    def end_card(s, line="Every match. Every stat."):
        s.scene([("say", END_SAY), ("site", SITE_SAY), ("pause", .8)],
                lambda m, cut: ('<div class="endc">' + WORDMARK.replace('fill="#0A0D11"', 'fill="#FFFFFF"').replace('height="44"', 'height="70"')
                                + (f'<div class="tag">{line}</div><div class="site" data-in=".3" data-pop>maxedge.live</div>' if cut == "site" else
                                   '<div class="tag">Every match. Every stat.</div>')
                                + '<div class="acts" data-in=".5"><div>♥ Like</div><div class="f">Follow for more</div></div></div>'))
    def build(s, out, voice, cut):
        audio = np.zeros(int(300 * SR), np.float32); subs = []; res = []; t = 0.0; lines = []
        def put(t0, a): i = int(t0 * SR); audio[i:i + len(a)] += a
        for si, (steps, html) in enumerate(s.scenes):
            st = 0.0 if si == 0 else t + .1; c = st + (0 if si == 0 else .05); m = []
            for step in steps:
                m.append(round(c - st, 3)); kind = step[0]
                if kind == "site" and cut != "site": continue
                if kind in ("say", "site"):
                    a = voice(step[1]); lines.append(step[1]); put(c, a); d = len(a) / SR
                    cap = step[2] if len(step) > 2 else (step[1] if kind == "site" else None)
                    if kind == "site": cap = "Every match, every stat, at maxedge.live."
                    if cap:
                        ws = cap.split(); cs = [" ".join(ws[i:i + 4]) for i in range(0, len(ws), 4)]; L = sum(map(len, cs)); x = c
                        for p in cs: dd = d * len(p) / L; subs.append([round(x, 3), round(x + dd, 3), p]); x += dd
                    c += d + .2
                elif kind == "think":
                    for k in range(int(step[1])): put(c + k, tick(step[2] if len(step) > 2 else 1500))
                    c += step[1]
                elif kind == "ding": put(c, ding()); c += .1
                elif kind == "pause": c += step[1]
            m.append(round(c - st, 3)); en = c + .6
            h = html(m, cut)
            # No animation sounds (Owen, 22 Oct): voice only. scene_sfx stays for reference, never called.
            res.append((st, en, h)); t = en
        total = round(t, 2)
        texts = [h for _, _, h in res] + [x[2] for x in subs] + lines
        no_em(*texts)
        if cut == "tiktok": tt_check(*[plain(x) for x in texts])
        else: tt_check(*[plain(x).replace("maxedge.live", "").replace("max edge dot live", "") for x in texts])
        wav = audio[:int(total * SR)]; wav = (wav / max(1, np.max(np.abs(wav)) / .95)).astype(np.float32)
        base = f"{s.key}_{cut}"
        sf.write(os.path.join(out, base + ".wav"), wav, SR)
        body = "".join(f'<div class="scene" data-s="{a:.3f}" data-e="{b:.3f}"><div class="in">{h}</div></div>' for a, b, h in res)
        html = (f'<!doctype html><html><head><meta charset="utf-8"><style>{CSS}{XCSS}{s.extra}</style></head><body><div class="bar">{WORDMARK}</div>'
                f'{body}<div class="subs"><span id="sb"></span></div>'
                f'<div class="foot"><span>{s.label}</span><span id="sn"></span></div><div class="prog"><i id="pg"></i></div>'
                f'<script>window.TOTAL={total};window.SUBS={json.dumps(subs)};</script>{FIT}{JS}{XJS}</body></html>')
        open(os.path.join(out, base + ".html"), "w").write(html)
        return {"html": base + ".html", "wav": base + ".wav", "total": total,
                "out": f"{s.title}.mp4" if cut == "tiktok" else f"{s.title}_site.mp4"}
