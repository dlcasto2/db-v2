/**
 * Cross-origin access to Devon's YouTube API (/api/youtube/search, /info,
 * /channel, /status and /stream), so another front-end on a different site —
 * a player page that can't reach youtube.com itself — can use this Devon as
 * its YouTube backend straight from the browser.
 *
 * Only reads are opened up. Credentials are never allowed, so the YouTube
 * cookie a viewer saved in Devon's own cookie box (HttpOnly, SameSite=Strict,
 * scoped to /api/youtube) is never sent or used for another site, and
 * /api/youtube/cookie keeps answering Devon's own page only.
 *
 * Kept free of imports, like youtube-network-error.ts, so it can be unit
 * tested with a plain `node --test` (see youtube-cors.test.mjs).
 *
 * DEVON_YT_CORS:
 *   unset or "*"  any site may read the API (the default)
 *   "off"         no cross-origin access (Devon's own pages only)
 *   a list        comma-separated origins; "https://*.example.com" also
 *                 matches every subdomain of example.com
 */

export type CorsPolicy =
  | { kind: "any" }
  | { kind: "off" }
  | { kind: "list"; exact: string[]; wildcard: { scheme: string; suffix: string }[] }

/** Response headers a cross-origin page may read (for ranged media fetches) */
const EXPOSED = "content-range, accept-ranges, content-length, x-devon-chunk-size"

export function parseCorsSetting(value: string | undefined | null): CorsPolicy {
  const v = (value ?? "").trim().replace(/^["']|["']$/g, "").trim()
  if (!v || v === "*") return { kind: "any" }
  if (/^(off|none|false|0|no)$/i.test(v)) return { kind: "off" }
  const exact: string[] = []
  const wildcard: { scheme: string; suffix: string }[] = []
  for (const piece of v.split(",")) {
    const entry = piece.trim().replace(/\/+$/, "").toLowerCase()
    if (entry === "*") return { kind: "any" }
    const star = entry.match(/^(https?):\/\/\*\.([a-z0-9.-]+(?::\d+)?)$/)
    if (star) {
      wildcard.push({ scheme: star[1], suffix: `.${star[2]}` })
      continue
    }
    if (/^https?:\/\/[a-z0-9.-]+(?::\d+)?$/.test(entry)) exact.push(entry)
  }
  // A list with nothing usable in it means "nobody", not "everybody"
  if (!exact.length && !wildcard.length) return { kind: "off" }
  return { kind: "list", exact, wildcard }
}

/** The Access-Control-Allow-Origin value for a request from `origin`, or null for none */
export function allowedOrigin(policy: CorsPolicy, origin: string | null | undefined): string | null {
  if (policy.kind === "off") return null
  if (policy.kind === "any") return "*"
  if (!origin) return null
  const o = origin.toLowerCase()
  if (policy.exact.includes(o)) return origin
  const m = o.match(/^(https?):\/\/([a-z0-9.-]+(?::\d+)?)$/)
  if (!m) return null
  for (const w of policy.wildcard) {
    if (m[1] === w.scheme && m[2].endsWith(w.suffix) && m[2].length > w.suffix.length) return origin
  }
  return null
}

/**
 * The CORS headers to add to a response. `preflight` adds what an OPTIONS
 * answer needs (a ranged fetch of /stream sends a preflight for its Range
 * header when the range isn't a simple one).
 */
export function corsHeaders(policy: CorsPolicy, origin: string | null | undefined, preflight = false): Record<string, string> {
  const headers: Record<string, string> = {}
  // With a list, the answer depends on who asked: caches must keep them apart
  if (policy.kind === "list") headers["Vary"] = "Origin"
  const allow = allowedOrigin(policy, origin)
  if (!allow) return headers
  headers["Access-Control-Allow-Origin"] = allow
  headers["Access-Control-Expose-Headers"] = EXPOSED
  if (preflight) {
    headers["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS"
    headers["Access-Control-Allow-Headers"] = "range"
    headers["Access-Control-Max-Age"] = "86400"
  }
  return headers
}

/** What /api/youtube/status reports about the setting */
export function describeCors(policy: CorsPolicy): "any" | "off" | string[] {
  if (policy.kind !== "list") return policy.kind
  return [...policy.exact, ...policy.wildcard.map((w) => `${w.scheme}://*${w.suffix}`)]
}
