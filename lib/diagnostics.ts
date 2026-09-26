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
        `${i + 1}. <${m.tagName.toLowerCase()}> src=${(m.currentSrc || m.getAttribute("src") || "(none)").slice(0, 90)}`,
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
    const pending = imgs.length - loaded.length - broken.length
    out.push(`Images: ${imgs.length} with a source, ${loaded.length} loaded, ${broken.length} broken, ${pending} still loading`)
    broken.slice(0, 3).forEach((im) => out.push(`   broken: ${(im.currentSrc || im.getAttribute("src") || "").slice(0, 140)}`))
    const lazy = win.document.querySelectorAll("img:not([src]), img[src='']").length
    if (lazy) out.push(`   ${lazy} images have no source yet (waiting for data or scrolling)`)
    const w = win as Window & { MediaSource?: { isTypeSupported?: (t: string) => boolean }; ManagedMediaSource?: unknown }
    out.push(
      `MediaSource: ${w.MediaSource ? "yes" : "no"}, ManagedMediaSource: ${w.ManagedMediaSource ? "yes" : "no"}, H.264 MSE: ${
        w.MediaSource?.isTypeSupported?.('video/mp4; codecs="avc1.42E01E"') ? "yes" : "no"
      }, VP9 MSE: ${w.MediaSource?.isTypeSupported?.('video/webm; codecs="vp9"') ? "yes" : "no"}`,
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
    ...new Set(errors.filter((e) => e.kind !== "network").map((e) => e.proxied).filter((u) => u && u.includes("/api/proxy?"))),
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
