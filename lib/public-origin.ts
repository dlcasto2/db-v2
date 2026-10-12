import type { NextRequest } from "next/server"

const HOST_RE = /^([a-z0-9-]+\.)*[a-z0-9-]+(:\d{1,5})?$|^\[[0-9a-f:.]+\](:\d{1,5})?$/i

/**
 * Devon's own origin as the browser sees it, e.g. https://devon.example.com.
 *
 * Next's standalone server (how the Dockerfile runs Devon) reports the
 * address it listens on, like http://0.0.0.0:3000, instead of the one the
 * browser used. Proxied pages would then load everything from 0.0.0.0, which
 * browsers refuse. In that case the Host header has the real address (a
 * reverse proxy in front must pass it through). Other hosts, EdgeOne
 * included, report the right origin and are left as they are. The protocol
 * already follows X-Forwarded-Proto.
 */
export function publicOrigin(request: NextRequest): string {
  const url = request.nextUrl
  const wildcard = url.hostname === "0.0.0.0" || url.hostname === "[::]" || url.hostname === "::"
  if (wildcard) {
    const host = request.headers.get("host")?.trim()
    if (host && HOST_RE.test(host)) return `${url.protocol}//${host.toLowerCase()}`
  }
  return url.origin
}
