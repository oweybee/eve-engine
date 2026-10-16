// OAuth 1.0a (HMAC-SHA1) Authorization header for X API user-context calls.
// JSON bodies are not part of the signature; only oauth_* and query params are.
// Verified against Twitter's documented signature example.
const enc = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

export async function oauthHeader(
  method: string, url: string,
  k: { consumerKey: string; consumerSecret: string; token: string; tokenSecret: string },
  extra: Record<string, string> = {}, nonce?: string, timestamp?: string,
): Promise<string> {
  const u = new URL(url)
  const oauth: Record<string, string> = {
    oauth_consumer_key: k.consumerKey,
    oauth_nonce: nonce ?? crypto.randomUUID().replace(/-/g, ''),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp ?? String(Math.floor(Date.now() / 1000)),
    oauth_token: k.token,
    oauth_version: '1.0',
  }
  const all: [string, string][] = [...Object.entries(oauth), ...Object.entries(extra), ...u.searchParams.entries()]
  const paramStr = all.map(([a, b]) => [enc(a), enc(b)]).sort((x, y) => (x[0] === y[0] ? (x[1] < y[1] ? -1 : 1) : x[0] < y[0] ? -1 : 1))
    .map(([a, b]) => `${a}=${b}`).join('&')
  const base = `${method.toUpperCase()}&${enc(u.origin + u.pathname)}&${enc(paramStr)}`
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`${enc(k.consumerSecret)}&${enc(k.tokenSecret)}`),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(base)))
  oauth.oauth_signature = btoa(String.fromCharCode(...sig))
  return 'OAuth ' + Object.entries(oauth).map(([a, b]) => `${enc(a)}="${enc(b)}"`).join(', ')
}
