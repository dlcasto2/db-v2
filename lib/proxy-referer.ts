/**
 * The Referer the proxy sends upstream for a request that names the page it's
 * shown on with ref= (e.g. Devon's YouTube player, or CoreView embedding
 * Devon's proxied YouTube player). Only http(s) pages count, and the fragment
 * is dropped, as a browser would. Anything else means "no Referer".
 */
export function refererFromRef(ref: string | null | undefined): string | null {
  if (!ref) return null
  try {
    const url = new URL(ref)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    url.hash = ""
    return url.href
  } catch {
    return null
  }
}
