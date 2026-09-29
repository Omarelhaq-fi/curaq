import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { verifyFirebaseIdToken } from '@/lib/firebase.server'
import { getCorsHeaders } from '@/lib/cors'
import { getClientIp, rateLimit, rateLimitResponse } from '@/lib/rate-limit.server'

const Body = z.object({
  url: z.string().min(1).max(500),
  lang: z.string().max(10).optional(),
})

function extractVideoId(input: string): string | null {
  try {
    if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input
    const u = new URL(input.trim())
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).split('/')[0] || null
    if (u.hostname.includes('youtube.com') || u.hostname.includes('youtube-nocookie.com')) {
      const v = u.searchParams.get('v')
      if (v) return v
      const parts = u.pathname.split('/').filter(Boolean)
      const idx = parts.findIndex(p => ['embed', 'shorts', 'live', 'v'].includes(p))
      if (idx >= 0 && parts[idx + 1]) return parts[idx + 1]
    }
    return null
  } catch { return null }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
}

type CaptionTrack = { baseUrl: string; languageCode: string; kind?: string; name?: { simpleText?: string } }

const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const UA_ANDROID = 'com.google.android.youtube/19.09.37 (Linux; U; Android 14) gzip'
const UA_IOS = 'com.google.ios.youtube/19.09.3 (iPhone14,3; U; CPU iOS 17_1 like Mac OS X)'
const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'

// SSRF guard: allowlist hosts the transcript fetcher may hit.
const ALLOWED_CAPTION_HOSTS = new Set([
  'www.youtube.com',
  'youtube.com',
  'youtubei.googleapis.com',
  'video.google.com',
  'www.google.com',
])

// Reject anything that looks like an IP literal, .local mDNS, or a hostname
// with no dots (internal service names). Defense against DNS-rebinding: even
// if a hostname passes the allowlist, its literal form must be a normal FQDN.
function isSuspiciousHostname(host: string): boolean {
  if (!host) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === 'localhost') return true;
  // IPv4 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  // IPv6 literal in brackets or with colons
  if (host.startsWith('[') || host.includes(':')) return true;
  // Must contain a dot (public FQDN)
  if (!host.includes('.')) return true;
  return false;
}

function isAllowedCaptionUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:') return false
    if (isSuspiciousHostname(u.hostname)) return false
    return ALLOWED_CAPTION_HOSTS.has(u.hostname)
  } catch { return false }
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

async function safeFetch(url: string, init: RequestInit): Promise<Response> {
  // Sanity check on any URL we pass to fetch — reject IP literals & internal names.
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new Error('Non-https URL rejected');
    if (isSuspiciousHostname(u.hostname)) throw new Error('Suspicious hostname rejected');
  } catch (e) { throw new Error(`safeFetch reject: ${(e as Error).message}`); }
  const res = await fetch(url, { ...init, redirect: "manual" });
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`Refused redirect (${res.status})`);
  }
  return res;
}

async function readCapped(res: Response): Promise<string> {
  const cl = Number(res.headers.get("content-length") || 0);
  if (cl && cl > MAX_RESPONSE_BYTES) throw new Error("Response too large");
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_RESPONSE_BYTES) throw new Error("Response too large");
  return new TextDecoder("utf-8").decode(buf);
}

async function playerViaInnertube(videoId: string, client: 'ANDROID' | 'IOS' | 'WEB') {
  const context =
    client === 'ANDROID'
      ? { client: { clientName: 'ANDROID', clientVersion: '19.09.37', androidSdkVersion: 34, hl: 'en', gl: 'US' } }
      : client === 'IOS'
      ? { client: { clientName: 'IOS', clientVersion: '19.09.3', deviceModel: 'iPhone14,3', hl: 'en', gl: 'US' } }
      : { client: { clientName: 'WEB', clientVersion: '2.20240101.00.00', hl: 'en', gl: 'US' } }
  const ua = client === 'ANDROID' ? UA_ANDROID : client === 'IOS' ? UA_IOS : UA_DESKTOP
  const res = await safeFetch(`https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'User-Agent': ua,
      'Accept-Language': 'en-US,en;q=0.9',
      'X-YouTube-Client-Name': client === 'ANDROID' ? '3' : client === 'IOS' ? '5' : '1',
      'X-YouTube-Client-Version': context.client.clientVersion, Origin: 'https://www.youtube.com',
    },
    body: JSON.stringify({ context, videoId, contentCheckOk: true, racyCheckOk: true }),
  })
  if (!res.ok) return null
  const text = await readCapped(res)
  const data = JSON.parse(text) as any
  const title: string = data?.videoDetails?.title || `YouTube ${videoId}`
  const tracks: CaptionTrack[] = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || []
  return { title, tracks }
}

async function fetchTranscript(videoId: string, preferredLang?: string) {
  let payload: { title: string; tracks: CaptionTrack[] } | null = null
  let lastTitle = `YouTube ${videoId}`
  for (const client of ['WEB', 'ANDROID', 'IOS'] as const) {
    try {
      const p = await playerViaInnertube(videoId, client)
      if (p) { lastTitle = p.title || lastTitle; if (p.tracks.length) { payload = p; break } }
    } catch { /* try next */ }
  }
  if (!payload) {
    try {
      const listRes = await safeFetch(
        `https://video.google.com/timedtext?type=list&v=${encodeURIComponent(videoId)}`,
        { headers: { 'User-Agent': UA_DESKTOP } },
      )
      if (listRes.ok) {
        const listXml = await readCapped(listRes)
        const trackRe = /<track[^>]*lang_code="([^"]+)"[^>]*(?:kind="([^"]+)")?[^>]*name="([^"]*)"/g
        const legacy: CaptionTrack[] = []
        let tm: RegExpExecArray | null
        while ((tm = trackRe.exec(listXml)) !== null) {
          const langCode = tm[1]; const name = tm[3] || ''
          const url = `https://video.google.com/timedtext?lang=${encodeURIComponent(langCode)}&v=${encodeURIComponent(videoId)}${name ? `&name=${encodeURIComponent(name)}` : ''}`
          legacy.push({ baseUrl: url, languageCode: langCode })
        }
        if (legacy.length) payload = { title: lastTitle, tracks: legacy }
      }
    } catch { /* ignore */ }
  }
  if (!payload) throw new Error('No captions found for this video.')
  const { title, tracks } = payload

  const norm = (s?: string) => (s || '').toLowerCase()
  const wanted = norm(preferredLang)
  let track: CaptionTrack | undefined
  if (wanted) {
    track =
      tracks.find(t => norm(t.languageCode) === wanted) ||
      tracks.find(t => norm(t.languageCode).startsWith(wanted.slice(0, 2)))
  }
  if (!track) track = tracks.find(t => !t.kind) || tracks[0]

  // SSRF: reject if YouTube handed us an off-domain URL.
  if (!isAllowedCaptionUrl(track.baseUrl)) {
    throw new Error('Caption source is not on an allowed host.')
  }

  const xmlRes = await safeFetch(track.baseUrl, {
    headers: { 'User-Agent': UA_DESKTOP, 'Accept-Language': 'en-US,en;q=0.9' },
  })
  if (!xmlRes.ok) throw new Error(`Failed to fetch captions (${xmlRes.status})`)
  const xml = await readCapped(xmlRes)

  const parts: string[] = []
  const re = /<text[^>]*>([\s\S]*?)<\/text>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const cleaned = decodeEntities(m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
    if (cleaned) parts.push(cleaned)
  }
  const transcript = parts.join(' ').trim()
  if (!transcript) throw new Error('Captions were empty.')
  return { title, transcript }
}

export const Route = createFileRoute('/api/public/youtube-transcript')({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => {
        const cors = getCorsHeaders(request, { methods: 'POST, OPTIONS' })
        return new Response(null, { status: 204, headers: cors })
      },
      POST: async ({ request }) => {
        const cors = getCorsHeaders(request, { methods: 'POST, OPTIONS' })

        // Origin check — reject cross-origin callers not on the CORS allowlist.
        // Same-origin requests (no Origin header) still pass.
        const origin = request.headers.get('origin')
        if (origin && !cors['access-control-allow-origin']) {
          return new Response(JSON.stringify({ error: 'Forbidden' }), {
            status: 403, headers: { 'Content-Type': 'application/json', ...cors },
          })
        }

        // Aggressive IP rate limit (public endpoint).
        const ip = getClientIp(request)
        const ipRl = rateLimit(`yt:ip:${ip}`, 60_000, 5)
        if (!ipRl.ok) return rateLimitResponse(ipRl.retryAfter, cors)

        // Require Firebase auth so this isn't an open proxy.
        const authHeader = request.headers.get('authorization') || ''
        const bm = authHeader.match(/^Bearer\s+(.+)$/i)
        if (!bm) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401, headers: { 'Content-Type': 'application/json', ...cors },
          })
        }
        let user
        try { user = await verifyFirebaseIdToken(bm[1]) }
        catch {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401, headers: { 'Content-Type': 'application/json', ...cors },
          })
        }
        const userRl = rateLimit(`yt:uid:${user.sub}`, 60_000, 10)
        if (!userRl.ok) return rateLimitResponse(userRl.retryAfter, cors)

        try {
          const json = await request.json()
          const parsed = Body.safeParse(json)
          if (!parsed.success) {
            return new Response(JSON.stringify({ error: 'Bad request' }), {
              status: 400, headers: { 'Content-Type': 'application/json', ...cors },
            })
          }
          const videoId = extractVideoId(parsed.data.url)
          if (!videoId) {
            return new Response(JSON.stringify({ error: 'Could not detect a YouTube video ID in that URL.' }), {
              status: 400, headers: { 'Content-Type': 'application/json', ...cors },
            })
          }
          const result = await fetchTranscript(videoId, parsed.data.lang)
          return new Response(JSON.stringify({ videoId, ...result }), {
            status: 200, headers: { 'Content-Type': 'application/json', ...cors },
          })
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : 'Failed to fetch transcript'
          return new Response(JSON.stringify({ error: msg }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...cors },
          })
        }
      },
    },
  },
})
