/**
 * Identity-provider detection, kept free of imports so it can be unit-tested
 * directly with `node --test` (see identity-hosts.test.mjs). proxy-utils.ts
 * re-exports everything here, so callers keep importing from there.
 *
 * Hosts whose interactive sign-in (or account-management) pages refuse to
 * render inside ANY iframe — a deliberate anti-clickjacking protection on
 * their own end, not something Devon's proxy can route around. Every page
 * Devon shows lives in a same-origin frame (see ProxiedFrame in
 * proxy-browser.tsx), so loading one of these there never shows the real
 * form, only a generic "something went wrong" page. Worse, even if it did
 * render, that frame's origin genuinely IS Devon's (not spoofed — that's what
 * lets its history.replaceState trick work at all), so a redirect_uri the
 * page builds from window.location.origin would point at Devon, not the real
 * site. Google additionally refuses sign-in from browsers that proxy or
 * rewrite its traffic. None of this is fixable inside the proxy — and
 * shouldn't be: these pages see passwords and session cookies, which must
 * never pass through Devon's server. isStrictIdentityUrl's callers detect
 * this ahead of time and offer the real site in an unproxied tab instead.
 */
export const STRICT_IDENTITY_HOSTS = [
  "login.microsoftonline.com",
  "login.live.com",
  "login.microsoft.com",
  "accounts.google.com",
  // Google Account settings — where Google sends people after signing in,
  // and a page that only works with a real, unproxied Google session.
  "myaccount.google.com",
  "appleid.apple.com",
]

/**
 * The URL's hostname, lowercased and without a trailing dot. "accounts.google.com."
 * is the same host to DNS (and to the proxy's server-side fetch), so it has to
 * classify the same way or it would slip past the check.
 */
function identityHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "")
  } catch {
    return null
  }
}

export function isStrictIdentityUrl(url: string): boolean {
  const host = identityHostname(url)
  return host !== null && STRICT_IDENTITY_HOSTS.includes(host)
}

/**
 * A clean entry point on the identity provider itself: just its HTTPS origin
 * (e.g. https://accounts.google.com/), safe to open as a real tab.
 *
 * It deliberately drops the path and query of the blocked URL. Those carry
 * the redirect_uri / continue target the page was built with, which points
 * back at Devon's own origin — Microsoft/Google/Apple never have that
 * registered, so opening the blocked URL as-is would reproduce the exact
 * sign-in error (AADSTS50011 and the like) the interstitial exists to avoid,
 * or bounce the user back into the proxy after signing in.
 *
 * Null unless the URL is an HTTPS URL on a strict identity host.
 */
export function directIdentityUrl(url: string): string | null {
  const host = identityHostname(url)
  if (host === null || !STRICT_IDENTITY_HOSTS.includes(host)) return null
  if (new URL(url).protocol !== "https:") return null
  return `https://${host}/`
}

/** Only real web pages can be handed off — never devon://, javascript:, etc. */
function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === "https:" || protocol === "http:"
  } catch {
    return false
  }
}

export interface IdentityHandoff {
  /** The blocked identity-provider URL (shown, never opened) */
  idpUrl: string
  /**
   * The site the user was trying to sign into, opened unproxied — or null
   * when that isn't known or isn't a real web page (a devon:// page, the
   * new-tab page, another identity page).
   */
  destinationUrl: string | null
  /** A clean entry point on the identity provider (see directIdentityUrl) */
  directUrl: string | null
}

/**
 * Decides what the "sign-in can't happen inside Devon" interstitial offers.
 * Both links are opened as ordinary browser tabs, never through /api/proxy,
 * and no cookie or credential moves between them and Devon. It must never
 * fall back to idpUrl itself (see directIdentityUrl for why).
 */
export function identityHandoff(idpUrl: string, previousUrl?: string | null): IdentityHandoff {
  const destinationUrl =
    previousUrl && isWebUrl(previousUrl) && !isStrictIdentityUrl(previousUrl) ? previousUrl : null
  return { idpUrl, destinationUrl, directUrl: directIdentityUrl(idpUrl) }
}
