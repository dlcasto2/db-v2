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
import { createHash } from "node:crypto"
import { Innertube, Platform, YTNodes, type Types } from "youtubei.js"

export const CHUNK_SIZE = 3 * 1024 * 1024

// ---------------------------------------------------------------------------
// Settings (environment variables)
// ---------------------------------------------------------------------------

// Hosts differ in when they provide environment variables: some only to the
// build, some only to the running site. Runtime values are read with a computed
// name (so the bundler can't replace them with build-time copies) and build-time
// values come from DEVON_BUILD_ENV (next.config.mjs).
const RUNTIME_ENV: Record<string, string | undefined> = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    return proc?.env ?? {}
  } catch {
    return {}
  }
})()
const BUILD_ENV: Record<string, string> = (() => {
  try {
    return JSON.parse(process.env.DEVON_BUILD_ENV || "{}")
  } catch {
    return {}
  }
})()

/** A DEVON_* setting: the running site's value if it has one, else the build's */
function setting(name: string): string | undefined {
  const runtime = RUNTIME_ENV[name]
  if (runtime && runtime.trim()) return runtime
  const built = BUILD_ENV[name]
  return built && built.trim() ? built : undefined
}

function settingSource(name: string): "runtime" | "build" | null {
  if (RUNTIME_ENV[name]?.trim()) return "runtime"
  if (BUILD_ENV[name]?.trim()) return "build"
  return null
}

/** Removes quotes or whitespace a settings form may have kept around a value */
function unwrap(value: string): string {
  let v = value.trim()
  while (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) v = v.slice(1, -1).trim()
  return v
}

/**
 * The server-wide cookie, from any of:
 *   DEVON_YT_COOKIE      the cookie as pasted (Cookie header or cookies.txt)
 *   DEVON_YT_COOKIE_B64  the same, base64-encoded (for settings forms that refuse
 *                        spaces, ; or =); DEVON_YT_COOKIE_B64_1…20 for it in pieces
 *   DEVON_YT_COOKIE_HEX  the same as hex (0-9 a-f only); DEVON_YT_COOKIE_HEX_1…20
 *   DEVON_YT_COOKIE_1…20 pieces joined in order (for hosts that limit value length)
 */
function readCookieSetting() {
  let raw = ""
  let form: string | null = null
  let source: "runtime" | "build" | null = null
  if (setting("DEVON_YT_COOKIE")) {
    raw = unwrap(setting("DEVON_YT_COOKIE")!)
    form = "DEVON_YT_COOKIE"
    source = settingSource("DEVON_YT_COOKIE")
  } else if (setting("DEVON_YT_COOKIE_HEX") || setting("DEVON_YT_COOKIE_HEX_1")) {
    // Hex (0-9, a-f only) for settings forms that refuse every symbol. One value,
    // or pieces DEVON_YT_COOKIE_HEX_1…20 joined in order.
    let encoded = ""
    if (setting("DEVON_YT_COOKIE_HEX")) {
      form = "DEVON_YT_COOKIE_HEX"
      source = settingSource("DEVON_YT_COOKIE_HEX")
      encoded = unwrap(setting("DEVON_YT_COOKIE_HEX")!)
    } else {
      const parts: string[] = []
      for (let i = 1; i <= 20; i++) {
        const part = setting(`DEVON_YT_COOKIE_HEX_${i}`)
        if (!part) break
        parts.push(unwrap(part))
      }
      encoded = parts.join("")
      form = `DEVON_YT_COOKIE_HEX_1…${parts.length}`
      source = settingSource("DEVON_YT_COOKIE_HEX_1")
    }
    const hex = encoded.replace(/[^0-9a-f]/gi, "")
    raw = hex.length % 2 === 0 ? Buffer.from(hex, "hex").toString("utf8") : ""
  } else if (setting("DEVON_YT_COOKIE_B64") || setting("DEVON_YT_COOKIE_B64_1")) {
    // One value, or pieces DEVON_YT_COOKIE_B64_1…20 joined in order. Standard
    // or URL-safe base64 (letters, digits, - and _ only), padding optional.
    let encoded = ""
    if (setting("DEVON_YT_COOKIE_B64")) {
      form = "DEVON_YT_COOKIE_B64"
      source = settingSource("DEVON_YT_COOKIE_B64")
      encoded = unwrap(setting("DEVON_YT_COOKIE_B64")!)
    } else {
      const parts: string[] = []
      for (let i = 1; i <= 20; i++) {
        const part = setting(`DEVON_YT_COOKIE_B64_${i}`)
        if (!part) break
        parts.push(unwrap(part))
      }
      encoded = parts.join("")
      form = `DEVON_YT_COOKIE_B64_1…${parts.length}`
      source = settingSource("DEVON_YT_COOKIE_B64_1")
    }
    try {
      raw = Buffer.from(encoded.replace(/\s+/g, ""), "base64").toString("utf8")
    } catch {
      raw = ""
    }
  } else if (setting("DEVON_YT_COOKIE_1")) {
    const parts: string[] = []
    for (let i = 1; i <= 20; i++) {
      const part = setting(`DEVON_YT_COOKIE_${i}`)
      if (!part) break
      parts.push(unwrap(part))
    }
    raw = parts.join("")
    form = `DEVON_YT_COOKIE_1…${parts.length}`
    source = settingSource("DEVON_YT_COOKIE_1")
  }
  return { cookie: parseCookies(raw), rawLength: raw.length, form, source }
}

/**
 * DEVON_YT_PROXY: an HTTP(S) proxy (e.g. http://user:pass@host:port) that all
 * YouTube traffic goes through: the API calls and the video bytes. A residential
 * proxy gets around IP blocks without an account.
 */
const PROXY = (setting("DEVON_YT_PROXY") || "").trim()

/**
 * DEVON_YT_COOKIE: cookies from a signed-in YouTube account, for everyone who
 * uses this server. (The YouTube page's cookie box does the same per browser.)
 * Either a Cookie header ("SID=…; HSID=…; …") or a Netscape cookies.txt file.
 */
const COOKIE_SETTING = readCookieSetting()
const COOKIE = COOKIE_SETTING.cookie

/**
 * DEVON_INVIDIOUS: Invidious instances to fall back on when YouTube refuses this
 * server. They fetch the video from their own IPs and relay it (local=true).
 * Comma-separated URLs; "off" disables the fallback.
 */
const DEFAULT_INVIDIOUS = [
  "https://inv.nadeko.net",
  "https://invidious.nerdvpn.de",
  "https://yt.chocolatemoo53.com",
  "https://invidious.tiekoetter.com",
  "https://invidious.f5.si",
  "https://inv.zoomerville.com",
]
const INVIDIOUS: string[] = (() => {
  const env = (setting("DEVON_INVIDIOUS") || "").trim()
  if (/^(off|none|false|0)$/i.test(env)) return []
  const list = env ? env.split(",") : DEFAULT_INVIDIOUS
  return list
    .map((u) => u.trim().replace(/\/+$/, ""))
    .filter((u) => /^https?:\/\/[^/]+$/i.test(u))
})()

function parseCookies(raw: string): string {
  const text = raw.trim()
  if (!text) return ""
  // JSON export from cookie extensions: [{ name, value, domain }, …]
  if (text.startsWith("[")) {
    try {
      const list = JSON.parse(text) as { name?: string; value?: string; domain?: string }[]
      return list
        .filter((c) => c?.name && typeof c.value === "string" && (!c.domain || /youtube\.com$/i.test(c.domain)))
        .map((c) => `${c.name}=${c.value}`)
        .join("; ")
    } catch {
      // not JSON after all
    }
  }
  // Netscape cookies.txt: domain, flag, path, secure, expiry, name, value (tab separated)
  if (text.includes("\t")) {
    const pairs: string[] = []
    for (const line of text.split(/\r?\n/)) {
      const clean = line.replace(/^#HttpOnly_/, "")
      if (!clean || clean.startsWith("#")) continue
      const cols = clean.split("\t")
      if (cols.length >= 7 && /youtube\.com$/.test(cols[0])) pairs.push(`${cols[5]}=${cols[6]}`)
    }
    return pairs.join("; ")
  }
  return text.replace(/^cookie:\s*/i, "").replace(/[\r\n]+/g, "")
}

/** Summary of a cookie string (never the values) */
export function describeCookie(cookie: string) {
  return cookie
    ? { set: true, cookies: cookie.split(";").filter((c) => c.includes("=")).length, hasSID: /(^|;\s*)(__Secure-3PSID|SID)=/.test(cookie) }
    : { set: false }
}

/** What the server can see of its settings (never the values themselves) */
export function settingsStatus(browserCookie = "") {
  return {
    player: "https://www.youtube-nocookie.com",
    cookie: {
      ...describeCookie(COOKIE),
      from: COOKIE_SETTING.form,
      source: COOKIE_SETTING.source,
      receivedLength: COOKIE_SETTING.rawLength,
    },
    // Names only (never values), to see what the host actually passed in
    envSeen: {
      runtime: Object.keys(RUNTIME_ENV).filter((k) => k.startsWith("DEVON_")).sort(),
      build: Object.keys(BUILD_ENV).sort(),
    },
    browserCookie: describeCookie(browserCookie),
    proxy: { set: Boolean(PROXY) },
    invidious: INVIDIOUS,
    clients: clientsFor(browserCookie || COOKIE),
    built: process.env.DEVON_BUILD_TIME || null,
  }
}

// ---------------------------------------------------------------------------
// Cookie saved in the viewer's browser (the YouTube page's cookie box)
// ---------------------------------------------------------------------------

/**
 * /api/youtube/cookie stores the account cookie in the viewer's browser as
 * HttpOnly cookies scoped to /api/youtube: page scripts (including proxied
 * sites) can't read it, and the browser only sends it back to this API.
 */
export const BROWSER_COOKIE_PREFIX = "devon_ytc_"
export const BROWSER_COOKIE_PATH = "/api/youtube"
const BROWSER_COOKIE_PART = 3500
const BROWSER_COOKIE_MAX_PARTS = 6

/** Reads the viewer's saved YouTube cookie from a request's Cookie header */
export function browserCookieFrom(header: string | null): string {
  if (!header) return ""
  const parts: [number, string][] = []
  for (const piece of header.split(";")) {
    const m = piece.trim().match(new RegExp(`^${BROWSER_COOKIE_PREFIX}(\\d+)=(.*)$`))
    if (m && m[2]) parts.push([Number(m[1]), m[2]])
  }
  if (!parts.length) return ""
  parts.sort((a, b) => a[0] - b[0])
  try {
    return parseCookies(Buffer.from(parts.map((p) => p[1]).join(""), "base64url").toString("utf8"))
  } catch {
    return ""
  }
}

/** Set-Cookie headers that save (or, with "", remove) the viewer's YouTube cookie */
export function browserCookieHeaders(value: string): string[] {
  const attrs = `Path=${BROWSER_COOKIE_PATH}; HttpOnly; Secure; SameSite=Strict`
  const encoded = value ? Buffer.from(value, "utf8").toString("base64url") : ""
  const chunks = encoded.match(new RegExp(`.{1,${BROWSER_COOKIE_PART}}`, "g")) ?? []
  if (chunks.length > BROWSER_COOKIE_MAX_PARTS) throw new YTError("That cookie is too long.", 413)
  const out: string[] = []
  for (let i = 0; i < BROWSER_COOKIE_MAX_PARTS; i++) {
    out.push(
      chunks[i]
        ? `${BROWSER_COOKIE_PREFIX}${i}=${chunks[i]}; ${attrs}; Max-Age=31536000`
        : `${BROWSER_COOKIE_PREFIX}${i}=; ${attrs}; Max-Age=0`,
    )
  }
  return out
}

/** Cleans up pasted cookie text: a Cookie header value or a cookies.txt file */
export function normalizeCookie(raw: string): string {
  return parseCookies(raw)
}

/** Clients tried in order until one returns streams that actually download */
function clientsFor(cookie = ""): Types.InnerTubeClient[] {
  const env = setting("DEVON_YT_CLIENTS")?.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean)
  if (env?.length) return env as Types.InnerTubeClient[]
  // With a cookie, clients that send the account's cookies go first
  if (cookie) return ["TV", "WEB", "MWEB", "WEB_EMBEDDED", "TV_EMBEDDED", "TV_SIMPLY", "ANDROID_VR", "IOS"]
  // Some YouTube clients can stream a public video when others get a bot check.
  return ["TV_EMBEDDED", "WEB_EMBEDDED", "TV_SIMPLY", "ANDROID_VR", "TV", "IOS", "MWEB", "WEB"]
}

const keyOf = (cookie: string) => (cookie ? createHash("sha256").update(cookie).digest("hex").slice(0, 16) : "anonymous")

/** YouTube's bot check. It's about the server's IP, so every client gets it. */
export const BOT_CHECK_RE = /not a bot|sign in to confirm|confirm you.re not|unusual traffic|LOGIN_REQUIRED/i

type Fetch = typeof fetch
let proxiedFetch: Promise<Fetch> | null = null

/** fetch, or fetch through DEVON_YT_PROXY when it's set */
function ytFetch(): Promise<Fetch> {
  if (!PROXY) return Promise.resolve(fetch)
  if (!proxiedFetch) {
    proxiedFetch = import("undici").then(({ ProxyAgent, fetch: undiciFetch }) => {
      const dispatcher = new ProxyAgent(PROXY)
      const f = async (input: RequestInfo | URL, init?: RequestInit) => {
        // youtubei.js sometimes passes a Request; undici wants a URL + options
        if (input instanceof Request) {
          const body = input.method === "GET" || input.method === "HEAD" ? undefined : await input.arrayBuffer()
          init = { method: input.method, headers: input.headers, body, signal: input.signal, ...init }
          input = input.url
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return undiciFetch(input as any, { ...(init as any), dispatcher }) as unknown as Response
      }
      return f as Fetch
    })
  }
  return proxiedFetch
}

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

/** One YouTube session per cookie (none, the server's, or a viewer's) */
const sessions = new Map<string, { promise: Promise<Innertube>; born: number }>()
const SESSION_TTL = 6 * 60 * 60 * 1000

function yt(cookie = ""): Promise<Innertube> {
  const key = keyOf(cookie)
  const hit = sessions.get(key)
  if (hit && Date.now() - hit.born < SESSION_TTL) return hit.promise
  const promise = ytFetch()
    .then((f) =>
      Innertube.create({
        retrieve_player: true,
        lang: "en",
        location: "US",
        fetch: f,
        ...(cookie ? { cookie } : {}),
      }),
    )
    .catch((error) => {
      sessions.delete(key)
      throw error
    })
  sessions.set(key, { promise, born: Date.now() })
  if (sessions.size > 20) sessions.delete(sessions.keys().next().value as string)
  return promise
}

/** Throws away a session, e.g. after YouTube rotated its player script */
function resetSession(cookie = "") {
  sessions.delete(keyOf(cookie))
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
  client: string
  /** Cookie used to unlock it ("" when anonymous) */
  cookie: string
  /** "youtube" (this server asked YouTube) or "invidious" (relayed by an instance) */
  source: "youtube" | "invidious"
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
/** How long finding working streams may take; the host cuts requests off after that */
const RESOLVE_BUDGET = Math.min(60_000, Math.max(5_000, Number(setting("DEVON_YT_BUDGET_MS")) || 24_000))
/** YouTube clients tried at the same time */
const CLIENT_WAVE = 3

export class YTError extends Error {
  constructor(
    message: string,
    public status = 502,
    /** "bot-check" when YouTube is blocking this server's IP */
    public code?: string,
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
  if (r.source === "invidious") throw new YTError("That format isn't available for this video.", 404)
  const f = r.raw.get(itag)
  if (!f) throw new YTError("That format isn't available for this video.", 404)
  const client = await yt(r.cookie)
  const url = await f.decipher(client.session.player)
  if (!url) throw new YTError("Couldn't unlock this format.", 502)
  const full = `${url}${url.includes("?") ? "&" : "?"}cpn=${cpn()}`
  r.urls.set(itag, full)
  return full
}

/** Asks googlevideo (or an Invidious relay) for a byte range */
async function fetchRange(r: Resolved, url: string, start: number, end: number, signal?: AbortSignal) {
  if (r.source === "invidious") {
    return fetch(url, { headers: { accept: "*/*", range: `bytes=${start}-${end}` }, signal, redirect: "follow" })
  }
  const f = await ytFetch()
  return f(`${url}&range=${start}-${end}`, { headers: STREAM_HEADERS, signal, redirect: "follow" })
}

// ---------------------------------------------------------------------------
// Invidious fallback
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invidiousFormat(f: any, muxed: boolean): YTFormat | null {
  const itag = Number(f.itag)
  const mime = String(f.type || "")
  if (!itag || !f.url || !mime) return null
  const container = (mime.match(/^\w+\/([\w-]+)/)?.[1] || f.container || "").toLowerCase()
  const codec = mime.match(/codecs="([^"]+)"/)?.[1] || f.encoding || ""
  const isVideo = mime.startsWith("video/")
  const label = String(f.qualityLabel || f.resolution || "")
  const height = Number(label.match(/(\d{3,4})p/)?.[1]) || Number(String(f.size || "").split("x")[1]) || 0
  return {
    itag,
    mime,
    container,
    codec,
    hasVideo: isVideo,
    hasAudio: muxed || mime.startsWith("audio/"),
    quality: isVideo ? label || (height ? `${height}p` : "") : "",
    height: isVideo ? height : 0,
    fps: Number(f.fps) || 0,
    bitrate: Number(f.bitrate) || 0,
    size: f.clen ? Number(f.clen) : null,
    audioQuality: String(f.audioQuality || ""),
    language: "",
    drc: /drc/i.test(String(f.audioTrack?.id || "")),
  }
}

async function tryInvidious(base: string, id: string): Promise<Resolved> {
  const res = await fetch(`${base}/api/v1/videos/${id}?local=true`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(9000),
  })
  if (!res.ok) throw new Error(`${base}: HTTP ${res.status}`)
  const d = await res.json()
  if (d?.error) throw new Error(`${base}: ${d.error}`)
  const formats: YTFormat[] = []
  const urls = new Map<number, string>()
  for (const [list, muxed] of [
    [d.formatStreams, true],
    [d.adaptiveFormats, false],
  ] as const) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const f of (list as any[]) ?? []) {
      const format = invidiousFormat(f, muxed)
      if (!format || urls.has(format.itag)) continue
      formats.push(format)
      urls.set(format.itag, new URL(String(f.url), base).href)
    }
  }
  if (!formats.some((f) => f.hasAudio) || !formats.some((f) => f.hasVideo)) throw new Error(`${base}: no streams`)
  const r: Resolved = {
    client: "INVIDIOUS",
    cookie: "",
    source: "invidious",
    info: {
      id,
      title: d.title || "YouTube video",
      channel: d.author || "",
      duration: Number(d.lengthSeconds) || 0,
      views: typeof d.viewCount === "number" ? d.viewCount : null,
      description: String(d.description || "").slice(0, 2000),
      live: Boolean(d.liveNow),
      client: "INVIDIOUS",
      formats,
    },
    raw: new Map(),
    urls,
    expires: Date.now() + CACHE_TTL,
  }
  // The relay has to actually serve bytes from here
  const audio = formats.find((f) => f.hasAudio && !f.hasVideo) ?? formats.find((f) => f.hasAudio)!
  const probe = await fetchRange(r, urls.get(audio.itag)!, 0, 1023, AbortSignal.timeout(9000))
  await probe.body?.cancel().catch(() => {})
  if (!probe.ok) throw new Error(`${base}: stream HTTP ${probe.status}`)
  return r
}

/** Asks every Invidious instance at once and takes the first that works */
async function resolveInvidious(id: string): Promise<Resolved | string> {
  if (!INVIDIOUS.length) return "Invidious fallback is off."
  try {
    return await Promise.any(INVIDIOUS.map((base) => tryInvidious(base, id)))
  } catch {
    return "No Invidious instance could relay this video."
  }
}

async function resolveWith(id: string, clientName: Types.InnerTubeClient, cookie: string): Promise<Resolved | string> {
  const client = await yt(cookie)
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
  if (!usable.some((f) => f.has_audio) || !usable.some((f) => f.has_video)) {
    return "This client did not provide both video and audio streams."
  }

  const b = info.basic_info
  const r: Resolved = {
    client: clientName,
    cookie,
    source: "youtube",
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

  // Check actual bytes for both tracks; some clients expose URLs that reject downloads.
  const audio = r.info.formats.find((f) => f.hasAudio && !f.hasVideo) ?? r.info.formats.find((f) => f.hasAudio)!
  const video = r.info.formats.find((f) => f.hasVideo && !f.hasAudio) ?? r.info.formats.find((f) => f.hasVideo)!
  for (const format of new Map([audio, video].map((f) => [f.itag, f])).values()) {
    const res = await fetchRange(r, await decipher(r, format.itag), 0, 1023, AbortSignal.timeout(7000))
    await res.body?.cancel().catch(() => {})
    if (!res.ok) return `Streams were refused (HTTP ${res.status}).`
  }
  return r
}

/** Finds a client whose streams work for this video. Cached per server instance. */
export async function resolve(id: string, preferred?: string, userCookie = ""): Promise<Resolved> {
  if (!VIDEO_ID_RE.test(id)) throw new YTError("That isn't a YouTube video ID.", 400)
  // A viewer's own cookie (from the cookie box) wins over the server's
  const cookie = userCookie || COOKIE
  const cacheKey = `${id}|${keyOf(cookie)}`
  const hit = cache.get(cacheKey)
  if (hit && hit.expires > Date.now()) return hit
  const inflight = pending.get(cacheKey)
  if (inflight) return inflight

  const remember = (out: Resolved) => {
    cache.set(cacheKey, out)
    if (cache.size > 200) cache.delete(cache.keys().next().value as string)
    return out
  }

  const job = (async () => {
    // A stream request for a video that an Invidious relay unlocked (e.g. on another server instance)
    if (preferred?.toUpperCase() === "INVIDIOUS") {
      const relayed = await resolveInvidious(id)
      if (typeof relayed !== "string") return remember(relayed)
    }
    const order = clientsFor(cookie)
    const pref = preferred?.toUpperCase() as Types.InnerTubeClient | undefined
    if (pref && order.includes(pref)) order.unshift(...order.splice(order.indexOf(pref), 1))
    const reasons: string[] = []

    // The host cuts a request off after a while (EdgeOne answers 504), so the whole
    // search has a time budget: clients are tried a few at a time, the Invidious
    // relays are asked at the same time as YouTube, and nothing may hang.
    const deadline = Date.now() + RESOLVE_BUDGET
    const left = () => deadline - Date.now()
    const withinBudget = <T,>(p: Promise<T>, what: string): Promise<T> =>
      Promise.race([
        p,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what}: timed out`)), Math.max(0, left())).unref?.()),
      ])
    const relay = withinBudget(resolveInvidious(id), "Invidious").catch((e) =>
      e instanceof Error ? e.message : String(e),
    )

    let retried = false
    for (let i = 0; i < order.length && left() > 1500; ) {
      const wave = order.slice(i, i + CLIENT_WAVE)
      const results = await Promise.all(
        wave.map((name) =>
          withinBudget(resolveWith(id, name, cookie), name).catch((e) => (e instanceof Error ? e.message : String(e))),
        ),
      )
      // Keep the preferred order: the first client in the wave that worked wins
      const found = results.find((out): out is Resolved => typeof out !== "string")
      if (found) return remember(found)
      reasons.push(...(results as string[]))
      // A stale player script breaks deciphering; start a fresh session once and redo this wave
      if (!retried && results.some((m) => /decipher|player|signature|n param|nsig/i.test(m as string))) {
        retried = true
        resetSession(cookie)
        continue
      }
      i += CLIENT_WAVE
    }

    // YouTube refused this server: use an Invidious relay if one got through
    const relayed = await relay
    if (typeof relayed !== "string") return remember(relayed)
    reasons.push(relayed)

    if (left() <= 1500 && !reasons.some((r) => BOT_CHECK_RE.test(r) || /HTTP 403/.test(r))) {
      throw new YTError(
        "YouTube took too long to answer this server. Try again in a moment.",
        503,
        "stream-unavailable",
      )
    }

    if (reasons.some((r) => BOT_CHECK_RE.test(r) || /HTTP 403/.test(r))) {
      throw new YTError(
        userCookie
          ? "YouTube still refused this server with the cookie saved in this browser, and no Invidious relay worked. The cookie may be expired or signed out; copy a fresh one."
          : PROXY
          ? "YouTube refused all available download clients through this server's proxy. The server needs an IP that YouTube allows to fetch video files."
          : "YouTube refused all available download clients from this server. The server needs an IP that YouTube allows to fetch video files.",
        503,
        "bot-check",
      )
    }
    throw new YTError(
      "The download server could not get working video and audio streams for this video. Playback in the embedded player may still work.",
      503,
      "stream-unavailable",
    )
  })()
  pending.set(cacheKey, job)
  try {
    return await job
  } finally {
    pending.delete(cacheKey)
  }
}

export async function videoInfo(id: string, userCookie = ""): Promise<YTVideo> {
  return (await resolve(id, undefined, userCookie)).info
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
  userCookie = "",
): Promise<Slice> {
  let r = await resolve(id, client, userCookie)
  let format = r.info.formats.find((f) => f.itag === itag)
  if (!format) throw new YTError("That format isn't available for this video.", 404)

  const total = format.size
  if (total !== null && start >= total) throw new YTError("Range not satisfiable", 416)
  let end = start + CHUNK_SIZE - 1
  if (endWanted !== null && endWanted >= start) end = Math.min(end, endWanted)
  if (total !== null) end = Math.min(end, total - 1)

  const urlFor = async (x: Resolved) => (x.source === "invidious" ? x.urls.get(itag)! : await decipher(x, itag))
  let res = await fetchRange(r, await urlFor(r), start, end, signal)
  if (res.status === 403 || res.status === 410) {
    // Expired URL, or a different server instance: resolve again from scratch
    await res.body?.cancel().catch(() => {})
    cache.delete(`${id}|${keyOf(userCookie || COOKIE)}`)
    r = await resolve(id, r.source === "invidious" ? "INVIDIOUS" : undefined, userCookie)
    format = r.info.formats.find((f) => f.itag === itag)
    if (!format) throw new YTError("That format isn't available anymore.", 404)
    res = await fetchRange(r, await urlFor(r), start, end, signal)
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    throw new YTError(`YouTube refused the stream (HTTP ${res.status}).`, 502)
  }

  let body: ReadableStream<Uint8Array> | null = res.body
  if (r.source === "invidious" && res.status === 200) {
    // The relay ignored the Range header and sent the whole file
    if (start > 0) {
      await res.body?.cancel().catch(() => {})
      throw new YTError("The relay doesn't support partial downloads.", 502)
    }
    const whole = Number(res.headers.get("content-length"))
    if (whole > 0) end = Math.min(end, whole - 1)
    body = body ? limitStream(body, end - start + 1) : body
  } else {
    // googlevideo answers range= with 200 and just those bytes; relays answer 206
    const length = Number(res.headers.get("content-length"))
    if (length > 0) end = start + Math.min(length, end - start + 1) - 1
  }
  const range = res.headers.get("content-range")?.match(/\/(\d+)$/)
  const whole = r.source === "invidious" && res.status === 200 ? Number(res.headers.get("content-length")) || null : null
  return {
    body,
    start,
    end,
    total: total ?? (range ? Number(range[1]) : whole),
    mime: format.mime.split(";")[0] || "application/octet-stream",
  }
}

/** Passes on at most `max` bytes of a stream, then stops reading it */
function limitStream(stream: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  const reader = stream.getReader()
  let sent = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done || !value) {
        controller.close()
        return
      }
      const room = max - sent
      if (value.length >= room) {
        controller.enqueue(value.subarray(0, room))
        sent = max
        controller.close()
        await reader.cancel().catch(() => {})
        return
      }
      sent += value.length
      controller.enqueue(value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}
