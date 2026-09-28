/**
 * Client side of Devon's YouTube page (devon://youtube): routes, download
 * options, the slice-by-slice downloader and in-browser merging with ffmpeg.wasm.
 */

export const YOUTUBE_URL = "devon://youtube"
export const YOUTUBE_ICON = "/youtube-icon.svg"

export type YouTubeRoute = { view: "search"; q: string } | { view: "watch"; id: string }

/** devon://youtube, devon://youtube?q=cats, devon://youtube/watch?v=<id> (or devon://youtube/<id>) */
export function parseYouTubeUrl(input: string): YouTubeRoute | null {
  const m = /^devon:\/\/youtube(?:\/([\w-]*))?\/?(?:\?(.*))?$/i.exec(input.trim())
  if (!m) return null
  const path = (m[1] || "").toLowerCase()
  const params = new URLSearchParams(m[2] || "")
  if (path === "watch") {
    const id = params.get("v") || ""
    return /^[\w-]{11}$/.test(id) ? { view: "watch", id } : { view: "search", q: "" }
  }
  if (path && /^[\w-]{11}$/.test(m[1])) return { view: "watch", id: m[1] }
  if (path && path !== "search") return null
  return { view: "search", q: params.get("q") || "" }
}

export function youTubePageUrl(route: YouTubeRoute): string {
  if (route.view === "watch") return `${YOUTUBE_URL}/watch?v=${route.id}`
  return route.q ? `${YOUTUBE_URL}?q=${encodeURIComponent(route.q)}` : YOUTUBE_URL
}

/** Video ID from any YouTube link (watch, youtu.be, shorts, embed, live, music) */
export function videoIdFromUrl(input: string): string | null {
  const s = input.trim()
  if (/^[\w-]{11}$/.test(s)) return null // a bare word, not a link
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`)
  } catch {
    return null
  }
  const host = url.hostname.replace(/^(www|m|music)\./, "")
  let id: string | null = null
  if (host === "youtu.be") id = url.pathname.split("/")[1] || null
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    id = url.searchParams.get("v")
    const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/)
    if (!id && m) id = m[1]
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null
}

// ---------------------------------------------------------------------------
// API types
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

async function getJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { code: data?.code as string | undefined })
  return data as T
}

export const searchYouTube = (q: string, signal?: AbortSignal) =>
  getJSON<{ items: YTSearchItem[]; next: string | null }>(`/api/youtube/search?q=${encodeURIComponent(q)}`, signal)

export const searchYouTubeMore = (next: string, signal?: AbortSignal) =>
  getJSON<{ items: YTSearchItem[]; next: string | null }>(`/api/youtube/search?next=${encodeURIComponent(next)}`, signal)

export const youTubeSuggestions = (q: string, signal?: AbortSignal) =>
  getJSON<{ suggestions: string[] }>(`/api/youtube/search?suggest=${encodeURIComponent(q)}`, signal).then(
    (d) => d.suggestions,
  )

export const getVideo = (id: string, signal?: AbortSignal) =>
  getJSON<YTVideo>(`/api/youtube/info?id=${encodeURIComponent(id)}`, signal)

/** Thumbnails go through Devon's proxy, so they show even where i.ytimg.com is blocked */
export function thumbnailUrl(id: string, size: "mq" | "hq" | "maxres" = "mq") {
  const file = size === "maxres" ? "maxresdefault" : `${size}default`
  return `/api/proxy?url=${encodeURIComponent(`https://i.ytimg.com/vi/${id}/${file}.jpg`)}&raw=1`
}

export function streamUrl(video: Pick<YTVideo, "id" | "client">, itag: number) {
  return `/api/youtube/stream?id=${video.id}&itag=${itag}&c=${encodeURIComponent(video.client)}`
}

// ---------------------------------------------------------------------------
// Download options
// ---------------------------------------------------------------------------

export type DownloadMode = "direct" | "merge" | "mp3"

export interface DownloadOption {
  key: string
  kind: "video" | "audio"
  label: string
  detail: string
  ext: string
  mode: DownloadMode
  /** Formats to download: [file] for direct/mp3, [video, audio] for merge */
  parts: YTFormat[]
  size: number | null
  badge?: string
}

const sumSizes = (parts: YTFormat[]) => (parts.every((p) => p.size) ? parts.reduce((n, p) => n + (p.size || 0), 0) : null)

const isOriginal = (f: YTFormat) => !f.drc && (!f.language || /original/i.test(f.language) || !/\S/.test(f.language))

function bestAudio(formats: YTFormat[], container: string): YTFormat | undefined {
  const audio = formats.filter((f) => f.hasAudio && !f.hasVideo && f.container === container)
  const originals = audio.filter(isOriginal)
  return (originals.length ? originals : audio).sort((a, b) => b.bitrate - a.bitrate)[0]
}

const codecName = (codec: string) =>
  /^avc1/.test(codec) ? "H.264" : /^av01/.test(codec) ? "AV1" : /^vp0?9/.test(codec) ? "VP9" : /^mp4a/.test(codec) ? "AAC" : /opus/.test(codec) ? "Opus" : codec.split(".")[0]

/** Turns YouTube's format list into the handful of choices people actually want */
export function downloadOptions(video: YTVideo): { video: DownloadOption[]; audio: DownloadOption[] } {
  const formats = video.formats
  const m4a = bestAudio(formats, "mp4")
  const opus = bestAudio(formats, "webm")

  // ---- Video: one entry per resolution, best codec for the container
  const byHeight = new Map<number, DownloadOption>()
  const rank = (codec: string) => (/^avc1/.test(codec) ? 3 : /^av01/.test(codec) ? 2 : /^vp0?9/.test(codec) ? 1 : 0)

  for (const f of formats.filter((f) => f.hasVideo && !f.hasAudio && f.height)) {
    const audio = f.container === "mp4" ? m4a : f.container === "webm" ? opus ?? m4a : undefined
    if (!audio) continue
    const ext = f.container === "mp4" && audio.container === "mp4" ? "mp4" : f.container === "webm" && audio.container === "webm" ? "webm" : "mkv"
    const current = byHeight.get(f.height)
    const option: DownloadOption = {
      key: `v${f.itag}+${audio.itag}`,
      kind: "video",
      label: f.quality || `${f.height}p`,
      detail: `${ext.toUpperCase()} · ${codecName(f.codec)}${f.fps > 30 ? ` · ${f.fps} fps` : ""}`,
      ext,
      mode: "merge",
      parts: [f, audio],
      size: sumSizes([f, audio]),
      badge: f.height >= 2160 ? "4K" : f.height >= 1440 ? "2K" : f.height >= 720 ? "HD" : undefined,
    }
    const better =
      !current ||
      (current.mode === "merge" &&
        (rank(f.codec) > rank(current.parts[0].codec) ||
          (rank(f.codec) === rank(current.parts[0].codec) && f.fps > current.parts[0].fps)))
    if (better) byHeight.set(f.height, option)
  }

  // Formats that already have sound need no merging: prefer them at their height
  for (const f of formats.filter((f) => f.hasVideo && f.hasAudio && f.height)) {
    byHeight.set(f.height, {
      key: `p${f.itag}`,
      kind: "video",
      label: f.quality || `${f.height}p`,
      detail: `${f.container.toUpperCase()} · ${codecName(f.codec)} · ready instantly`,
      ext: f.container || "mp4",
      mode: "direct",
      parts: [f],
      size: f.size,
      badge: "Fast",
    })
  }
  const videoOptions = [...byHeight.entries()].sort((a, b) => b[0] - a[0]).map(([, o]) => o)

  // ---- Audio
  const audioOptions: DownloadOption[] = []
  const bestAny = [m4a, opus].filter(Boolean).sort((a, b) => b!.bitrate - a!.bitrate)[0]
  if (bestAny) {
    audioOptions.push({
      key: `mp3-${bestAny.itag}`,
      kind: "audio",
      label: "MP3",
      detail: "Converted in your browser · 192 kbps",
      ext: "mp3",
      mode: "mp3",
      parts: [bestAny],
      size: bestAny.size,
      badge: "Popular",
    })
  }
  if (m4a) {
    audioOptions.push({
      key: `a${m4a.itag}`,
      kind: "audio",
      label: "M4A",
      detail: `AAC · ${Math.round(m4a.bitrate / 1000)} kbps · original quality`,
      ext: "m4a",
      mode: "direct",
      parts: [m4a],
      size: m4a.size,
    })
  }
  if (opus) {
    audioOptions.push({
      key: `a${opus.itag}`,
      kind: "audio",
      label: "Opus",
      detail: `WebM · ${Math.round(opus.bitrate / 1000)} kbps · original quality`,
      ext: "webm",
      mode: "direct",
      parts: [opus],
      size: opus.size,
    })
  }
  return { video: videoOptions, audio: audioOptions }
}

/** The best format that plays in a <video> by itself (for the preview player) */
export function previewFormat(video: YTVideo): YTFormat | undefined {
  return video.formats
    .filter((f) => f.hasVideo && f.hasAudio && f.container === "mp4")
    .sort((a, b) => b.height - a.height)[0]
}

export function safeFileName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 150) || "video"
  )
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, "0")
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`
}

// ---------------------------------------------------------------------------
// Downloader
// ---------------------------------------------------------------------------

const CHUNK = 3 * 1024 * 1024
const PARALLEL = 3

export interface Progress {
  stage: "download" | "load-ffmpeg" | "process" | "done"
  loaded: number
  total: number | null
  /** 0..1 within the current stage, when known */
  ratio: number | null
}

async function fetchChunk(url: string, start: number, signal: AbortSignal) {
  let lastError: unknown
  for (let attempt = 0; attempt < 4; attempt++) {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError")
    try {
      const res = await fetch(url, { headers: { range: `bytes=${start}-${start + CHUNK - 1}` }, signal })
      if (res.status === 416) return { data: new Uint8Array(0), total: start }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error || `HTTP ${res.status}`)
      }
      const total = res.headers.get("content-range")?.match(/\/(\d+)$/)?.[1]
      return { data: new Uint8Array(await res.arrayBuffer()), total: total ? Number(total) : null }
    } catch (error) {
      if ((error as Error)?.name === "AbortError") throw error
      lastError = error
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)))
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Download failed")
}

/** Downloads one format slice by slice (a few at a time), reporting bytes as they arrive */
export async function downloadFormat(
  video: Pick<YTVideo, "id" | "client">,
  format: YTFormat,
  onBytes: (delta: number, totalKnown: number | null) => void,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const url = streamUrl(video, format.itag)
  const first = await fetchChunk(url, 0, signal)
  const total = first.total ?? format.size
  onBytes(first.data.length, total)

  if (!total) {
    // Size unknown: keep going until a short slice comes back
    const parts = [first.data]
    let start = first.data.length
    let last = first.data.length
    while (last === CHUNK) {
      const next = await fetchChunk(url, start, signal)
      parts.push(next.data)
      onBytes(next.data.length, null)
      last = next.data.length
      start += last
    }
    return join(parts, start)
  }

  const out = new Uint8Array(total)
  out.set(first.data.subarray(0, total), 0)
  const starts: number[] = []
  for (let s = first.data.length; s < total; s += CHUNK) starts.push(s)
  const worker = async () => {
    while (starts.length) {
      const start = starts.shift()!
      let offset = start
      // A slice can come back shorter than asked; fetch the rest before moving on
      while (offset < Math.min(start + CHUNK, total)) {
        const { data } = await fetchChunk(url, offset, signal)
        if (!data.length) throw new Error("The stream ended early")
        const len = Math.min(data.length, Math.min(start + CHUNK, total) - offset)
        out.set(data.subarray(0, len), offset)
        onBytes(len, total)
        offset += len
      }
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker))
  return out
}

function join(parts: Uint8Array[], length: number) {
  const out = new Uint8Array(length)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

const MIME: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
}

/** Runs a whole download option and returns the finished file */
export async function runDownload(
  video: YTVideo,
  option: DownloadOption,
  onProgress: (p: Progress) => void,
  signal: AbortSignal,
): Promise<Blob> {
  const totalKnown = option.parts.every((p) => p.size) ? option.parts.reduce((n, p) => n + (p.size || 0), 0) : null
  let loaded = 0
  const report = () =>
    onProgress({ stage: "download", loaded, total: totalKnown, ratio: totalKnown ? Math.min(1, loaded / totalKnown) : null })
  report()

  // Start loading ffmpeg alongside the download when it's going to be needed
  const needsFFmpeg = option.mode !== "direct"
  const ffmpegPromise = needsFFmpeg ? loadFFmpeg() : null
  ffmpegPromise?.catch(() => {})

  const files: Uint8Array[] = []
  for (const part of option.parts) {
    files.push(
      await downloadFormat(
        video,
        part,
        (delta) => {
          loaded += delta
          report()
        },
        signal,
      ),
    )
  }

  if (option.mode === "direct") {
    onProgress({ stage: "done", loaded, total: loaded, ratio: 1 })
    return new Blob([files[0] as BlobPart], { type: MIME[option.ext] || option.parts[0].mime.split(";")[0] })
  }

  onProgress({ stage: "load-ffmpeg", loaded, total: totalKnown, ratio: null })
  const ffmpeg = await ffmpegPromise!
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError")

  const duration = video.duration || 0
  const onFFProgress = ({ time }: { time: number }) => {
    // time is in microseconds
    const ratio = duration ? Math.min(1, Math.max(0, time / 1_000_000 / duration)) : null
    onProgress({ stage: "process", loaded, total: totalKnown, ratio })
  }
  ffmpeg.on("progress", onFFProgress)
  const abort = () => ffmpeg.terminate()
  signal.addEventListener("abort", abort)
  const inputs: string[] = []
  const output = `out.${option.ext}`
  try {
    onProgress({ stage: "process", loaded, total: totalKnown, ratio: 0 })
    let args: string[]
    if (option.mode === "merge") {
      const [v, a] = option.parts
      inputs.push(`video.${v.container || "mp4"}`, `audio.${a.container === "mp4" ? "m4a" : a.container || "webm"}`)
      await ffmpeg.writeFile(inputs[0], files[0])
      await ffmpeg.writeFile(inputs[1], files[1])
      args = ["-i", inputs[0], "-i", inputs[1], "-map", "0:v:0", "-map", "1:a:0", "-c", "copy"]
      if (option.ext === "mp4") args.push("-movflags", "+faststart")
      args.push(output)
    } else {
      const a = option.parts[0]
      inputs.push(`audio.${a.container === "mp4" ? "m4a" : a.container || "webm"}`)
      await ffmpeg.writeFile(inputs[0], files[0])
      args = ["-i", inputs[0], "-vn", "-c:a", "libmp3lame", "-b:a", "192k", "-id3v2_version", "3",
        "-metadata", `title=${video.title}`, "-metadata", `artist=${video.channel}`, output]
    }
    files.length = 0 // let the originals be garbage collected
    const code = await ffmpeg.exec(args)
    if (code !== 0) throw new Error("Couldn't process the file in your browser.")
    const data = (await ffmpeg.readFile(output)) as Uint8Array
    onProgress({ stage: "done", loaded, total: totalKnown, ratio: 1 })
    return new Blob([data as BlobPart], { type: MIME[option.ext] || "application/octet-stream" })
  } catch (error) {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError")
    throw error
  } finally {
    signal.removeEventListener("abort", abort)
    if (signal.aborted) {
      ffmpegInstance = null
    } else {
      ffmpeg.off("progress", onFFProgress)
      for (const f of [...inputs, output]) await ffmpeg.deleteFile(f).catch(() => {})
    }
  }
}

// ---------------------------------------------------------------------------
// ffmpeg.wasm
// ---------------------------------------------------------------------------

/** The ffmpeg core (~31 MB) comes from a CDN; the small wrapper is served from /vendor/ffmpeg */
const CORE_BASE = process.env.NEXT_PUBLIC_FFMPEG_CORE_URL || "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.9/dist/esm"

interface FFmpegLike {
  load(config: { coreURL: string; wasmURL: string }): Promise<boolean>
  on(event: "progress", cb: (e: { progress: number; time: number }) => void): void
  off(event: "progress", cb: (e: { progress: number; time: number }) => void): void
  writeFile(path: string, data: Uint8Array): Promise<boolean>
  readFile(path: string): Promise<Uint8Array | string>
  deleteFile(path: string): Promise<boolean>
  exec(args: string[]): Promise<number>
  terminate(): void
}

let ffmpegInstance: Promise<FFmpegLike> | null = null

async function blobURL(url: string, type: string) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Couldn't download the converter (HTTP ${res.status})`)
  return URL.createObjectURL(new Blob([await res.arrayBuffer()], { type }))
}

export function loadFFmpeg(): Promise<FFmpegLike> {
  if (!ffmpegInstance) {
    ffmpegInstance = (async () => {
      const path = "/vendor/ffmpeg/index.js"
      const mod = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ path)
      const ffmpeg = new mod.FFmpeg() as FFmpegLike
      const [coreURL, wasmURL] = await Promise.all([
        blobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
        blobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
      ])
      await ffmpeg.load({ coreURL, wasmURL })
      return ffmpeg
    })().catch((error) => {
      ffmpegInstance = null
      throw error
    })
  }
  return ffmpegInstance
}

// ---------------------------------------------------------------------------
// Cookie box (a YouTube cookie saved in this browser, sent only to /api/youtube)
// ---------------------------------------------------------------------------

export interface CookieStatus {
  set: boolean
  cookies?: number
  hasSID?: boolean
}

export const getCookieStatus = () => getJSON<CookieStatus>("/api/youtube/cookie")

export async function saveCookie(cookie: string): Promise<CookieStatus> {
  const res = await fetch("/api/youtube/cookie", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cookie }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || `Couldn't save it (${res.status})`)
  return data as CookieStatus
}

export async function removeCookie(): Promise<void> {
  await fetch("/api/youtube/cookie", { method: "DELETE" })
}
