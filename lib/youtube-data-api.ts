/**
 * Official YouTube Data API v3 adapter.
 *
 * This is the supported metadata/search path for Devon. It deliberately does
 * not request stream URLs, download media, impersonate clients, or solve
 * provider anti-bot challenges. The existing player/embed path remains the
 * playback fallback when this adapter is not configured.
 */
import type { YTSearchItem, YTSearchPage, YTChannelInfo, YTChannelPage } from "./youtube-server"

const API = "https://www.googleapis.com/youtube/v3"
const KEY = (process.env.DEVON_YOUTUBE_DATA_API_KEY || process.env.YOUTUBE_DATA_API_KEY || "").trim()
const ID_RE = /^[\w-]{11}$/
const CHANNEL_RE = /^UC[\w-]{22}$/
const MAX_QUERY = 200
const PAGE_SIZE = 20
const TIMEOUT_MS = 8_000

type ApiError = { error?: { message?: string; code?: number } }
type SearchResponse = {
  items?: Array<{ id?: { videoId?: string; channelId?: string }; snippet?: { title?: string; channelTitle?: string; publishedAt?: string } }>
  nextPageToken?: string
}
type VideoResponse = {
  items?: Array<{ id?: string; contentDetails?: { duration?: string }; statistics?: { viewCount?: string }; liveStreamingDetails?: unknown }>
}
type ChannelResponse = {
  items?: Array<{ id?: string; snippet?: { title?: string; description?: string; customUrl?: string; thumbnails?: Record<string, { url?: string }> }; statistics?: { subscriberCount?: string }; contentDetails?: { relatedPlaylists?: { uploads?: string } } }>
}
type PlaylistResponse = { items?: Array<{ contentDetails?: { videoId?: string } }>; nextPageToken?: string }

export class YouTubeDataApiError extends Error {
  constructor(message: string, public status = 502, public code = "data-api-error") {
    super(message)
    this.name = "YouTubeDataApiError"
  }
}

export function dataApiConfigured(): boolean {
  return Boolean(KEY)
}

function requireKey() {
  if (!KEY) throw new YouTubeDataApiError("The official YouTube Data API is not configured.", 503, "data-api-not-configured")
}

async function get<T>(path: string, params: Record<string, string>): Promise<T> {
  requireKey()
  const url = new URL(`${API}/${path}`)
  for (const [name, value] of Object.entries({ ...params, key: KEY })) url.searchParams.set(name, value)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" }, cache: "no-store" })
    const body = await response.json().catch(() => ({})) as T & ApiError
    if (!response.ok) {
      const message = body?.error?.message
      const status = response.status === 403 ? 503 : response.status === 404 ? 404 : 502
      throw new YouTubeDataApiError(typeof message === "string" ? message.slice(0, 240) : "YouTube Data API request failed.", status, response.status === 403 ? "data-api-quota-or-key" : "data-api-error")
    }
    return body
  } catch (error) {
    if (error instanceof YouTubeDataApiError) throw error
    if (error instanceof Error && error.name === "AbortError") throw new YouTubeDataApiError("YouTube Data API request timed out.", 504, "data-api-timeout")
    throw new YouTubeDataApiError("Couldn't reach the YouTube Data API.", 502, "data-api-network")
  } finally {
    clearTimeout(timer)
  }
}

function durationLabel(value = ""): string {
  const m = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/)
  if (!m) return ""
  const h = Number(m[1] || 0), min = Number(m[2] || 0), sec = Number(m[3] || 0)
  return h ? `${h}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${min}:${String(sec).padStart(2, "0")}`
}

function viewsLabel(value?: string): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return ""
  return new Intl.NumberFormat("en", { notation: n >= 1000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(n) + " views"
}

function encodeToken(value: object): string {
  return "ytdata:" + Buffer.from(JSON.stringify(value)).toString("base64url")
}

function decodeToken<T>(token: string, kind: string): T {
  if (!token.startsWith("ytdata:")) throw new YouTubeDataApiError("Invalid continuation token.", 400, "bad-page-token")
  try {
    const value = JSON.parse(Buffer.from(token.slice(7), "base64url").toString("utf8")) as T & { kind?: string }
    if (value.kind !== kind) throw new Error("wrong token kind")
    return value
  } catch {
    throw new YouTubeDataApiError("Invalid continuation token.", 400, "bad-page-token")
  }
}

async function enrich(items: YTSearchItem[], ids: string[]): Promise<YTSearchItem[]> {
  if (!ids.length) return items
  const result = await get<VideoResponse>("videos", { part: "contentDetails,statistics,liveStreamingDetails", id: ids.join(",") })
  const details = new Map((result.items || []).map(v => [v.id || "", v]))
  return items.map(item => {
    const v = details.get(item.id)
    const live = Boolean(v?.liveStreamingDetails)
    return { ...item, duration: live ? "LIVE" : durationLabel(v?.contentDetails?.duration), views: viewsLabel(v?.statistics?.viewCount) || item.views, live }
  })
}

export async function dataApiSearch(query: string, token = ""): Promise<YTSearchPage> {
  const q = query.trim().slice(0, MAX_QUERY)
  if (!token && !q) throw new YouTubeDataApiError("Type something to search for.", 400, "bad-query")
  const page = token ? decodeToken<{ pageToken?: string; query?: string }>(token, "search") : {}
  const searchQuery = token ? (page.query || q).slice(0, MAX_QUERY) : q
  const result = await get<SearchResponse>("search", {
    part: "snippet", type: "video", maxResults: String(PAGE_SIZE), ...(searchQuery ? { q: searchQuery } : {}),
    ...(page.pageToken ? { pageToken: page.pageToken } : {}),
  })
  const raw = result.items || []
  const items: YTSearchItem[] = raw.flatMap(item => {
    const id = item.id?.videoId
    if (!id || !ID_RE.test(id)) return []
    return [{ id, title: item.snippet?.title || "", channel: item.snippet?.channelTitle || "", duration: "", views: "", published: item.snippet?.publishedAt || "", live: false }]
  })
  const enriched = await enrich(items, items.map(i => i.id))
  return { items: enriched, next: result.nextPageToken ? encodeToken({ kind: "search", pageToken: result.nextPageToken, query: searchQuery }) : null }
}

async function resolveChannel(input: string): Promise<NonNullable<ChannelResponse["items"]>[number]> {
  const value = input.trim()
  if (!value || value.length > 300) throw new YouTubeDataApiError("Type a channel ID, handle or name.", 400, "bad-channel")
  let result: ChannelResponse
  if (CHANNEL_RE.test(value)) {
    result = await get<ChannelResponse>("channels", { part: "snippet,statistics,contentDetails", id: value })
  } else if (/^@?[\w.-]+$/.test(value)) {
    result = await get<ChannelResponse>("channels", { part: "snippet,statistics,contentDetails", forHandle: value.replace(/^@/, "") })
  } else {
    const found = await get<{ items?: Array<{ id?: { channelId?: string } }> }>("search", { part: "snippet", type: "channel", maxResults: "1", q: value })
    const id = found.items?.[0]?.id?.channelId
    if (!id) throw new YouTubeDataApiError("No channel matches that search.", 404, "channel-not-found")
    result = await get<ChannelResponse>("channels", { part: "snippet,statistics,contentDetails", id })
  }
  const channel = result.items?.[0]
  if (!channel?.id) throw new YouTubeDataApiError("YouTube couldn't find that channel.", 404, "channel-not-found")
  return channel
}

function channelInfo(raw: NonNullable<ChannelResponse["items"]>[number]): YTChannelInfo {
  const handle = raw.snippet?.customUrl ? (raw.snippet.customUrl.startsWith("@") ? raw.snippet.customUrl : "@" + raw.snippet.customUrl) : ""
  const id = raw.id || ""
  return {
    id, name: raw.snippet?.title || "", handle,
    avatar: raw.snippet?.thumbnails?.high?.url || raw.snippet?.thumbnails?.medium?.url || raw.snippet?.thumbnails?.default?.url || "",
    subscribers: raw.statistics?.subscriberCount ? viewsLabel(raw.statistics.subscriberCount).replace(" views", " subscribers") : "",
    description: (raw.snippet?.description || "").slice(0, 1000),
    url: handle ? `https://www.youtube.com/${handle}` : `https://www.youtube.com/channel/${id}`,
  }
}

export async function dataApiChannel(input: string, token = ""): Promise<YTChannelPage | YTSearchPage> {
  const page = token ? decodeToken<{ pageToken?: string; channel?: YTChannelInfo; uploads?: string }>(token, "channel") : {}
  const raw = page.channel ? null : await resolveChannel(input)
  const channel = page.channel || channelInfo(raw!)
  const uploads = page.uploads || raw?.contentDetails?.relatedPlaylists?.uploads
  if (!uploads) return { channel, items: [], next: null }
  const playlist = await get<PlaylistResponse>("playlistItems", {
    part: "contentDetails", playlistId: uploads, maxResults: String(PAGE_SIZE), ...(page.pageToken ? { pageToken: page.pageToken } : {}),
  })
  const ids = (playlist.items || []).map(i => i.contentDetails?.videoId || "").filter(id => ID_RE.test(id))
  const details = ids.length ? await get<SearchResponse>("videos", { part: "snippet", id: ids.join(","), maxResults: String(PAGE_SIZE) }) : { items: [] }
  const items: YTSearchItem[] = (details.items || []).flatMap(v => {
    const id = v.id?.videoId || (v as unknown as { id?: string }).id
    if (!id || !ID_RE.test(id)) return []
    return [{ id, title: v.snippet?.title || "", channel: channel.name, duration: "", views: "", published: v.snippet?.publishedAt || "", live: false }]
  })
  const enriched = await enrich(items, items.map(i => i.id))
  return {
    channel, items: enriched,
    next: playlist.nextPageToken ? encodeToken({ kind: "channel", pageToken: playlist.nextPageToken, channel, uploads }) : null,
  }
}

export function isDataApiToken(token: string): boolean {
  return token.startsWith("ytdata:")
}
