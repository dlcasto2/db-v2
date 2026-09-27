/**
 * Server side of Devon's YouTube page: search, video info and streaming.
 *
 * YouTube ties every stream URL to the IP address that asked for it, so the
 * browser can't fetch googlevideo.com URLs itself (that's why videos don't play
 * through the normal proxy). Here the server both asks for the URL and fetches
 * the bytes, so they always come from the same IP. Bytes are served in slices of
 * at most CHUNK_SIZE, which keeps every response under the host's size limit
 * (about 4 MB on EdgeOne) and lets <video> seek with ordinary Range requests.
 */
import vm from "node:vm"
import { Innertube, Platform, YTNodes, type Types } from "youtubei.js"

export const CHUNK_SIZE = 3 * 1024 * 1024

/** Clients tried in order until one returns streams that actually download */
const DEFAULT_CLIENTS: Types.InnerTubeClient[] = ["ANDROID_VR", "TV", "IOS", "WEB_EMBEDDED", "MWEB", "WEB"]
const CLIENTS: Types.InnerTubeClient[] = (() => {
  const env = process.env.DEVON_YT_CLIENTS?.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean)
  return env?.length ? (env as Types.InnerTubeClient[]) : DEFAULT_CLIENTS
})()

const STREAM_HEADERS = {
  accept: "*/*",
  origin: "https://www.youtube.com",
  referer: "https://www.youtube.com/",
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * youtubei.js extracts the signature / "n" functions from YouTube's player
 * script and needs something to run them. They run in a separate V8 context
 * (no access to this server's globals) with a time limit.
 */
Platform.shim.eval = (data, env) => {
  const sandbox = {
    env,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
  }
  // data.output is a function body that ends with `return process(n, sp, sig)`
  const code = `(function () {\n${data.output}\n})()`
  return vm.runInNewContext(code, sandbox, { timeout: 5000 })
}

let session: Promise<Innertube> | null = null
let sessionBorn = 0
const SESSION_TTL = 6 * 60 * 60 * 1000

function yt(): Promise<Innertube> {
  if (!session || Date.now() - sessionBorn > SESSION_TTL) {
    sessionBorn = Date.now()
    session = Innertube.create({ retrieve_player: true, lang: "en", location: "US" }).catch((error) => {
      session = null
      throw error
    })
  }
  return session
}

/** Throws away the session, e.g. after YouTube rotated its player script */
function resetSession() {
  session = null
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface YTSearchItem {
  id: string
  title: string
  channel: string
  duration: string
  views: string
  published: string
  live: boolean
}

export interface YTSearchPage {
  items: YTSearchItem[]
  next: string | null
}

const text = (t: unknown): string => {
  if (!t) return ""
  if (typeof t === "string") return t
  const s = String((t as { toString(): string }).toString?.() ?? "")
  return s === "[object Object]" || s === "N/A" ? "" : s
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toItem(node: any): YTSearchItem | null {
  if (node?.is?.(YTNodes.Video)) {
    const v = node as InstanceType<typeof YTNodes.Video>
    if (!v.video_id) return null
    return {
      id: v.video_id,
      title: text(v.title),
      channel: v.author?.name && v.author.name !== "N/A" ? v.author.name : "",
      duration: v.length_text ? text(v.length_text) : v.duration?.text || "",
      views: text(v.short_view_count) || text(v.view_count),
      published: text(v.published),
      live: Boolean(v.is_live),
    }
  }
  if (node?.is?.(YTNodes.LockupView)) {
    const l = node as InstanceType<typeof YTNodes.LockupView>
    if (l.content_type !== "VIDEO" || !l.content_id) return null
    // Metadata rows look like [channel] [views · published]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = (l.metadata?.metadata as any)?.metadata_rows ?? []
    const parts = rows.map((r) => (r?.metadata_parts ?? []).map((p: { text?: unknown }) => text(p?.text)).filter(Boolean))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const overlays: any[] = (l.content_image as any)?.overlays ?? []
    let duration = ""
    for (const o of overlays) {
      for (const b of o?.badges ?? []) if (!duration && b?.text) duration = String(b.text)
      if (!duration && o?.text) duration = String(o.text)
    }
    return {
      id: l.content_id,
      title: text(l.metadata?.title),
      channel: parts[0]?.[0] ?? "",
      duration,
      views: parts[1]?.[0] ?? "",
      published: parts[1]?.[1] ?? "",
      live: /live/i.test(duration),
    }
  }
  return null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collect(nodes: any[], memo?: any): YTSearchPage {
  const seen = new Set<string>()
  const items: YTSearchItem[] = []
  for (const n of nodes) {
    const item = toItem(n)
    if (item && !seen.has(item.id)) {
      seen.add(item.id)
      items.push(item)
    }
  }
  let next: string | null = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conts: any[] = memo?.getType?.(YTNodes.ContinuationItem) ?? []
  for (const c of conts) {
    const token = c?.endpoint?.payload?.token
    if (typeof token === "string") next = token
  }
  return { items, next }
}

/** Walks a parsed response and collects every node (search results are nested a few levels deep) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function allNodes(memo: any): any[] {
  if (!memo?.getType) return []
  return memo.getType(YTNodes.Video, YTNodes.LockupView)
}

export async function search(query: string): Promise<YTSearchPage> {
  const client = await yt()
  const results = await client.search(query, { type: "video" })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const memo = (results as any).page?.contents_memo ?? (results as any).memo
  const nodes = allNodes(memo)
  return collect(nodes.length ? nodes : [...results.results], memo)
}

export async function searchMore(token: string): Promise<YTSearchPage> {
  const client = await yt()
  const page = await client.actions.execute("/search", { continuation: token, parse: true })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = page as any
  const memo = p.on_response_received_commands_memo ?? p.continuation_contents_memo ?? p.contents_memo
  return collect(allNodes(memo), memo)
}

export async function suggestions(query: string): Promise<string[]> {
  const client = await yt()
  return client.getSearchSuggestions(query)
}

// ---------------------------------------------------------------------------
// Video info
// ---------------------------------------------------------------------------

export interface YTFormat {
  itag: number
  mime: string
  container: string
  codec: string
  hasVideo: boolean
  hasAudio: boolean
  quality: string
  height: number
  fps: number
  bitrate: number
  size: number | null
  audioQuality: string
  language: string
  drc: boolean
}

export interface YTVideo {
  id: string
  title: string
  channel: string
  duration: number
  views: number | null
  description: string
  live: boolean
  client: string
  formats: YTFormat[]
}

interface Resolved {
  client: Types.InnerTubeClient
  info: YTVideo
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: Map<number, any>
  urls: Map<number, string>
  expires: number
}

/** Resolved videos, per server instance. Stream URLs last about 6 hours; keep them for 1. */
const cache = new Map<string, Resolved>()
const pending = new Map<string, Promise<Resolved>>()
const CACHE_TTL = 60 * 60 * 1000

export class YTError extends Error {
  constructor(
    message: string,
    public status = 502,
  ) {
    super(message)
  }
}

export const VIDEO_ID_RE = /^[\w-]{11}$/

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toFormat(f: any): YTFormat {
  const mime = String(f.mime_type || "")
  const container = (mime.match(/^\w+\/([\w-]+)/)?.[1] || "").toLowerCase()
  const codec = mime.match(/codecs="([^"]+)"/)?.[1] || ""
  return {
    itag: f.itag,
    mime,
    container,
    codec,
    hasVideo: Boolean(f.has_video),
    hasAudio: Boolean(f.has_audio),
    quality: f.quality_label || (f.height ? `${f.height}p` : ""),
    height: f.height || 0,
    fps: f.fps || 0,
    bitrate: f.average_bitrate || f.bitrate || 0,
    size: f.content_length ? Number(f.content_length) : null,
    audioQuality: f.audio_quality || "",
    language: f.audio_track?.display_name || f.language || "",
    drc: Boolean(f.is_drc),
  }
}

function cpn(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
  let s = ""
  for (let i = 0; i < 16; i++) s += chars[Math.floor(Math.random() * 64)]
  return s
}

async function decipher(r: Resolved, itag: number): Promise<string> {
  const hit = r.urls.get(itag)
  if (hit) return hit
  const f = r.raw.get(itag)
  if (!f) throw new YTError("That format isn't available for this video.", 404)
  const client = await yt()
  const url = await f.decipher(client.session.player)
  if (!url) throw new YTError("Couldn't unlock this format.", 502)
  const full = `${url}${url.includes("?") ? "&" : "?"}cpn=${cpn()}`
  r.urls.set(itag, full)
  return full
}

/** Asks googlevideo for a byte range */
async function fetchRange(url: string, start: number, end: number, signal?: AbortSignal) {
  return fetch(`${url}&range=${start}-${end}`, { headers: STREAM_HEADERS, signal, redirect: "follow" })
}

async function resolveWith(id: string, clientName: Types.InnerTubeClient): Promise<Resolved | string> {
  const client = await yt()
  const info = await client.getBasicInfo(id, { client: clientName })
  const status = info.playability_status
  if (status?.status && status.status !== "OK") {
    return status.reason || `YouTube says this video is ${status.status.toLowerCase().replace(/_/g, " ")}.`
  }
  const sd = info.streaming_data
  if (!sd) return "YouTube didn't return any streams."
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: any[] = [...(sd.formats ?? []), ...(sd.adaptive_formats ?? [])]
  // Skip DRM and live (HLS/DASH-only) formats; we only serve plain files
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const usable = all.filter((f: any) => f.itag && (f.url || f.signature_cipher || f.cipher) && !f.drm_families?.length)
  if (!usable.length) return info.basic_info.is_live ? "Live streams can't be downloaded." : "No downloadable streams."

  const b = info.basic_info
  const r: Resolved = {
    client: clientName,
    info: {
      id,
      title: b.title || "YouTube video",
      channel: b.author || b.channel?.name || "",
      duration: b.duration || 0,
      views: typeof b.view_count === "number" ? b.view_count : null,
      description: b.short_description || "",
      live: Boolean(b.is_live),
      client: clientName,
      formats: usable.map(toFormat),
    },
    raw: new Map(usable.map((f) => [f.itag, f])),
    urls: new Map(),
    expires: Date.now() + CACHE_TTL,
  }

  // Make sure the streams really download from here (some clients need tokens we don't have)
  const probe = r.info.formats.find((f) => f.hasAudio && !f.hasVideo) ?? r.info.formats[0]
  const url = await decipher(r, probe.itag)
  const res = await fetchRange(url, 0, 1023)
  await res.body?.cancel().catch(() => {})
  if (!res.ok) return `Streams were refused (HTTP ${res.status}).`
  return r
}

/** Finds a client whose streams work for this video. Cached per server instance. */
export async function resolve(id: string, preferred?: string): Promise<Resolved> {
  if (!VIDEO_ID_RE.test(id)) throw new YTError("That isn't a YouTube video ID.", 400)
  const hit = cache.get(id)
  if (hit && hit.expires > Date.now()) return hit
  const inflight = pending.get(id)
  if (inflight) return inflight

  const job = (async () => {
    const order = [...CLIENTS]
    const pref = preferred?.toUpperCase() as Types.InnerTubeClient | undefined
    if (pref && order.includes(pref)) order.unshift(...order.splice(order.indexOf(pref), 1))
    const reasons: string[] = []
    let retried = false
    for (let i = 0; i < order.length; i++) {
      try {
        const out = await resolveWith(id, order[i])
        if (typeof out !== "string") {
          cache.set(id, out)
          if (cache.size > 200) cache.delete(cache.keys().next().value as string)
          return out
        }
        reasons.push(out)
        // Private / removed / region locked: every client will say the same
        if (/private|removed|unavailable|doesn.t exist|terminated|country/i.test(out) && reasons.length >= 2) break
      } catch (error) {
        reasons.push(error instanceof Error ? error.message : String(error))
        // A stale player script breaks deciphering; start a fresh session once
        if (!retried && /decipher|player|signature|n param|nsig/i.test(reasons[reasons.length - 1])) {
          retried = true
          resetSession()
          i--
        }
      }
    }
    const reason = reasons.find((r) => !/HTTP 403|refused/.test(r)) ?? reasons[0] ?? "Unknown error"
    throw new YTError(reason, /private|unavailable|removed|doesn.t exist/i.test(reason) ? 404 : 502)
  })()
  pending.set(id, job)
  try {
    return await job
  } finally {
    pending.delete(id)
  }
}

export async function videoInfo(id: string): Promise<YTVideo> {
  return (await resolve(id)).info
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export interface Slice {
  body: ReadableStream<Uint8Array> | null
  start: number
  end: number
  total: number | null
  mime: string
}

/** Fetches one slice (at most CHUNK_SIZE bytes) of a format, starting at `start` */
export async function streamSlice(
  id: string,
  itag: number,
  start: number,
  endWanted: number | null,
  client?: string,
  signal?: AbortSignal,
): Promise<Slice> {
  let r = await resolve(id, client)
  let format = r.info.formats.find((f) => f.itag === itag)
  if (!format) throw new YTError("That format isn't available for this video.", 404)

  const total = format.size
  if (total !== null && start >= total) throw new YTError("Range not satisfiable", 416)
  let end = start + CHUNK_SIZE - 1
  if (endWanted !== null && endWanted >= start) end = Math.min(end, endWanted)
  if (total !== null) end = Math.min(end, total - 1)

  let res = await fetchRange(await decipher(r, itag), start, end, signal)
  if (res.status === 403 || res.status === 410) {
    // Expired URL, or a different server instance: resolve again from scratch
    await res.body?.cancel().catch(() => {})
    cache.delete(id)
    r = await resolve(id)
    format = r.info.formats.find((f) => f.itag === itag)
    if (!format) throw new YTError("That format isn't available anymore.", 404)
    res = await fetchRange(await decipher(r, itag), start, end, signal)
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    throw new YTError(`YouTube refused the stream (HTTP ${res.status}).`, 502)
  }

  // googlevideo answers range= with 200 and just those bytes
  const length = Number(res.headers.get("content-length"))
  if (length > 0) end = start + length - 1
  const range = res.headers.get("content-range")?.match(/\/(\d+)$/)
  return {
    body: res.body,
    start,
    end,
    total: total ?? (range ? Number(range[1]) : null),
    mime: format.mime.split(";")[0] || "application/octet-stream",
  }
}
