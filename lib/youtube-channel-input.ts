/**
 * Turns what someone typed into a channel box — a channel ID, an @handle, a
 * youtube.com link or just a name — into how /api/youtube/channel finds it.
 * Kept free of imports so it can be unit tested with a plain `node --test`
 * (see youtube-channel-input.test.mjs).
 */

export type ChannelRef =
  /** A UC… channel ID: no lookup needed */
  | { kind: "id"; id: string }
  /** A youtube.com channel link (handle, /c/, /user/ or legacy custom URL): resolve exactly */
  | { kind: "url"; url: string }
  /** A bare word that may be a handle: try https://www.youtube.com/@word, else search for it */
  | { kind: "handle"; url: string; query: string }
  /** Anything else: the top channel in a channel search */
  | { kind: "search"; query: string }

export const CHANNEL_ID_RE = /^UC[\w-]{22}$/

const YOUTUBE_HOST_RE = /^(?:www\.|m\.)?youtube\.com$/i
/** First path segments of youtube.com pages that are never channels */
const NOT_A_CHANNEL = new Set([
  "watch", "embed", "shorts", "live", "playlist", "results", "feed", "redirect", "hashtag",
  "account", "premium", "music", "gaming", "kids", "about", "t", "s", "signin", "logout", "post", "source",
])

const handleUrl = (handle: string) => `https://www.youtube.com/@${encodeURIComponent(handle)}`

export function parseChannelInput(input: string): ChannelRef | null {
  const raw = input.trim().slice(0, 300)
  if (!raw) return null
  if (CHANNEL_ID_RE.test(raw)) return { kind: "id", id: raw }

  if (raw.startsWith("@")) {
    const handle = raw.slice(1).split(/[/?#\s]/)[0]
    return handle ? { kind: "url", url: handleUrl(handle) } : null
  }

  if (/^https?:\/\//i.test(raw) || /^(?:www\.|m\.)?youtube\.com\//i.test(raw)) {
    let u: URL
    try {
      u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
    } catch {
      return null
    }
    // Only YouTube's own channel pages; never ask YouTube to resolve other sites
    if (!YOUTUBE_HOST_RE.test(u.hostname)) return null
    const parts = u.pathname.split("/").filter(Boolean).map((p) => {
      try {
        return decodeURIComponent(p)
      } catch {
        return p
      }
    })
    const [first, second] = parts
    if (!first) return null
    if (first.startsWith("@")) return first.length > 1 ? { kind: "url", url: handleUrl(first.slice(1)) } : null
    if (first === "channel") return second && CHANNEL_ID_RE.test(second) ? { kind: "id", id: second } : null
    if (first === "c" || first === "user") {
      return second ? { kind: "url", url: `https://www.youtube.com/${first}/${encodeURIComponent(second)}` } : null
    }
    if (NOT_A_CHANNEL.has(first.toLowerCase())) return null
    // Legacy custom URL: youtube.com/SomeName
    return { kind: "url", url: `https://www.youtube.com/${encodeURIComponent(first)}` }
  }

  // One word that could be a handle (letters, digits, _ - .): it's tried as one first
  if (/^[\p{L}\p{N}_.-]{3,30}$/u.test(raw)) return { kind: "handle", url: handleUrl(raw), query: raw }
  return { kind: "search", query: raw }
}
