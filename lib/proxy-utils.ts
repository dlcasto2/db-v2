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

/**
 * Hosts whose interactive sign-in page refuses to render inside ANY iframe —
 * a deliberate anti-clickjacking protection on their own end, not something
 * Devon's proxy can route around. Every page Devon shows lives in a
 * same-origin frame (see ProxiedFrame in proxy-browser.tsx), so loading one
 * of these there never shows the real sign-in form, only a generic
 * "something went wrong" page. Worse, even if it did render, that frame's
 * origin genuinely IS Devon's (not spoofed — that's what lets its
 * history.replaceState trick work at all), so a redirect_uri the page builds
 * from window.location.origin would point at Devon, not the real site.
 * Neither problem is fixable inside the proxy; isStrictIdentityUrl's callers
 * detect this ahead of time and offer the real site in an unproxied tab
 * instead of attempting to load it here.
 */
export const STRICT_IDENTITY_HOSTS = [
  "login.microsoftonline.com",
  "login.live.com",
  "login.microsoft.com",
  "accounts.google.com",
  "appleid.apple.com",
]

export function isStrictIdentityUrl(url: string): boolean {
  try {
    return STRICT_IDENTITY_HOSTS.includes(new URL(url).hostname.toLowerCase())
  } catch {
    return false
  }
}

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
      : await fetch(`/api/proxy?url=${encodeURIComponent(url)}`, { signal })

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
