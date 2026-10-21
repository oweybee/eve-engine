// prime-post-x: posts an alerted PRIME to X (card + caption), or the
// "price gone" correction as a reply to that post.
//
//   GET ?id=<signal>&t=<post_token>                 post the PRIME (from the Discord link)
//   GET ?action=reply&id=<signal>&t=<post_token>    reply with the price update (from send_prime_alerts)
//
// The token is per alert and only appears in the owner's private Discord.
// Every post is claimed in the database first, so a double tap posts once.
// A PRIME is only posted if the best fresh UK price is still at or above the
// floor at the moment of posting.
//
// Secrets (Edge Function secrets): X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
import { ImageResponse } from 'https://deno.land/x/og_edge@0.0.6/mod.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { cardTree, W, H } from './cardTree.js'
import { oauthHeader } from './oauth1.ts'

const FOOTER = '18+ | GamCare 0808 8020 133 | Pricing analysis, not advice'
const say = (msg: string, status = 200) =>
  new Response(msg + '\n', { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })

const keys = () => ({
  consumerKey: Deno.env.get('X_API_KEY') ?? '',
  consumerSecret: Deno.env.get('X_API_SECRET') ?? '',
  token: Deno.env.get('X_ACCESS_TOKEN') ?? '',
  tokenSecret: Deno.env.get('X_ACCESS_SECRET') ?? '',
})

async function xPost(url: string, body: unknown) {
  const auth = await oauthHeader('POST', url, keys())
  const r = await fetch(url, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await r.text()
  if (!r.ok) throw new Error(`${r.status} ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

let fonts: any[] | null = null
async function loadFonts() {
  if (fonts) return fonts
  fonts = await Promise.all([400, 600, 700].map(async (w) => ({
    name: 'Inter', weight: w, style: 'normal',
    data: await (await fetch(`https://cdn.jsdelivr.net/fontsource/fonts/inter@5.1.0/latin-${w}-normal.ttf`)).arrayBuffer(),
  })))
  return fonts
}

function b64(bytes: Uint8Array) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

async function cardPng(d: any) {
  const f = await loadFonts()
  const img = new ImageResponse(cardTree(d) as any, { width: W, height: H, fonts: f })
  return new Uint8Array(await img.arrayBuffer())
}

function caption(d: any) {
  const lines = (league: boolean) => [
    `${d.fixture}${league && d.league ? `, ${d.league}` : ''}, ${d.koRel}`,
    d.selection,
    `${d.odds} at ${d.book}, checked ${d.checkedTime}`,
    `Prices move. PRIME at ${d.floor} or better.`,
    `Edge ${d.edge} | PRIME`,
    '',
    FOOTER,
  ].join('\n')
  const full = lines(true)
  return full.length <= 280 ? full : lines(false)
}

Deno.serve(async (req) => {
  const q = new URL(req.url).searchParams
  const id = q.get('id') ?? '', t = q.get('t') ?? '', action = q.get('action') ?? 'post'
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f]{36}$/.test(t)) return say('Bad link.', 400)
  if (Object.values(keys()).some((v) => !v)) return say('X keys are not set up yet (Edge Function secrets).', 503)

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { data: live } = await sb.from('prime_alerts').select('*').eq('signal_id', id).eq('kind', 'live').eq('post_token', t).maybeSingle()
  if (!live) return say('Alert not found.', 404)

  // Correction reply
  if (action === 'reply') {
    if (!live.x_post_id) return say('Nothing posted, nothing to correct.')
    const { data: claim } = await sb.from('prime_alerts').update({ x_posted_at: new Date().toISOString() })
      .eq('signal_id', id).eq('kind', 'gone').is('x_posted_at', null).select().maybeSingle()
    if (!claim) return say('Correction already sent.')
    const text = `Price update: now ${Number(claim.odds).toFixed(2)}, below our PRIME floor of ${Number(claim.floor_odds).toFixed(2)}. No longer PRIME at current prices.\n\n${FOOTER}`
    try {
      const r = await xPost('https://api.x.com/2/tweets', { text, reply: { in_reply_to_tweet_id: live.x_post_id } })
      await sb.from('prime_alerts').update({ x_post_id: r.data.id }).eq('signal_id', id).eq('kind', 'gone')
      return say(`Correction posted: https://x.com/i/web/status/${r.data.id}`)
    } catch (e) {
      await sb.from('prime_alerts').update({ x_posted_at: null, x_error: String(e) }).eq('signal_id', id).eq('kind', 'gone')
      return say(`X refused the correction: ${e}`, 502)
    }
  }

  // Post the PRIME
  if (live.x_post_id) return say(`Already posted: https://x.com/i/web/status/${live.x_post_id}`)

  const { data: now } = await sb.from('v_prime_alert_state').select('odds, floor_odds, bookmaker').eq('signal_id', id).maybeSingle()
  if (!now) return say('Not posted: the match has started or the signal has settled.')
  if (now.odds == null) return say('Not posted: no fresh UK price to confirm it right now. Try again shortly.')
  if (Number(now.odds) < Number(now.floor_odds)) {
    return say(`Not posted: best UK price is now ${Number(now.odds).toFixed(2)}, below the ${Number(now.floor_odds).toFixed(2)} PRIME floor.`)
  }

  const { data: claim } = await sb.from('prime_alerts').update({ x_posted_at: new Date().toISOString(), x_error: null })
    .eq('signal_id', id).eq('kind', 'live').is('x_posted_at', null).select().maybeSingle()
  if (!claim) return say('Already being posted (double tap). Check X in a moment.')

  try {
    const { data: d, error } = await sb.rpc('prime_card_data', { p_signal: id })
    if (error || !d) throw new Error('card data missing')
    const png = await cardPng(d)
    const media = await xPost('https://api.x.com/2/media/upload', { media: b64(png), media_category: 'tweet_image' })
    const tweet = await xPost('https://api.x.com/2/tweets', { text: caption(d), media: { media_ids: [media.data.id] } })
    await sb.from('prime_alerts').update({ x_post_id: tweet.data.id }).eq('signal_id', id).eq('kind', 'live')
    return say(`Posted to X: https://x.com/i/web/status/${tweet.data.id}`)
  } catch (e) {
    await sb.from('prime_alerts').update({ x_posted_at: null, x_error: String(e) }).eq('signal_id', id).eq('kind', 'live')
    return say(`Not posted, X refused it: ${e}`, 502)
  }
})
