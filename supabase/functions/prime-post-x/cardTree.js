// PRIME post card: 1200x675 (16:9, shows uncropped in the X timeline).
// Same tree as functions/prime-card/cardTree.js; keep the two in step.

export const W = 1200
export const H = 675

const C = {
  bg: '#0c0e11',
  panel: '#15171b',
  line: '#272a30',
  hi: '#f5f6f7',
  mid: '#a1a4ab',
  low: '#6f737b',
  green: '#a6e47e',
  greenInk: '#10200a',
}

const el = (style, children) => ({ type: 'div', props: { style: { display: 'flex', ...style }, children } })
const t = (content, style) => el(style, content)
const img = (src, size, style = {}) => ({ type: 'img', props: { src, width: size, height: size, style: { objectFit: 'contain', ...style } } })

function scale(d) {
  const fair = Number(d.fair), floor = Number(d.floor), odds = Number(d.odds)
  if (![fair, floor, odds].every(Number.isFinite) || odds <= fair) return null
  const span = odds - fair
  const lo = fair - span * 0.18
  const hi = odds + span * 0.12
  const at = (x) => Math.min(1, Math.max(0, (x - lo) / (hi - lo)))
  return { fair: at(fair), floor: at(floor), odds: at(odds) }
}

const pct = (x) => `${(x * 100).toFixed(2)}%`

function priceScale(d) {
  const s = scale(d)
  if (!s) return null
  const TRACK_Y = 40
  return el({ position: 'relative', width: '100%', height: 116 }, [
    el({ position: 'absolute', left: pct(s.odds), top: 0, transform: 'translateX(-50%)', flexDirection: 'column', alignItems: 'center' }, [
      t(`CHECKED ${d.odds}`, { fontSize: 18, fontWeight: 700, color: C.green, letterSpacing: '0.06em' }),
    ]),
    el({ position: 'absolute', left: 0, right: 0, top: TRACK_Y, height: 6, borderRadius: 3, background: C.line }),
    el({ position: 'absolute', left: pct(s.fair), width: pct(s.floor - s.fair), top: TRACK_Y, height: 6, background: '#4a5a40' }),
    el({ position: 'absolute', left: pct(s.floor), right: 0, top: TRACK_Y, height: 6, borderRadius: 3, background: C.green }),
    el({ position: 'absolute', left: pct(s.fair), top: TRACK_Y - 10, width: 3, height: 26, marginLeft: -1, background: C.mid, borderRadius: 2 }),
    el({ position: 'absolute', left: pct(s.floor), top: TRACK_Y - 12, width: 4, height: 30, marginLeft: -2, background: C.hi, borderRadius: 2 }),
    el({ position: 'absolute', left: pct(s.odds), top: TRACK_Y - 9, width: 24, height: 24, marginLeft: -12, borderRadius: 12, background: C.green, border: `4px solid ${C.bg}` }),
    el({ position: 'absolute', left: pct(s.fair), top: TRACK_Y + 28, transform: 'translateX(-50%)', flexDirection: 'column', alignItems: 'center' }, [
      t(d.fair, { fontSize: 26, fontWeight: 600, color: C.mid }),
      t('FAIR PRICE', { fontSize: 15, color: C.low, letterSpacing: '0.1em' }),
    ]),
    el({ position: 'absolute', left: pct(s.floor), top: TRACK_Y + 28, transform: 'translateX(-50%)', flexDirection: 'column', alignItems: 'center' }, [
      t(d.floor, { fontSize: 26, fontWeight: 700, color: C.hi }),
      t('PRIME FROM', { fontSize: 15, color: C.low, letterSpacing: '0.1em' }),
    ]),
  ])
}

export function cardTree(d) {
  const long = d.selection.length > 20
  return el({
    width: W, height: H, flexDirection: 'column', justifyContent: 'space-between',
    padding: '44px 60px 34px', fontFamily: 'Inter', color: C.hi,
    backgroundColor: C.bg,
    backgroundImage: 'radial-gradient(circle at 92% 8%, rgba(166,228,126,0.20) 0%, rgba(166,228,126,0) 46%)',
  }, [
    el({ justifyContent: 'space-between', alignItems: 'center' }, [
      el({ alignItems: 'center', gap: 12 }, [
        el({ width: 14, height: 14, background: C.green, transform: 'rotate(45deg)' }),
        t('MaxEdge', { fontSize: 26, fontWeight: 700, letterSpacing: '-0.01em' }),
      ]),
      el({ gap: 10 }, [
        t(d.league, { fontSize: 20, color: C.mid, padding: '8px 16px', borderRadius: 999, border: `1.5px solid ${C.line}` }),
        t(d.koLabel, { fontSize: 20, color: C.hi, padding: '8px 16px', borderRadius: 999, background: C.panel, border: `1.5px solid ${C.line}` }),
      ]),
    ]),
    el({ justifyContent: 'space-between', alignItems: 'center' }, [
      el({ flexDirection: 'column', gap: 14, maxWidth: 900 }, [
        el({ alignItems: 'center', gap: 14 }, [
          el({ background: C.green, color: C.greenInk, borderRadius: 10, padding: '6px 14px', fontSize: 20, fontWeight: 700, letterSpacing: '0.12em' }, [t('PRIME', {})]),
          d.score == null ? null : t(`Score ${d.score}`, { fontSize: 20, color: C.mid, fontWeight: 600 }),
          t(`+${d.edge} edge`, { fontSize: 20, color: C.green, fontWeight: 600 }),
        ].filter(Boolean)),
        t(d.selection, { fontSize: long ? 56 : 68, fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1.02 }),
        t(d.fixture, { fontSize: 26, color: C.mid }),
      ]),
      d.crest
        ? el({ width: 168, height: 168, borderRadius: 84, background: C.panel, border: `1.5px solid ${C.line}`, alignItems: 'center', justifyContent: 'center' }, [img(d.crest, 104)])
        : null,
    ].filter(Boolean)),
    el({ alignItems: 'flex-end', gap: 48 }, [
      el({ flexDirection: 'column', gap: 2, width: 300 }, [
        t(d.odds, { fontSize: 104, fontWeight: 700, letterSpacing: '-0.04em', lineHeight: 1 }),
        t(`at ${d.book}`, { fontSize: 21, color: C.hi, fontWeight: 600, marginTop: 6 }),
        t(`checked ${d.checked}`, { fontSize: 19, color: C.mid }),
      ]),
      el({ flex: 1, paddingBottom: 2 }, [priceScale(d)].filter(Boolean)),
    ]),
    el({ justifyContent: 'space-between', alignItems: 'center', borderTop: `1.5px solid ${C.line}`, paddingTop: 20 }, [
      t(`Prices move. Still PRIME at ${d.floor} or better.`, { fontSize: 22, fontWeight: 600 }),
      t('18+ | BeGambleAware | Pricing analysis, not advice', { fontSize: 17, color: C.low }),
    ]),
  ])
}
