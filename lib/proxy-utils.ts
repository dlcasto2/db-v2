import { DEFAULT_ENGINE } from "@/lib/search-engines"

export interface ProxyResponse {
  /** HTML (already rewritten by the proxy) to render via srcDoc */
  content?: string
  /** Object URL for non-HTML responses (images, PDFs, text) to render via src */
  frameSrc?: string
  contentType: string
  status: number
  /** URL after redirects — use this as the page's address */
  finalUrl: string
  title: string
  favicon?: string
  /**
   * Set when the address turned out to be a file to save (an archive, an
   * installer, anything too big for one response) instead of a page: nothing
   * was loaded yet. Fetch it with downloadThroughProxy.
   */
  download?: ProxyDownload
}

export interface ProxyDownload {
  name: string
  type: string
  /** Bytes, when the site said */
  size: number | null
}

export interface ProxyRequestOptions {
  method?: "GET" | "POST"
  /** urlencoded form body for POST */
  body?: string
  signal?: AbortSignal
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function decodeEntities(text: string): string {
  if (typeof DOMParser === "undefined") return text
  return new DOMParser().parseFromString(text, "text/html").documentElement.textContent || text
}

// Text-like types are shown as plain text so the frame displays them instead of
// executing them (SVG and XML can carry scripts) or downloading them
const TEXTUAL_TYPE = /^(text\/|application\/(json|javascript|x-javascript|ecmascript|xml|typescript|ld\+json|manifest\+json))/i

// Identity-provider detection lives in its own import-free module so it can
// be unit-tested directly; re-exported so callers keep importing from here.
export {
  STRICT_IDENTITY_HOSTS,
  directIdentityUrl,
  identityHandoff,
  isStrictIdentityUrl,
  type IdentityHandoff,
} from "@/lib/identity-hosts"

/**
 * Best-effort, fire-and-forget note that a sign-in to `idpUrl` was blocked
 * (see isStrictIdentityUrl) instead of attempted, so it shows up in the
 * server's own logs — which identity providers visitors actually hit, and
 * from where — without building a whole analytics pipeline for it. Never
 * contacts the identity provider itself.
 */
export function reportIdpBlock(idpUrl: string, referrer?: string) {
  try {
    const params = new URLSearchParams({ idpBlocked: "1", url: idpUrl })
    if (referrer) params.set("ref", referrer)
    void fetch(`/api/proxy?${params.toString()}`, { keepalive: true }).catch(() => {})
  } catch {
    // best-effort only — never let a logging call break navigation
  }
}

export async function fetchThroughProxy(url: string, options: ProxyRequestOptions = {}): Promise<ProxyResponse> {
  const { method = "GET", body, signal } = options

  const response =
    method === "POST"
      ? await fetch("/api/proxy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, body: body ?? "", contentType: "application/x-www-form-urlencoded" }),
          signal,
        })
      : // nav=1: this is a tab load, so a file download comes back as a
        // description of the file instead of the file (see ProxyResponse.download)
        await fetch(`/api/proxy?url=${encodeURIComponent(url)}&nav=1`, { signal })

  const finalUrl = response.headers.get("x-proxy-final-url")

  // No final-URL header means the proxy itself failed (blocked, timeout, DNS...)
  if (!finalUrl) {
    let message = `HTTP ${response.status}`
    try {
      const data = await response.json()
      message = data.error || message
    } catch {
      // not JSON
    }
    throw new Error(message)
  }

  const contentType = response.headers.get("content-type") || "application/octet-stream"
  const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml")
  // Loaded through the proxy too, so icons show on networks that block Google
  const favicon = `/api/proxy?url=${encodeURIComponent(`https://www.google.com/s2/favicons?domain=${safeHostname(finalUrl)}&sz=32`)}&raw=1`

  if (response.headers.get("x-devon-download") === "1") {
    let info: Partial<ProxyDownload> = {}
    try {
      info = ((await response.json()) as { download?: Partial<ProxyDownload> }).download ?? {}
    } catch {
      // fall back to what the URL says
    }
    const name =
      typeof info.name === "string" && info.name ? info.name : fileNameFromPath(finalUrl) || "download"
    return {
      contentType,
      status: response.status,
      finalUrl,
      title: name,
      favicon,
      download: {
        name,
        type: typeof info.type === "string" && info.type ? info.type : "application/octet-stream",
        size: typeof info.size === "number" && info.size > 0 ? info.size : null,
      },
    }
  }

  if (isHtml) {
    // Like a real browser, show the site's own error pages (404 etc.) too
    const content = await response.text()
    const titleMatch = content.match(/<title[^>]*>([^<]*)<\/title>/i)
    const title = titleMatch?.[1].trim() ? decodeEntities(titleMatch[1].trim()) : safeHostname(finalUrl)
    return { content, contentType, status: response.status, finalUrl, title, favicon }
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`.trim())
  }

  let blob = await response.blob()
  if (TEXTUAL_TYPE.test(contentType) || contentType.includes("svg")) {
    // SVG is rendered in a script-less sandbox, so it can keep its type
    if (!contentType.includes("svg")) blob = new Blob([blob], { type: "text/plain; charset=utf-8" })
  }

  const fileName = new URL(finalUrl).pathname.split("/").filter(Boolean).pop()
  let title = safeHostname(finalUrl)
  if (fileName) {
    try {
      title = decodeURIComponent(fileName)
    } catch {
      title = fileName
    }
  }
  return {
    frameSrc: URL.createObjectURL(blob),
    contentType,
    status: response.status,
    finalUrl,
    title,
    favicon,
  }
}

function fileNameFromPath(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() || ""
    try {
      return decodeURIComponent(last)
    } catch {
      return last
    }
  } catch {
    return ""
  }
}

/** Slice size for downloads — under every host's single-response cap (EdgeOne's is a few MB) */
export const DOWNLOAD_SLICE_SIZE = 2 * 1024 * 1024
/** 2 GB at the slice size: past that, a download held in memory isn't sensible */
const MAX_DOWNLOAD_SLICES = 1024
const SLICE_RETRIES = 2

export interface DownloadProgress {
  received: number
  /** Bytes in the whole file, when known */
  total: number | null
}

/**
 * Downloads a file through the proxy in slices (its ?slice= mode) and returns
 * it whole. One response can't carry more than a few MB on hosts like EdgeOne,
 * so a big file (a 190 MB repo archive, an installer) only gets through this
 * way. Each slice is retried a couple of times, since one flaky request
 * shouldn't throw away the hundreds of MB already fetched.
 */
export async function downloadThroughProxy(
  url: string,
  file: ProxyDownload,
  options: { signal?: AbortSignal; onProgress?: (progress: DownloadProgress) => void } = {},
): Promise<Blob> {
  const { signal, onProgress } = options
  const parts: ArrayBuffer[] = []
  let received = 0
  let total = file.size

  for (let i = 0; ; i++) {
    if (i >= MAX_DOWNLOAD_SLICES) throw new Error("This file is too big to download through Devon (over 2 GB).")
    const sliceUrl = `/api/proxy?url=${encodeURIComponent(url)}&raw=1&slice=${i}&sliceSize=${DOWNLOAD_SLICE_SIZE}`

    let response: Response | null = null
    let lastError: unknown
    for (let attempt = 0; attempt <= SLICE_RETRIES; attempt++) {
      if (attempt > 0) await sleep(attempt * 1500, signal)
      try {
        const res = await fetch(sliceUrl, { signal })
        if (res.ok) {
          response = res
          break
        }
        let message = `HTTP ${res.status}`
        try {
          message = (await res.json()).error || message
        } catch {
          // not JSON
        }
        lastError = new Error(message)
      } catch (error) {
        if (signal?.aborted) throw error
        lastError = error
      }
    }
    if (!response) throw lastError instanceof Error ? lastError : new Error(String(lastError))

    const headerTotal = Number(response.headers.get("x-devon-total"))
    if (Number.isFinite(headerTotal) && headerTotal > 0) total = headerTotal
    const part = await response.arrayBuffer()
    parts.push(part)
    received += part.byteLength
    onProgress?.({ received, total })
    if (response.headers.get("x-devon-more") !== "1") break
  }

  return new Blob(parts, { type: file.type })
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"))
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException("Aborted", "AbortError"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export function isValidUrl(string: string): boolean {
  try {
    new URL(string)
    return true
  } catch {
    return false
  }
}

/** Whether what was typed is a search rather than an address */
export function isSearchInput(input: string): boolean {
  const trimmed = input.trim()
  if (/^https?:\/\//i.test(trimmed) && isValidUrl(trimmed)) return false
  return !trimmed.includes(".") || /\s/.test(trimmed)
}

/**
 * The results page to open for a search.
 *
 * Which engine answers depends on where Devon is deployed — engines refuse
 * datacenter addresses, and not the same ones — so the server picks (and
 * remembers) one that actually answers. If it can't be asked, the default
 * engine stands in, which is no worse than not asking at all.
 */
export async function resolveSearchUrl(query: string, signal?: AbortSignal): Promise<string> {
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal, cache: "no-store" })
    if (res.ok) {
      const data = (await res.json()) as { url?: unknown }
      if (typeof data?.url === "string" && data.url) return data.url
    }
  } catch {
    // offline, or no /api/search on this deployment
  }
  return DEFAULT_ENGINE.url(query)
}

export function formatUrl(input: string): string {
  const trimmed = input.trim()

  // Already a full http(s) URL (e.g. from history or a link) — use as-is
  if (/^https?:\/\//i.test(trimmed) && isValidUrl(trimmed)) {
    return trimmed
  }

  // If it looks like a search query, use a search engine. This is the default
  // one; a real navigation resolves the engine first (see resolveSearchUrl),
  // and this stands in when that can't be reached.
  if (isSearchInput(trimmed)) {
    return DEFAULT_ENGINE.url(trimmed)
  }

  return `https://${trimmed}`
}

export function getFileExtension(url: string): string {
  try {
    const pathname = new URL(url).pathname
    const lastSegment = pathname.split("/").pop() || ""
    return lastSegment.includes(".") ? lastSegment.split(".").pop()!.toLowerCase() : ""
  } catch {
    return ""
  }
}

export function isScriptFile(url: string): boolean {
  return ["js", "mjs", "jsx", "ts", "tsx", "json"].includes(getFileExtension(url))
}

export function isStyleFile(url: string): boolean {
  return getFileExtension(url) === "css"
}

export function isReactFile(url: string): boolean {
  return ["jsx", "tsx"].includes(getFileExtension(url))
}

export function isNodeFile(url: string): boolean {
  return ["js", "mjs", "ts", "json", "node"].includes(getFileExtension(url))
}
