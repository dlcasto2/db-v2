/**
 * Page diagnostics: script errors reported by the proxy's injected script
 * (window.__devonPageError) and a shareable report that re-downloads the
 * failing files to see whether they arrive complete.
 */

export interface PageError {
  kind: "error" | "load" | "network"
  message: string
  /** Real URL of the file (or the page, for inline scripts) */
  file: string
  /** URL the browser actually loaded (through the proxy) */
  proxied: string
  line?: number
  col?: number
  stack?: string
  page?: string
  top?: boolean
  at: number
}

/** A video/player request seen on the page (logged even when it succeeds) */
export interface PageActivity {
  via: string
  method: string
  url: string
  status: number | string
  ms?: number
  type?: string
  length?: string
  proxyError?: string
  detail?: string
  at: number
}

function shortUrl(url: string) {
  try {
    const u = new URL(url)
    const keep = ["itag", "mime", "range", "rn", "alr", "sabr", "c", "clen", "dur"]
      .map((k) => (u.searchParams.has(k) ? `${k}=${u.searchParams.get(k)?.slice(0, 24)}` : ""))
      .filter(Boolean)
      .join("&")
    return `${u.hostname}${u.pathname}${keep ? `?${keep}` : ""}`
  } catch {
    return url.slice(0, 120)
  }
}

/** MP4 sample-entry codes: readable name and a type string to ask the browser about */
const VIDEO_CODECS: Record<string, [string, string]> = {
  avc1: ["H.264", 'video/mp4; codecs="avc1.640028"'],
  avc3: ["H.264", 'video/mp4; codecs="avc3.640028"'],
  hvc1: ["HEVC (H.265)", 'video/mp4; codecs="hvc1.1.6.L120.90"'],
  hev1: ["HEVC (H.265)", 'video/mp4; codecs="hev1.1.6.L120.90"'],
  dvh1: ["Dolby Vision (HEVC)", 'video/mp4; codecs="dvh1.05.06"'],
  dvhe: ["Dolby Vision (HEVC)", 'video/mp4; codecs="dvhe.05.06"'],
  av01: ["AV1", 'video/mp4; codecs="av01.0.08M.08"'],
  vp09: ["VP9", 'video/mp4; codecs="vp09.00.40.08"'],
  vp08: ["VP8", 'video/mp4; codecs="vp08.00.41.08"'],
  mp4v: ["MPEG-4 Visual", 'video/mp4; codecs="mp4v.20.9"'],
}
const AUDIO_CODECS: Record<string, string> = { mp4a: "AAC", Opus: "Opus", "ac-3": "AC-3", "ec-3": "E-AC-3", fLaC: "FLAC", ".mp3": "MP3" }
/** WebM/Matroska codec IDs, found by plain text search in the header */
const WEBM_CODECS: [string, string][] = [
  ["V_VP9", "VP9"], ["V_VP8", "VP8"], ["V_AV1", "AV1"], ["V_MPEG4/ISO/AVC", "H.264"], ["V_MPEGH/ISO/HEVC", "HEVC (H.265)"],
  ["A_OPUS", "Opus"], ["A_VORBIS", "Vorbis"], ["A_AAC", "AAC"],
]

const fourcc = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3])

/** Reads `length` bytes from `start` with a Range request (streams the file up to there if Range is ignored) */
async function readBytes(url: string, start: number, length: number): Promise<{ bytes: Uint8Array; total: number } | null> {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${start + length - 1}` }, cache: "no-store" })
  if (!res.ok || !res.body) return null
  const range = res.headers.get("content-range")
  const total = range ? Number(range.split("/")[1]) : NaN
  const skip = res.status === 206 ? 0 : start
  // Without Range support the whole file streams from byte 0: don't wade through a big one
  if (skip > 16 * 1024 * 1024) {
    res.body.cancel().catch(() => {})
    return null
  }
  const reader = res.body.getReader()
  const out = new Uint8Array(length)
  let got = 0
  let seen = 0
  while (got < length) {
    const { done, value } = await reader.read()
    if (done || !value) break
    let chunk = value
    if (seen + chunk.length <= skip) {
      seen += chunk.length
      continue
    }
    if (seen < skip) {
      chunk = chunk.subarray(skip - seen)
      seen = skip
    }
    const n = Math.min(chunk.length, length - got)
    out.set(chunk.subarray(0, n), got)
    got += n
    seen += n
  }
  reader.cancel().catch(() => {})
  return { bytes: out.subarray(0, got), total }
}

interface Mp4Box {
  type: string
  start: number
  body: number
  end: number
}
function readBox(b: Uint8Array, o: number, limit: number): Mp4Box | null {
  if (o + 8 > limit) return null
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let size = dv.getUint32(o)
  let head = 8
  if (size === 1) {
    if (o + 16 > limit) return null
    size = dv.getUint32(o + 8) * 2 ** 32 + dv.getUint32(o + 12)
    head = 16
  } else if (size === 0) size = limit - o
  if (size < head) return null
  return { type: fourcc(b, o + 4), start: o, body: o + head, end: o + size }
}
function childBoxes(b: Uint8Array, from: number, to: number): Mp4Box[] {
  const list: Mp4Box[] = []
  for (let o = from; o + 8 <= to; ) {
    const box = readBox(b, o, to)
    if (!box || box.end <= o) break
    list.push(box)
    o = box.end
  }
  return list
}
/** Each track's handler (vide/soun) and sample-entry code (avc1, hvc1, mp4a...) from a moov box */
function trackCodecs(moov: Uint8Array): { kind: string; code: string }[] {
  const found: { kind: string; code: string }[] = []
  const top = readBox(moov, 0, moov.length)
  if (!top) return found
  const child = (box: Mp4Box, type: string) => childBoxes(moov, box.body, Math.min(box.end, moov.length)).find((c) => c.type === type)
  for (const trak of childBoxes(moov, top.body, moov.length).filter((c) => c.type === "trak")) {
    const mdia = child(trak, "mdia")
    if (!mdia) continue
    const hdlr = child(mdia, "hdlr")
    const kind = hdlr && hdlr.body + 12 <= moov.length ? fourcc(moov, hdlr.body + 8) : "?"
    const stsd = (() => {
      const minf = child(mdia, "minf")
      const stbl = minf && child(minf, "stbl")
      return stbl && child(stbl, "stsd")
    })()
    if (!stsd || stsd.body + 16 > moov.length) continue
    found.push({ kind, code: fourcc(moov, stsd.body + 12) })
  }
  return found
}

/**
 * Downloads just the header of a failed video (through the proxy, with Range requests)
 * and says which codec it uses and whether this browser can decode it. "No supported
 * streams" errors are usually a codec the device lacks (HEVC without hardware support),
 * not a broken download; this tells the two apart.
 */
async function probeMediaFile(url: string, doc: Document): Promise<string> {
  try {
    const first = await readBytes(url, 0, 65536)
    if (!first || first.bytes.length < 12) return "could not read the file"
    const b = first.bytes
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
      const text = new TextDecoder("latin1").decode(b)
      const codecs = WEBM_CODECS.filter(([id]) => text.includes(id)).map(([, name]) => name)
      return `WebM, codecs: ${codecs.join(", ") || "not found in the first 64 KB"}`
    }
    if (fourcc(b, 4) !== "ftyp") {
      const start = new TextDecoder().decode(b.subarray(0, 60)).replace(/\s+/g, " ")
      return `not a video file: starts with ${JSON.stringify(start)}`
    }
    // Walk the top-level boxes to moov (it may come after a large mdat)
    let pos = 0
    let buf = b
    let bufStart = 0
    const total = first.total
    for (let hop = 0; hop < 12; hop++) {
      if (pos + 16 > bufStart + buf.length) {
        if (Number.isFinite(total) && pos >= total) break
        const more = await readBytes(url, pos, 65536)
        if (!more || more.bytes.length < 8) break
        buf = more.bytes
        bufStart = pos
      }
      const box = readBox(buf, pos - bufStart, buf.length)
      if (!box) break
      const size = box.end - box.start
      if (box.type === "moov") {
        let moov = buf.subarray(box.start, Math.min(box.end, buf.length))
        if (moov.length < size) {
          const whole = await readBytes(url, pos, Math.min(size, 8 * 1024 * 1024))
          if (whole) moov = whole.bytes
        }
        const tracks = trackCodecs(moov)
        if (!tracks.length) return "MP4, but no tracks were found in its header"
        const probe = doc.createElement("video")
        return tracks
          .map((t) => {
            const video = VIDEO_CODECS[t.code]
            if (video) {
              const answer = probe.canPlayType(video[1])
              return `video ${t.code} = ${video[0]}, this browser ${answer ? "can" : "CAN'T"} decode it (canPlayType "${answer}")`
            }
            if (t.code === "encv" || t.code === "enca") return `${t.kind === "soun" ? "audio" : "video"} is encrypted (DRM)`
            return `${t.kind === "soun" ? "audio" : t.kind === "vide" ? "video" : t.kind} ${t.code}${AUDIO_CODECS[t.code] ? ` = ${AUDIO_CODECS[t.code]}` : ""}`
          })
          .join("; ")
      }
      if (box.end <= box.start || size <= 0) break
      pos += size
    }
    return "MP4, but its header (moov) wasn't found"
  } catch (error) {
    return `check failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** State of every <video>/<audio> in the page (and same-origin frames) */
function describePlayers(win: Window | null | undefined): string[] {
  const out: string[] = []
  if (!win) return out
  const READY = ["NOTHING", "METADATA", "CURRENT_DATA", "FUTURE_DATA", "ENOUGH_DATA"]
  const NETWORK = ["EMPTY", "IDLE", "LOADING", "NO_SOURCE"]
  try {
    const media = Array.from(win.document.querySelectorAll("video, audio")) as HTMLMediaElement[]
    media.forEach((m, i) => {
      const buffered: string[] = []
      for (let j = 0; j < m.buffered.length; j++) buffered.push(`${m.buffered.start(j).toFixed(1)}-${m.buffered.end(j).toFixed(1)}`)
      out.push(
        `${i + 1}. <${m.tagName.toLowerCase()}> src=${(m.currentSrc || m.getAttribute("src") || "(none)").slice(0, 160)}`,
      )
      out.push(
        `   ready=${READY[m.readyState] ?? m.readyState} network=${NETWORK[m.networkState] ?? m.networkState} paused=${m.paused} time=${m.currentTime.toFixed(1)}/${Number.isFinite(m.duration) ? m.duration.toFixed(1) : m.duration} buffered=[${buffered.join(", ")}]`,
      )
      if (m.error) out.push(`   error: code ${m.error.code} ${m.error.message || ""}`)
    })
    // Images (thumbnails): how many actually loaded
    const imgs = Array.from(win.document.images).filter((im) => im.currentSrc || im.getAttribute("src"))
    const loaded = imgs.filter((im) => im.complete && im.naturalWidth > 0)
    const broken = imgs.filter((im) => im.complete && im.naturalWidth === 0)
    // loading="lazy" images far from the screen (or hidden) don't load until
    // they're scrolled near, so they aren't stuck
    const waiting = imgs.filter((im) => !im.complete)
    const lazy = waiting.filter((im) => {
      if (im.loading !== "lazy") return false
      const r = im.getBoundingClientRect()
      return (r.width === 0 && r.height === 0) || r.top > win.innerHeight + 1250 || r.bottom < -1250
    })
    const pending = waiting.length - lazy.length
    out.push(
      `Images: ${imgs.length} with a source, ${loaded.length} loaded, ${broken.length} broken, ${pending} still loading` +
        (lazy.length ? `, ${lazy.length} lazy (load when scrolled to)` : ""),
    )
    broken.slice(0, 3).forEach((im) => out.push(`   broken: ${(im.currentSrc || im.getAttribute("src") || "").slice(0, 140)}`))
    const noSource = win.document.querySelectorAll("img:not([src]), img[src='']").length
    if (noSource) out.push(`   ${noSource} images have no source yet (waiting for data or scrolling)`)
    const w = win as Window & { MediaSource?: { isTypeSupported?: (t: string) => boolean }; ManagedMediaSource?: unknown }
    out.push(
      `MediaSource: ${w.MediaSource ? "yes" : "no"}, ManagedMediaSource: ${w.ManagedMediaSource ? "yes" : "no"}, H.264 MSE: ${
        w.MediaSource?.isTypeSupported?.('video/mp4; codecs="avc1.42E01E"') ? "yes" : "no"
      }, VP9 MSE: ${w.MediaSource?.isTypeSupported?.('video/webm; codecs="vp9"') ? "yes" : "no"}`,
    )
    // Which video formats this browser/device can decode at all (HEVC depends on the hardware)
    const probe = win.document.createElement("video")
    out.push(
      `Codecs this browser plays: ${["avc1", "hvc1", "av01", "vp09"]
        .map((c) => `${VIDEO_CODECS[c][0]} ${probe.canPlayType(VIDEO_CODECS[c][1]) ? "yes" : "no"}`)
        .join(", ")}`,
    )
  } catch (error) {
    out.push(`(could not read players: ${error instanceof Error ? error.message : String(error)})`)
  }
  return out
}

const HOST_HEADERS = [
  "server",
  "via",
  "x-powered-by",
  "x-vercel-id",
  "x-vercel-cache",
  "cf-ray",
  "x-nf-request-id",
  "x-render-origin-server",
  "fly-request-id",
  "x-railway-request-id",
  "x-served-by",
]

interface FileCheck {
  url: string
  status: number | string
  contentType?: string
  contentLength?: string
  contentEncoding?: string
  received?: number
  complete?: string
  parses?: string
  tail?: string
  hostHeaders?: Record<string, string>
}

async function checkFile(proxiedUrl: string): Promise<FileCheck> {
  const check: FileCheck = { url: proxiedUrl, status: "?" }
  try {
    const res = await fetch(proxiedUrl, { cache: "no-store" })
    check.status = res.status
    check.contentType = res.headers.get("content-type") ?? undefined
    check.contentLength = res.headers.get("content-length") ?? undefined
    check.contentEncoding = res.headers.get("content-encoding") ?? undefined
    const hostHeaders: Record<string, string> = {}
    for (const h of HOST_HEADERS) {
      const v = res.headers.get(h)
      if (v) hostHeaders[h] = v
    }
    check.hostHeaders = hostHeaders
    const buf = await res.arrayBuffer()
    check.received = buf.byteLength
    if (check.contentLength && !check.contentEncoding) {
      check.complete = Number(check.contentLength) === buf.byteLength ? "yes" : "NO (size mismatch)"
    }
    const text = new TextDecoder().decode(buf)
    check.tail = JSON.stringify(text.slice(-80))
    if (/javascript|ecmascript/i.test(check.contentType || "")) {
      try {
        // Compiles without running anything
        new Function(text)
        check.parses = "yes"
      } catch (error) {
        check.parses = `NO: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  } catch (error) {
    check.status = `fetch failed: ${error instanceof Error ? error.message : String(error)}`
  }
  return check
}

/** Plain-text report to paste into a bug report / chat */
export async function buildReport(
  errors: PageError[],
  pageUrl: string,
  extra: { activity?: PageActivity[]; frame?: Window | null } = {},
): Promise<string> {
  const lines: string[] = []
  lines.push("Devon page report")
  lines.push(`Page: ${pageUrl}`)
  lines.push(`Devon host: ${location.host}`)
  lines.push(`Browser: ${navigator.userAgent}`)
  lines.push(`Time: ${new Date().toISOString()}`)
  lines.push("")
  lines.push(`Errors (${errors.length}):`)
  errors.forEach((e, i) => {
    lines.push(`${i + 1}. [${e.kind}] ${e.message}`)
    lines.push(`   file: ${e.file || "(unknown)"}${e.line ? `:${e.line}:${e.col ?? 0}` : ""}`)
    if (e.proxied && e.proxied !== e.file) lines.push(`   loaded as: ${e.proxied}`)
    if (e.page && e.page !== pageUrl) lines.push(`   in frame: ${e.page}`)
    if (e.stack) lines.push(`   stack: ${e.stack.split("\n").slice(0, 4).join(" | ")}`)
  })

  // Re-download the failing proxied files to see if they arrive intact
  // Only scripts are re-downloaded: a failed request may be a POST (API call)
  const files = [
    ...new Set(
      errors
        .filter((e) => e.kind !== "network")
        .map((e) => e.proxied)
        .filter((u) => u && (u.includes("/api/proxy?") || u.includes("/api/proxy/m/"))),
    ),
  ].slice(0, 6)
  if (files.length) {
    lines.push("")
    lines.push("File checks:")
    const checks = await Promise.all(files.map(checkFile))
    for (const c of checks) {
      lines.push(`- ${c.url}`)
      lines.push(
        `  status ${c.status}, type ${c.contentType ?? "?"}, length header ${c.contentLength ?? "none"}, encoding ${c.contentEncoding ?? "none"}, received ${c.received ?? "?"} bytes`,
      )
      if (c.complete) lines.push(`  complete: ${c.complete}`)
      if (c.parses) lines.push(`  parses: ${c.parses}`)
      if (c.tail) lines.push(`  ends with: ${c.tail}`)
      if (c.hostHeaders && Object.keys(c.hostHeaders).length) lines.push(`  host headers: ${JSON.stringify(c.hostHeaders)}`)
    }
  } else {
    // Still useful to know the host
    try {
      const res = await fetch("/api/proxy", { cache: "no-store" })
      const hostHeaders: Record<string, string> = {}
      for (const h of HOST_HEADERS) {
        const v = res.headers.get(h)
        if (v) hostHeaders[h] = v
      }
      lines.push("")
      lines.push(`Host headers: ${JSON.stringify(hostHeaders)}`)
    } catch {
      // ignore
    }
  }
  const players = describePlayers(extra.frame)
  if (players.length) {
    lines.push("")
    lines.push("Media players:")
    lines.push(...players)
  }
  // Failed videos: read the file's header to see if it's the codec or the download
  try {
    const win = extra.frame
    const failed = win
      ? (Array.from(win.document.querySelectorAll("video, audio")) as HTMLMediaElement[])
          .map((m, i) => ({ i, url: m.currentSrc || m.getAttribute("src") || "", failed: !!m.error || m.networkState === 3 }))
          .filter((m) => m.failed && (m.url.includes("/api/proxy?") || m.url.includes("/api/proxy/m/")))
          .slice(0, 3)
      : []
    if (failed.length && win) {
      lines.push("")
      lines.push("Failed media file checks:")
      for (const m of failed) lines.push(`${m.i + 1}. ${await probeMediaFile(m.url, win.document)}`)
    }
  } catch {
    // ignore
  }

  const activity = extra.activity ?? []
  lines.push("")
  lines.push(`Video & page-data requests (${activity.length}, newest last):`)
  if (!activity.length) lines.push("  none seen")
  for (const a of activity.slice(-25)) {
    lines.push(
      `- ${a.via} ${a.method} ${a.status}${a.proxyError ? " (from Devon's proxy)" : ""} ${a.ms ?? "?"}ms ${a.type || ""} ${a.length ? `${a.length}B` : ""} ${shortUrl(a.url)}`,
    )
    if (a.detail) lines.push(`    response: ${JSON.stringify(a.detail.replace(/\s+/g, " ").slice(0, 200))}`)
  }
  return lines.join("\n")
}
