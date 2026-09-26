/**
 * Experimental cookie support for proxied sites.
 *
 * The proxy is stateless, so upstream cookies are stored in the browser as
 * cookies on the proxy's own origin, scoped to /api/proxy and named
 *   dvc.<base64url(domain)>.<base64url(name)>
 * On every proxied request, the ones whose domain matches the target host are
 * decoded and forwarded as the upstream Cookie header. They are HttpOnly, so
 * proxied pages can't read them from document.cookie.
 *
 * Simplifications: cookie paths are ignored (every cookie is sent for its
 * whole domain), and host-only cookies also match subdomains.
 */

export const JAR_PREFIX = "dvc."
export const JAR_PATH = "/api/proxy"
/** Oversized cookies are skipped: every stored cookie rides along on every proxied request */
const MAX_COOKIE_BYTES = 3000

export interface StoredCookie {
  domain: string
  name: string
  value: string
}

export interface JarChange {
  /** Name of the cookie on the proxy origin */
  jarName: string
  /** Already URI-encoded */
  value: string
  /** Seconds; 0 deletes, undefined = session cookie */
  maxAge?: number
}

function b64u(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url")
}

function unb64u(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8")
}

export function jarName(domain: string, name: string): string {
  return `${JAR_PREFIX}${b64u(domain)}.${b64u(name)}`
}

function domainMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

export class CookieJar {
  private cookies = new Map<string, StoredCookie>()
  readonly changes = new Map<string, JarChange>()

  /** Loads the jar from the incoming request's raw Cookie header */
  constructor(cookieHeader: string | null) {
    for (const part of (cookieHeader || "").split(";")) {
      const eq = part.indexOf("=")
      if (eq === -1) continue
      const name = part.slice(0, eq).trim()
      const value = part.slice(eq + 1).trim()
      if (!name.startsWith(JAR_PREFIX)) continue
      const parts = name.slice(JAR_PREFIX.length).split(".")
      if (parts.length !== 2) continue
      try {
        const domain = unb64u(parts[0])
        const cookieName = unb64u(parts[1])
        this.cookies.set(name, { domain, name: cookieName, value: decodeURIComponent(value) })
      } catch {
        // malformed, ignore
      }
    }
  }

  /** Cookie header for a request to this URL, or undefined */
  headerFor(url: URL): string | undefined {
    const host = url.hostname.toLowerCase()
    const pairs: string[] = []
    for (const cookie of this.cookies.values()) {
      if (domainMatches(host, cookie.domain)) pairs.push(`${cookie.name}=${cookie.value}`)
    }
    return pairs.length ? pairs.join("; ") : undefined
  }

  /** Records Set-Cookie headers from an upstream response for this URL */
  absorb(url: URL, setCookieHeaders: string[]): void {
    const host = url.hostname.toLowerCase()

    for (const header of setCookieHeaders) {
      const [pair, ...attributeParts] = header.split(";")
      const eq = pair.indexOf("=")
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (!name) continue

      let domain = host
      let maxAge: number | undefined

      for (const part of attributeParts) {
        const aeq = part.indexOf("=")
        const key = (aeq === -1 ? part : part.slice(0, aeq)).trim().toLowerCase()
        const attrValue = aeq === -1 ? "" : part.slice(aeq + 1).trim()
        if (key === "domain" && attrValue) {
          const d = attrValue.replace(/^\./, "").toLowerCase()
          // A site may only set cookies for itself or a parent domain
          if (!domainMatches(host, d)) {
            domain = ""
            break
          }
          domain = d
        } else if (key === "max-age") {
          const n = parseInt(attrValue, 10)
          if (!Number.isNaN(n)) maxAge = Math.max(0, n)
        } else if (key === "expires" && maxAge === undefined) {
          const t = Date.parse(attrValue)
          if (!Number.isNaN(t)) maxAge = Math.max(0, Math.floor((t - Date.now()) / 1000))
        }
      }
      if (!domain) continue

      const key = jarName(domain, name)
      if (maxAge === 0) {
        this.cookies.delete(key)
        this.changes.set(key, { jarName: key, value: "", maxAge: 0 })
        continue
      }

      const encoded = encodeURIComponent(value)
      if (key.length + encoded.length > MAX_COOKIE_BYTES) continue

      this.cookies.set(key, { domain, name, value })
      this.changes.set(key, { jarName: key, value: encoded, maxAge })
    }
  }
}

/** Set-Cookie header values that apply a jar's changes on the proxy origin */
export function jarSetCookieHeaders(jar: CookieJar, secure: boolean): string[] {
  const out: string[] = []
  for (const change of jar.changes.values()) {
    let header = `${change.jarName}=${change.value}; Path=${JAR_PATH}; HttpOnly; SameSite=Lax`
    if (change.maxAge !== undefined) header += `; Max-Age=${change.maxAge}`
    if (secure) header += "; Secure"
    out.push(header)
  }
  return out
}
