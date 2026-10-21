// meta-post: publishes queued posts to the MaxEdge Facebook Page and its
// linked Instagram account through Meta's Graph API (migration 176).
//
//   POST ?action=run      (x-cron-secret)  publish every due row; called by the social-publish cron
//   POST ?action=check    (x-cron-secret)  confirm the token can act as the Page and find the Instagram account
//   POST ?action=upload&ext=png|jpg|mp4   (x-upload-token, raw body)  store media in the public
//                          social-media bucket and return its URL. The token is one-use and only
//                          a database admin can mint it: select public.social_upload_token();
//
// Secret: META_PAGE_TOKEN, a system-user token with pages_manage_posts, pages_read_engagement,
// pages_show_list, instagram_basic, instagram_content_publish, business_management.
// A failed publish is marked failed and never retried automatically, so nothing posts twice.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

const G = 'https://graph.facebook.com/v23.0'
const PAGE_ID = Deno.env.get('META_PAGE_ID') ?? '61595589209014'
const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })

async function graph(path: string, params: Record<string, string>, method: 'GET' | 'POST' = 'GET') {
  const u = new URL(G + path)
  const init: RequestInit = { method }
  if (method === 'GET') for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  else init.body = new URLSearchParams(params)
  const r = await fetch(u, init)
  const j: any = await r.json().catch(() => ({}))
  if (!r.ok || j.error) throw new Error(j.error?.message ?? `Graph HTTP ${r.status}`)
  return j
}

let ctxCache: { name: string; pageToken: string; igId: string | null; igUser: string | null } | null = null
async function ctx() {
  if (ctxCache) return ctxCache
  const sys = Deno.env.get('META_PAGE_TOKEN')
  if (!sys) throw new Error('META_PAGE_TOKEN is not set in Edge Function secrets')
  const p = await graph(`/${PAGE_ID}`, { fields: 'name,access_token,instagram_business_account{id,username}', access_token: sys })
  if (!p.access_token) throw new Error('The token cannot act as the MaxEdge Page (assign the Page to the system user and include pages_manage_posts)')
  ctxCache = { name: p.name, pageToken: p.access_token, igId: p.instagram_business_account?.id ?? null, igUser: p.instagram_business_account?.username ?? null }
  return ctxCache
}

async function publish(row: any) {
  const c = await ctx()
  const t = c.pageToken
  if (row.platform === 'facebook') {
    if (row.media_type === 'text') return { post_id: (await graph(`/${PAGE_ID}/feed`, { message: row.caption, access_token: t }, 'POST')).id }
    if (row.media_type === 'image') return { post_id: (await graph(`/${PAGE_ID}/photos`, { url: row.media_url, caption: row.caption, access_token: t }, 'POST')).id }
    return { post_id: (await graph(`/${PAGE_ID}/videos`, { file_url: row.media_url, description: row.caption, access_token: t }, 'POST')).id }
  }
  if (!c.igId) throw new Error('No Instagram professional account is linked to the MaxEdge Page')
  const params: Record<string, string> = row.media_type === 'image'
    ? { image_url: row.media_url, caption: row.caption, access_token: t }
    : { media_type: 'REELS', video_url: row.media_url, caption: row.caption, share_to_feed: 'true', access_token: t }
  const container = (await graph(`/${c.igId}/media`, params, 'POST')).id
  return { container_id: container }
}

async function finishInstagram(row: any) {
  const c = await ctx()
  const s = await graph(`/${row.container_id}`, { fields: 'status_code,status', access_token: c.pageToken })
  if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error(`Instagram rejected the media: ${s.status ?? s.status_code}`)
  if (s.status_code !== 'FINISHED') return null
  return (await graph(`/${c.igId}/media_publish`, { creation_id: row.container_id, access_token: c.pageToken }, 'POST')).id
}

async function setRow(id: string, patch: Record<string, unknown>) {
  await sb.from('social_queue').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id)
}

async function run() {
  const out: string[] = []
  const now = new Date().toISOString()
  const { data: due } = await sb.from('social_queue').select('*')
    .or(`and(status.eq.queued,publish_at.lte.${now}),status.eq.processing`).order('publish_at').limit(10)
  for (const row of due ?? []) {
    try {
      if (row.status === 'queued') {
        const { data: claimed } = await sb.from('social_queue').update({ status: 'publishing', updated_at: now })
          .eq('id', row.id).eq('status', 'queued').select().maybeSingle()
        if (!claimed) continue
        const r = await publish(row)
        if (r.post_id) { await setRow(row.id, { status: 'published', post_id: r.post_id, error: null }); out.push(`${row.platform} published ${r.post_id}`); continue }
        row.container_id = r.container_id
        await setRow(row.id, { status: 'processing', container_id: r.container_id })
      }
      const id = await finishInstagram(row)
      if (id) { await setRow(row.id, { status: 'published', post_id: id, error: null }); out.push(`instagram published ${id}`) }
      else out.push(`instagram ${row.id} still processing`)
    } catch (e) {
      await setRow(row.id, { status: 'failed', error: String(e).slice(0, 500) })
      out.push(`${row.platform} ${row.id} failed: ${e}`)
    }
  }
  return out
}

Deno.serve(async (req) => {
  const q = new URL(req.url).searchParams
  const action = q.get('action') ?? ''

  if (action === 'upload') {
    const tok = req.headers.get('x-upload-token') ?? ''
    if (!/^[0-9a-f-]{36}$/i.test(tok)) return json({ error: 'bad token' }, 401)
    const { data: ok } = await sb.rpc('social_take_upload_token', { p: tok })
    if (!ok) return json({ error: 'token unknown, used or expired' }, 401)
    const ext = (q.get('ext') ?? '').toLowerCase()
    const type = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', mp4: 'video/mp4' } as Record<string, string>)[ext]
    if (!type) return json({ error: 'ext must be png, jpg or mp4' }, 400)
    const bytes = new Uint8Array(await req.arrayBuffer())
    if (!bytes.length) return json({ error: 'empty body' }, 400)
    const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext === 'jpeg' ? 'jpg' : ext}`
    const { error } = await sb.storage.from('social-media').upload(path, bytes, { contentType: type })
    if (error) return json({ error: error.message }, 500)
    return json({ url: sb.storage.from('social-media').getPublicUrl(path).data.publicUrl })
  }

  const { data: authed } = await sb.rpc('social_cron_ok', { p: req.headers.get('x-cron-secret') ?? '' })
  if (!authed) return json({ error: 'unauthorised' }, 401)

  if (action === 'check') {
    try { const c = await ctx(); return json({ ok: true, page: c.name, instagram: c.igUser, instagram_id: c.igId }) }
    catch (e) { return json({ ok: false, error: String(e) }) }
  }
  if (action === 'run') return json({ ok: true, results: await run() })
  return json({ error: 'unknown action' }, 400)
})
