"""Shared maxedge.live video kit: tokens CSS, JS timeline, wordmark, copy checks, sound effects."""
import re, numpy as np
SR = 24000
TT_BANNED = ["odds", "bet", "bets", "betting", "punt", "stake", "bookie", "bookies", "bookmaker", "tip", "tips", "acca",
             "value", "pick", "picks", "lock", "banker", "market", "price", "prices", "profit", "gamble", "gambling",
             "wager", "maxedge.live", "free trial", "sign up", "link in bio"]
def tt_check(*texts):
    bad = []
    for tx in texts:
        low = re.sub(r"<svg.*?</svg>|<[^>]+>", " ", tx, flags=re.S).lower()
        bad += [b for b in TT_BANNED if re.search(r"(?<![a-z])" + re.escape(b) + r"(?![a-z])", low)]
    if bad: raise ValueError(f"banned words: {sorted(set(bad))}")
def no_em(*texts):
    for tx in texts:
        if "—" in tx or "–" in tx: raise ValueError("dash: " + tx[:80])

def tick(f=1300, d=.03, amp=.14):
    t = np.arange(int(d * SR)) / SR
    return (amp * np.sin(2 * np.pi * f * t) * np.exp(-t / .01)).astype(np.float32)
def hit():
    t = np.arange(int(.5 * SR)) / SR
    return (.42 * np.sin(2 * np.pi * 72 * t) * np.exp(-t / .15) + .2 * np.sin(2 * np.pi * 144 * t) * np.exp(-t / .07)).astype(np.float32)

WORDMARK = ('<svg viewBox="0 0 520.53 60" height="44" fill="#0A0D11"><g transform="translate(-7.65625,0)"><g>'
 '<path d="M7.65625 60V0H18.828125L55.1171875 48.9453125L90.859375 0H102.03125V60H94.53125V6.796875L58.7109375 56.0546875H51.9140625L15.15625 6.796875V60Z"/>'
 '<path transform="translate(103.53125,0)" d="M2.5 60 37.5 0H47.5L82.5 60H73.75L66.25 46.25H18.75L11.25 60ZM22.5 40H62.5L42.5 5Z"/>'
 '<path transform="translate(187.53125,0)" d="M2.5 60 36.6015625 28.359375 5 0H15.625L41.796875 23.515625L67.1484375 0H77.7734375L47.2265625 28.359375L82.5 60H71.875L41.9921875 33.203125L13.125 60Z"/></g>'
 '<g fill-rule="evenodd" transform="translate(264.18376,0)"><path d="M7.000 0H56V13H13V23.5H50V36.5H13V47H56V60H11.838L0 49.381V6.499Z"/>'
 '<path transform="translate(64,0)" d="M0 0H44Q64 0 64 20V40Q64 60 44 60H0Z M13 13V47H42Q51 47 51 38V22Q51 13 42 13Z"/>'
 '<path transform="translate(136,0)" d="M20 0H64V13H22Q13 13 13 22V38Q13 47 22 47H51V36H36V24H64V60H20Q0 60 0 40V20Q0 0 20 0Z"/>'
 '<path transform="translate(208,0)" d="M0 0H49.000L56 6.499V13H13V23.5H50V36.5H13V47H56V49.381L44.162 60H0Z"/></g></g></svg>')

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


# ---------------------------------------------------------------- voice
import json as _json, os as _os, unicodedata as _ud
import soundfile as _sf

def plain(s):
    """Accents off, for the voice and for TikTok-safe text checks."""
    return "".join(c for c in _ud.normalize("NFKD", s) if not _ud.combining(c))

def nsent(s):
    return len([x for x in re.split(r"(?<=[.?!])\s+", s.strip()) if x])

def trim(a):
    idx = np.where(np.abs(a) > .012)[0]
    return a[max(0, idx[0] - 200): idx[-1] + 1200] if len(idx) else a

def voice_segments(lines, key, outdir, mode):
    """One audio segment per narration line.
    mode 'kokoro': free local voice (KOKORO_DIR env).
    mode 'astro':  ONE Everygen call for the whole video, saved as <key>_astro.wav plus
                   <key>_astro.json = {"sentenceEnds": [...]} from the tool's timing field.
                   Lines are cut at the quietest 10 ms near each sentence end."""
    if mode == "kokoro":
        from kokoro_onnx import Kokoro
        K = Kokoro(_os.path.join(_os.environ["KOKORO_DIR"], "kokoro.onnx"), _os.path.join(_os.environ["KOKORO_DIR"], "voices.bin"))
        return [trim(K.create(l, voice="bm_lewis", speed=1.0, lang="en-gb")[0].astype(np.float32)) for l in lines]
    wav, sr = _sf.read(_os.path.join(outdir, f"{key}_astro.wav"), dtype="float32")
    if wav.ndim > 1: wav = wav.mean(1)
    if sr != SR:
        x = np.linspace(0, len(wav) - 1, int(len(wav) * SR / sr)); wav = np.interp(x, np.arange(len(wav)), wav).astype(np.float32)
    ends = _json.load(open(_os.path.join(outdir, f"{key}_astro.json")))["sentenceEnds"]
    need = sum(map(nsent, lines))
    if len(ends) != need:
        raise ValueError(f"{key}: voiceover has {len(ends)} sentences, script has {need}. Re-check the text sent to Everygen.")
    def quiet(t):
        best, bt = 9, t
        for c in np.arange(t - .06, t + .15, .005):
            e = float(np.sqrt(np.mean(wav[int(c * SR): int((c + .01) * SR)] ** 2) + 1e-12))
            if e < best: best, bt = e, c + .005
        return bt
    segs, k, start = [], 0, 0.0
    for i, l in enumerate(lines):
        k += nsent(l); last = i == len(lines) - 1
        cut = len(wav) / SR if last else quiet(ends[k - 1])
        segs.append(trim(wav[int(start * SR): int(cut * SR)])); start = cut
    return segs

def write_script(key, lines, outdir):
    """Writes <key>_script.txt: the exact text to send to Everygen in one call."""
    txt = " ".join(lines)
    open(_os.path.join(outdir, f"{key}_script.txt"), "w").write(txt)
    return f"{key}: {sum(map(nsent, lines))} sentences, {len(txt)} chars"

def say_time(ko):
    """'17:45' -> 'quarter to six'; '20:00' -> 'eight o'clock'; '19:30' -> 'half seven'."""
    h, m = map(int, ko.split(":")); words = "twelve one two three four five six seven eight nine ten eleven twelve".split()
    h12 = h % 12
    if m == 0: return f"{words[h12]} o'clock"
    if m == 30: return f"half {words[h12]}"
    if m == 15: return f"quarter past {words[h12]}"
    if m == 45: return f"quarter to {words[(h12 + 1) % 12]}"
    return f"{words[h12]} {m}"


# ---------------------------------------------------------------- badges (rule, 22 Oct 2026)
# Club badges are patterned discs in the club's kit colours, never initials and never the real crest.
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
 "Bayer Leverkusen": ("solid", "#E32221", "#111111"), "Inter": ("stripes", "#0068A8", "#111111"), "AC Milan": ("stripes", "#FB090B", "#111111"),
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
 "Athletic Club": ("stripes", "#EE2523", "#FFFFFF"),
 "1899 Hoffenheim": ("solid", "#1961B5", "#FFFFFF"), "Werder Bremen": ("solid", "#1D9053", "#FFFFFF"), "FSV Mainz 05": ("solid", "#C3141E", "#FFFFFF"),
 "Union Berlin": ("solid", "#EB1923", "#FFFFFF"), "VfL Wolfsburg": ("solid", "#65B32E", "#FFFFFF"), "1. FC Köln": ("solid", "#FFFFFF", "#ED1C24"),
 "Hamburger SV": ("solid", "#FFFFFF", "#0A3F86"), "FC Schalke 04": ("solid", "#004D9D", "#FFFFFF"), "Lens": ("halves", "#FFE100", "#E1001A"),
 "Lille": ("solid", "#E01E13", "#20325F"), "Nice": ("stripes", "#C8102E", "#111111"), "Rennes": ("solid", "#E13327", "#111111"),
 "Strasbourg": ("solid", "#009FE3", "#FFFFFF"), "Trabzonspor": ("stripes", "#7A1E30", "#4AB7E8"), "Aston Villa": ("sleeves", "#670E36", "#95BFE5"), "Real Sociedad": ("stripes", "#0067B1", "#FFFFFF"), "Valencia": ("solid", "#FFFFFF", "#111111"),
}

def _pat(kind, b):
    if kind == "stripes": return "".join(f'<rect x="{x}" y="0" width="12" height="100" fill="{b}"/>' for x in (14, 38, 62, 86))
    if kind == "hoops": return "".join(f'<rect x="0" y="{y}" width="100" height="12" fill="{b}"/>' for y in (14, 38, 62, 86))
    if kind == "halves": return f'<rect x="50" y="0" width="50" height="100" fill="{b}"/>'
    if kind == "centre": return f'<rect x="36" y="0" width="28" height="100" fill="{b}"/>'
    if kind == "sleeves": return f'<rect x="0" y="0" width="22" height="100" fill="{b}"/><rect x="78" y="0" width="22" height="100" fill="{b}"/>'
    return ""

ALIAS = {"bayern munich": "Bayern München", "bayern": "Bayern München", "man united": "Manchester United", "man utd": "Manchester United",
         "man city": "Manchester City", "psg": "Paris Saint Germain", "paris": "Paris Saint Germain", "spurs": "Tottenham",
         "tottenham hotspur": "Tottenham", "atletico": "Atletico Madrid", "atletico de madrid": "Atletico Madrid", "dortmund": "Borussia Dortmund",
         "inter milan": "Inter", "milan": "AC Milan", "roma": "AS Roma", "besiktas": "Beşiktaş", "fenerbahce": "Fenerbahçe",
         "leverkusen": "Bayer Leverkusen", "gladbach": "Borussia Mönchengladbach", "leipzig": "RB Leipzig", "freiburg": "SC Freiburg",
         "augsburg": "FC Augsburg", "hearts": "Heart Of Midlothian", "porto": "FC Porto", "sporting": "Sporting CP", "psv": "PSV Eindhoven",
         "stuttgart": "VfB Stuttgart", "frankfurt": "Eintracht Frankfurt", "forest": "Nottingham Forest", "wolverhampton": "Wolves",
         "newcastle united": "Newcastle", "brighton & hove albion": "Brighton", "west ham united": "West Ham", "leeds united": "Leeds",
         "betis": "Real Betis", "athletic bilbao": "Athletic Club", "hull": "Hull City"}

def _kit(name, col=None):
    if name in KITS: return KITS[name]
    if plain(name).lower() in ALIAS: return KITS[ALIAS[plain(name).lower()]]
    key = plain(name).lower().replace("fc ", "").strip()
    for k, v in KITS.items():
        kk = plain(k).lower()
        if kk == key or kk.startswith(key + " ") or key.startswith(kk + " ") or kk.replace("fc ", "") == key: return v
    if col and col.get("primary"):
        a = "#" + col["primary"].lstrip("#"); b = "#" + (col.get("number") or col.get("border") or "FFFFFF").lstrip("#")
        if b.upper() == a.upper(): b = "#FFFFFF" if a.upper() != "#FFFFFF" else "#111111"
        return ("solid", a, b)
    return ("solid", "#303439", "#85888E")

def badge(name, size=76, col=None):
    """Patterned club-colour disc with a lower band in the second colour (shirt over shorts).
    col: optional lineups.team_colors dict, used when the club is not in KITS."""
    kind, a, b = _kit(name, col); uid = abs(hash(name)) % 10**8
    ring = "#30343A" if a.upper() in ("#FFFFFF", "#111111") else "rgba(255,255,255,.18)"
    return (f'<svg class="badge" width="{size}" height="{size}" viewBox="0 0 100 100" aria-hidden="true" style="flex:none;display:block">'
            f'<defs><clipPath id="c{uid}"><circle cx="50" cy="50" r="48"/></clipPath></defs>'
            f'<g clip-path="url(#c{uid})"><rect width="100" height="100" fill="{a}"/>{_pat(kind, b)}'
            f'<rect x="0" y="70" width="100" height="30" fill="{b}"/><rect x="0" y="68" width="100" height="3" fill="#0A0D11" opacity=".25"/></g>'
            f'<circle cx="50" cy="50" r="48" fill="none" stroke="{ring}" stroke-width="4"/></svg>')

# ---------------------------------------------------------------- end card (rules, 22 Oct 2026)
# Every video ends on Like + Follow for more. ONE video for TikTok, Instagram and Facebook (Owen, 22 Oct):
# because the same file goes to TikTok, the end card neither shows nor speaks the site (TikTok rule).
# maxedge.live goes in the Instagram and Facebook captions instead. No videos are made for X.
END_LINES = ["Like and follow for more."]
END_CSS = """.endc{text-align:center;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center}
.endc .tag{font-size:34px;color:var(--mid);margin-top:26px}
.endc .acts{display:flex;justify-content:center;gap:20px;margin-top:40px}
.endc .acts div{border-radius:999px;padding:22px 40px;font-size:38px;font-weight:700;background:var(--s2);color:#fff}
.endc .acts div.f{background:#fff;color:var(--plate)}"""
_ENDMARK = "@@ENDCARD@@"
def end_html(cut=None):
    wm = WORDMARK.replace('fill="#0A0D11"', 'fill="#FFFFFF"').replace('height="44"', 'height="70"')
    return (f'<div class="endc">{wm}<div class="tag">Every match. Every stat.</div>'
            '<div class="acts" data-in=".3"><div>&#9829; Like</div><div class="f">Follow for more</div></div></div>')

def add_end(scenes, say, t):
    """Append the end card. say(t0, caption) must speak the NEXT voice segment (END_LINES must be the last
    script line) and return its duration. Returns the timing dict write_cuts needs."""
    s0 = t + .1; d1 = say(s0 + .05, "Like and follow for more.")
    end = round(s0 + .05 + d1 + 1.4, 2)
    scenes.append((s0, end, _ENDMARK))
    return {"end": end}

def write_cuts(out, key, file, scenes, subs, audio, fin, page):
    """Write the one video. page(body_html, total, subs) -> full html. Returns a one-entry manifest list
    (kept as a list so the builders' callers do not change)."""
    total = fin["end"]
    sc = [(a, (total if h == _ENDMARK else b), end_html() if h == _ENDMARK else h) for a, b, h in scenes]
    w = audio[:int(total * SR)].copy()
    w = (w / max(1, np.max(np.abs(w)) / .95)).astype(np.float32)
    tt_check(*[plain(re.sub(r"<[^>]+>", " ", h)) for _, _, h in sc[-1:]])
    _sf.write(_os.path.join(out, key + ".wav"), w, SR)
    body = "".join(f'<div class="scene" data-s="{a:.3f}" data-e="{b:.3f}">{h}</div>' for a, b, h in sc)
    open(_os.path.join(out, key + ".html"), "w").write(page(body, total, subs))
    return [{"html": key + ".html", "wav": key + ".wav", "total": total, "out": file,
             "cut": "TikTok, Instagram, Facebook"}]
