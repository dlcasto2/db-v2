/**
 * Finds downloadable audio/video files in a proxied page and downloads them
 * through the proxy with Content-Disposition: attachment, so it works the same
 * on desktop, Android and iOS (Safari saves to the Files app).
 *
 * Only real files are found. Streams built in the browser (blob:/MediaSource,
 * as used by most big video sites) and DRM-protected media can't be saved.
 */
import { unproxy } from "@/lib/page-archiver"

export type MediaKind = "audio" | "video"

export interface MediaItem {
  url: string
  name: string
  kind: MediaKind
  ext: string
  /** Where it was found */
  source: "player" | "link" | "network" | "page"
}

const AUDIO_EXT = ["mp3", "wav", "flac", "m4a", "aac", "ogg", "oga", "opus", "weba"]
const VIDEO_EXT = ["mp4", "m4v", "webm", "mov", "ogv", "mkv"]
const MEDIA_EXT_RE = new RegExp(`\\.(${[...AUDIO_EXT, ...VIDEO_EXT].join("|")})$`, "i")

/** File extension from a URL path, lowercased ("" if none) */
export function extOf(url: string): string {
  try {
    const m = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i)
    return m ? m[1].toLowerCase() : ""
  } catch {
    return ""
  }
}

export function isMediaUrl(url: string): boolean {
  try {
    return MEDIA_EXT_RE.test(new URL(url).pathname)
  } catch {
    return false
  }
}

export function kindOf(ext: string, fallback: MediaKind = "video"): MediaKind {
  if (AUDIO_EXT.includes(ext)) return "audio"
  if (VIDEO_EXT.includes(ext)) return "video"
  return fallback
}

export function fileNameOf(url: string, fallback = "media"): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop()
    if (last) return decodeURIComponent(last)
  } catch {
    // fall through
  }
  return fallback
}

function resolve(raw: string | null | undefined, base: string): string | null {
  if (!raw) return null
  const s = raw.trim()
  if (!s || /^(blob|data|mediasource|javascript):/i.test(s)) return null
  try {
    const u = new URL(unproxy(new URL(s, base).href))
    if (u.protocol !== "http:" && u.protocol !== "https:") return null
    u.hash = ""
    return u.href
  } catch {
    return null
  }
}

/** Collects media files from the page's players, links and network activity */
export function findMedia(win: Window, pageUrl: string): MediaItem[] {
  const found = new Map<string, MediaItem>()
  const doc = win.document
  const base = pageUrl

  const add = (raw: string | null | undefined, source: MediaItem["source"], hint?: MediaKind, name?: string) => {
    const url = resolve(raw, base)
    if (!url || found.has(url)) return
    const ext = extOf(url)
    // Players can serve extension-less URLs; links and network entries must look like media
    if (source !== "player" && !MEDIA_EXT_RE.test(new URL(url).pathname)) return
    let fileName = (name || "").trim() || fileNameOf(url)
    if (ext && !fileName.toLowerCase().endsWith(`.${ext}`)) fileName += `.${ext}`
    found.set(url, { url, name: fileName, kind: kindOf(ext, hint), ext: ext || (hint === "audio" ? "mp3" : "mp4"), source })
  }

  doc.querySelectorAll("audio, video").forEach((el) => {
    const media = el as HTMLMediaElement
    const hint: MediaKind = el.tagName === "AUDIO" ? "audio" : "video"
    add(media.currentSrc || media.getAttribute("src"), "player", hint)
    el.querySelectorAll("source[src]").forEach((s) => add(s.getAttribute("src"), "player", hint))
  })

  doc.querySelectorAll("a[href]").forEach((a) => {
    const download = a.getAttribute("download")
    add(a.getAttribute("href"), "link", undefined, download || undefined)
  })

  // Anything the page fetched that looks like a media file
  try {
    for (const entry of win.performance.getEntriesByType("resource")) {
      add(entry.name, "network")
    }
  } catch {
    // not available
  }

  // og:audio / og:video / twitter:player:stream
  doc.querySelectorAll('meta[property^="og:audio"], meta[property^="og:video"], meta[name="twitter:player:stream"]').forEach((m) => {
    const prop = m.getAttribute("property") || m.getAttribute("name") || ""
    if (/:(type|width|height)$/.test(prop)) return
    add(m.getAttribute("content"), "page", prop.includes("audio") ? "audio" : "video")
  })

  // Players first, then links, then everything else
  const order = { player: 0, link: 1, page: 2, network: 3 }
  return [...found.values()].sort((a, b) => order[a.source] - order[b.source])
}

/** Proxy URL that downloads `url` as an attachment named `name` */
export function downloadHref(url: string, name: string, pageUrl?: string): string {
  let href = `/api/proxy?url=${encodeURIComponent(url)}&raw=1&download=${encodeURIComponent(name)}`
  if (pageUrl) href += `&ref=${encodeURIComponent(pageUrl)}`
  return href
}

/** Starts a download without leaving the page (works on iOS Safari too) */
export function startDownload(url: string, name: string, pageUrl?: string) {
  const a = document.createElement("a")
  a.href = downloadHref(url, name, pageUrl)
  a.download = name
  a.rel = "noopener"
  a.style.display = "none"
  document.body.appendChild(a)
  a.click()
  setTimeout(() => a.remove(), 1000)
}

/** File size via a HEAD request through the proxy (null if unknown) */
export async function fetchSize(url: string, pageUrl?: string, signal?: AbortSignal): Promise<number | null> {
  try {
    let href = `/api/proxy?url=${encodeURIComponent(url)}&raw=1`
    if (pageUrl) href += `&ref=${encodeURIComponent(pageUrl)}`
    const res = await fetch(href, { method: "HEAD", signal })
    const length = Number(res.headers.get("content-length"))
    return res.ok && length > 0 ? length : null
  } catch {
    return null
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB"]
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`
}
