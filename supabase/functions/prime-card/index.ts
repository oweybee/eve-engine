// prime-card: renders the PRIME post card PNG for one alerted signal.
// GET /functions/v1/prime-card?id=<signal uuid>
// Reads the alert SNAPSHOT (prime_alerts), so the card always matches the
// caption that went out with it. Public on purpose: Discord fetches it.
import { ImageResponse } from 'https://deno.land/x/og_edge@0.0.6/mod.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { cardTree, W, H } from './cardTree.js'

const FONT = (w: number) => `https://cdn.jsdelivr.net/fontsource/fonts/inter@5.1.0/latin-${w}-normal.ttf`
let fonts: any[] | null = null
async function loadFonts() {
  if (fonts) return fonts
  fonts = await Promise.all([400, 600, 700].map(async (w) => ({
    name: 'Inter', weight: w, style: 'normal',
    data: await (await fetch(FONT(w))).arrayBuffer(),
  })))
  return fonts
}

async function crestDataUrl(url: string | null): Promise<string | null> {
  if (!url) return null
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2500) })
    if (!r.ok) return null
    const type = r.headers.get('content-type') ?? 'image/png'
    if (!/png|jpe?g|svg/.test(type)) return null
    const b = new Uint8Array(await r.arrayBuffer())
    let s = ''
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
    return `data:${type};base64,${btoa(s)}`
  } catch { return null }
}

Deno.serve(async (req) => {
  const id = new URL(req.url).searchParams.get('id') ?? ''
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response('bad id', { status: 400 })
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { data, error } = await sb.rpc('prime_card_data', { p_signal: id })
  if (error || !data) return new Response('not found', { status: 404 })
  const [f, crest] = await Promise.all([loadFonts(), crestDataUrl(data.crestUrl)])
  return new ImageResponse(cardTree({ ...data, crest }) as any, {
    width: W, height: H, fonts: f,
    headers: { 'cache-control': 'public, max-age=86400, immutable' },
  })
})
