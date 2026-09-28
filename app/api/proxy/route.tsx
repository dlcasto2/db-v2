import { type NextRequest, NextResponse } from "next/server"
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import http from "node:http"
import https from "node:https"
import { Readable } from "node:stream"
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib"
import { CookieJar, JAR_PATH, JAR_PREFIX, jarSetCookieHeaders } from "@/lib/cookie-jar"
import { DOCUMENT_TYPE_RE, PERMISSIONS_POLICY, SANDBOX_CSP } from "@/lib/sandbox-policy"

// DNS lookups need the Node.js runtime (not Edge)
export const runtime = "nodejs"
// Big files (sites' JavaScript bundles, media) can take a while to stream through;
// hosts that cap function duration (e.g. Vercel) would otherwise cut them off mid-file
export const maxDuration = 60

const PROXY_PATH = "/api/proxy?url="

/**
 * Google's hidden "are you signed in?" check: YouTube (and other Google sites)
 * load it in an invisible frame, e.g. youtube.com/signin?...feature=passive,
 * which redirects to accounts.google.com/...&passive=true. It can't work
 * through a proxy and only produces errors, so Devon answers it with an empty
 * page; the site just treats you as signed out.
 */
const PASSIVE_SIGNIN_SOURCE =
  "^https://(accounts[.]google[.]com/.*[?&]passive=true|accounts[.]google[.]com/(ServiceLogin|RotateCookiesPage)[^#]*passive|(www[.]|m[.])?youtube[.]com/signin[?].*(feature=passive|signin_passive))"
const PASSIVE_SIGNIN_RE = new RegExp(PASSIVE_SIGNIN_SOURCE, "i")
const MAX_REDIRECTS = 10
const TIMEOUT_MS = 30000
/** Cookie the app sets when "Experimental reCAPTCHA support" is on */
const EXPERIMENTAL_COOKIE = "devon_recaptcha"

// Every `.postMessage(` call site becomes `[__devonPM(self,"postMessage")](`. The
// helper runs in the CALLER's realm and records who is sending, so the
// receiving frame can report the right event.source and event.origin (see the
// injected script). It still resolves to the normal postMessage method, so
// ports, workers and unproxied frames behave exactly as before.
const POST_MESSAGE_CALL_RE = /(\?\.|\.)\s*postMessage\s*\(/g
// It contains no quote characters: call sites inside strings (code kept as text,
// HTML attributes) get rewritten too, and quotes there would end the string
// early and break the whole script ("Unexpected keyword 'function'…"). The
// regex literal's .source is the string "postMessage" without any quotes.
const PM_KEY = "(self.__devonPM?self.__devonPM(self,/postMessage/.source):/postMessage/.source)"

function rewritePostMessageCalls(code: string): string {
  return code.replace(POST_MESSAGE_CALL_RE, (_m, dot: string) => (dot === "?." ? `?.[${PM_KEY}](` : `[${PM_KEY}](`))
}

function isExperimental(request: NextRequest): boolean {
  const header = request.headers.get("cookie") || ""
  return header.split(";").some((part) => part.trim() === `${EXPERIMENTAL_COOKIE}=1`)
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

// Regex patterns built via RegExp constructor to prevent bundler escaping issues.
// Static import/export specifiers with a relative, root or absolute http(s) path are
// rewritten; bare specifiers ("react") are left alone.
const IMPORT_FROM_RE = new RegExp(
  '(\\b(?:(?:import|export)\\b[^;\'"`()]*?\\bfrom|import)\\s*)([\'"`])((?:\\.{0,2}/|https?://)[^\'"`]*)\\2',
  "g"
)
const CSS_IMPORT_RE = new RegExp(
  '@import\\s+(?:url[(]\\s*)?([\'"]?)([^\'"()\\s;]+)\\1\\s*[)]?',
  "g"
)
const CSS_URL_RE = new RegExp('url[(]\\s*([\'"]?)([^\'"()]+?)\\1\\s*[)]', "g")

class BlockedUrlError extends Error {}

// ---------------------------------------------------------------------------
// SSRF protection
// ---------------------------------------------------------------------------

function isPrivateIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number)
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true
  const [a, b, c] = p
  return (
    a === 0 || // "this" network, incl. 0.0.0.0
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast + reserved
  )
}

function isPrivateIPv6(ip: string): boolean {
  const s = ip.toLowerCase()
  if (s === "::" || s === "::1") return true

  // IPv4-mapped addresses, dotted (::ffff:127.0.0.1) or hex (::ffff:7f00:1)
  const dotted = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) return isPrivateIPv4(dotted[1])
  const hex = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex) {
    const hi = parseInt(hex[1], 16)
    const lo = parseInt(hex[2], 16)
    return isPrivateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }

  return (
    /^f[cd]/.test(s) || // unique local fc00::/7
    /^fe[89ab]/.test(s) || // link-local fe80::/10
    s.startsWith("ff") || // multicast
    s.startsWith("64:ff9b:") // NAT64 can reach IPv4 internals
  )
}

function isPrivateAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return isPrivateIPv4(address)
  if (family === 6) return isPrivateIPv6(address)
  return true
}

/**
 * Throws BlockedUrlError unless the URL is http(s) and every address its host
 * resolves to is public. The WHATWG URL parser already normalizes numeric
 * forms like http://2130706433 to 127.0.0.1, and resolving DNS catches
 * domains that point at private addresses.
 */
async function assertSafeUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError("Only http and https URLs are supported")
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")

  if (host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal") {
    throw new BlockedUrlError("Target URL is blocked for security reasons")
  }

  let addresses: string[]
  if (isIP(host)) {
    addresses = [host]
  } else {
    try {
      addresses = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address)
    } catch {
      throw new Error(`Could not resolve host: ${host}`)
    }
  }

  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new BlockedUrlError("Target URL is blocked for security reasons")
  }
}

/**
 * Follows redirects manually so every hop is checked by assertSafeUrl.
 * (With redirect: "follow", a public URL could redirect to an internal one.)
 */
interface UpstreamInit {
  method: string
  body?: string | ArrayBuffer
  contentType?: string
  /** Extra request headers forwarded from the page (raw mode) */
  headers?: Record<string, string>
  /** Experimental mode: sends and collects the site's cookies */
  jar?: CookieJar
  /** The browser's Accept-Encoding (passthrough mode relays compressed bodies) */
  acceptEncoding?: string | null
}

async function fetchUpstream(
  startUrl: string,
  init: UpstreamInit,
  signal: AbortSignal,
): Promise<{ response: Response; finalUrl: string }> {
  let current = new URL(startUrl)
  let method = init.method.toUpperCase()
  let body = init.body

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeUrl(current)

    // A Headers object, so forwarded headers replace defaults case-insensitively
    // (a plain object would send both "Accept" and "accept", merged by fetch)
    const headers = new Headers({
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      DNT: "1",
      "Upgrade-Insecure-Requests": "1",
    })
    for (const [key, value] of Object.entries(init.headers ?? {})) headers.set(key, value)
    if (body !== undefined && init.contentType) headers.set("Content-Type", init.contentType)
    const cookie = init.jar?.headerFor(current)
    if (cookie) headers.set("Cookie", cookie)

    const response = await fetch(current, { method, headers, body, redirect: "manual", signal })
    // Absorb cookies from every hop, so redirect chains that set cookies work
    if (init.jar) init.jar.absorb(current, response.headers.getSetCookie?.() ?? [])

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location")
      if (!location) return { response, finalUrl: current.href }
      await response.body?.cancel().catch(() => {})
      current = new URL(location, current)
      // Browsers switch to GET after 303, and after 301/302 for POST
      if (
        (response.status === 303 && method !== "HEAD") ||
        (method === "POST" && (response.status === 301 || response.status === 302))
      ) {
        method = "GET"
        body = undefined
      }
      continue
    }

    return { response, finalUrl: current.href }
  }

  throw new Error("Too many redirects")
}

/** Marks responses whose body is still compressed exactly as the site sent it */
const PASSTHROUGH_HEADER = "x-devon-passthrough"

/**
 * Like fetchUpstream, for raw GET/HEAD requests, but WITHOUT decompressing the
 * body: it's relayed to the browser still compressed, with the site's own
 * Content-Encoding and Content-Length. fetch() always decompresses, which makes
 * responses ~4x bigger — big enough for YouTube's multi-megabyte bundles to be
 * cut off by hosting limits (EdgeOne Pages truncated them at ~4 MB).
 */
async function fetchUpstreamPassthrough(
  startUrl: string,
  init: UpstreamInit,
  signal: AbortSignal,
): Promise<{ response: Response; finalUrl: string }> {
  let current = new URL(startUrl)
  const method = init.method.toUpperCase()

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeUrl(current)

    const headers: Record<string, string> = {
      "user-agent": USER_AGENT,
      accept: "*/*",
      "accept-language": "en-US,en;q=0.9",
    }
    for (const [key, value] of Object.entries(init.headers ?? {})) headers[key.toLowerCase()] = value
    // Only encodings this browser said it can decode (browsers only offer br over HTTPS)
    const offered = (init.acceptEncoding || "").toLowerCase()
    const usable = ["br", "gzip", "deflate"].filter((e) => new RegExp(`(^|[\\s,])${e}(;|,|$|\\s)`).test(offered))
    headers["accept-encoding"] = usable.length ? usable.join(", ") : "identity"
    delete headers.host
    delete headers.connection
    const cookie = init.jar?.headerFor(current)
    if (cookie) headers.cookie = cookie

    const lib = current.protocol === "https:" ? https : http
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = lib.request(current, { method, headers, signal }, resolve)
      req.on("error", reject)
      req.end()
    })

    const setCookies = res.headers["set-cookie"] ?? []
    if (init.jar) init.jar.absorb(current, setCookies)

    const status = res.statusCode ?? 502
    if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
      res.resume() // discard the body
      current = new URL(res.headers.location, current)
      continue
    }

    const out = new Headers()
    for (const [key, value] of Object.entries(res.headers)) {
      if (value === undefined || key === "set-cookie") continue
      out.set(key, Array.isArray(value) ? value.join(", ") : value)
    }
    out.set(PASSTHROUGH_HEADER, "1")

    const noBody = method === "HEAD" || status === 204 || status === 205 || status === 304 || status < 200
    if (noBody) res.resume()
    const body = noBody ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>)
    // Response() rejects some statuses (e.g. 1xx); report those as a bad gateway
    const safeStatus = status >= 200 && status <= 599 ? status : 502
    return { response: new Response(body, { status: safeStatus, headers: out }), finalUrl: current.href }
  }

  throw new Error("Too many redirects")
}

// ---------------------------------------------------------------------------
// Content rewriting
// ---------------------------------------------------------------------------

function proxied(proxyOrigin: string, absoluteUrl: string): string {
  return `${proxyOrigin}${PROXY_PATH}${encodeURIComponent(absoluteUrl)}`
}

/**
 * Absolute http(s) URL for a reference that should load through the proxy, or
 * null to leave it alone (data:, blob:, #fragments, other schemes, and URLs
 * that are already proxied). Absolute URLs are proxied too: on a filtered
 * network, anything loaded straight from a blocked site fails.
 */
function proxiable(ref: string, baseUrl: string): string | null {
  const r = ref.trim().replace(/&amp;/g, "&")
  if (!r || r.startsWith("#") || r.includes(PROXY_PATH)) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(r) && !/^https?:/i.test(r)) return null
  try {
    const u = new URL(r, baseUrl)
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null
  } catch {
    return null
  }
}

/** Proxied URLs inside media tags use raw mode: streamed, with Range requests for seeking */
function rawMediaUrls(tag: string): string {
  return tag.replace(/(\/api\/proxy\?url=[^"'&\s>]+)(?!&(?:amp;)?raw=)/g, "$1&raw=1")
}

function processJavaScript(content: string, baseUrl: string, proxyOrigin: string, experimental = false): string {
  if (experimental) content = rewritePostMessageCalls(content)
  return content.replace(IMPORT_FROM_RE, (match, prefix: string, quote: string, modulePath: string) => {
    try {
      return `${prefix}${quote}${proxied(proxyOrigin, new URL(modulePath, baseUrl).href)}${quote}`
    } catch {
      return match
    }
  })
}

function processCSS(content: string, baseUrl: string, proxyOrigin: string): string {
  content = content.replace(CSS_IMPORT_RE, (match, _q: string, cssPath: string) => {
    const abs = proxiable(cssPath, baseUrl)
    return abs ? `@import url("${proxied(proxyOrigin, abs)}")` : match
  })

  return content.replace(CSS_URL_RE, (match, _q: string, resourcePath: string) => {
    // Skips data:, url(#fragment) and already-proxied references
    if (resourcePath.startsWith(proxyOrigin)) return match
    const abs = proxiable(resourcePath, baseUrl)
    return abs ? `url("${proxied(proxyOrigin, abs)}")` : match
  })
}

/** Safely embeds a string inside an inline <script>. */
function jsString(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")
}

function buildInjectedScript(pageUrl: string, proxyOrigin: string, experimental = false): string {
  return `<script>
(function () {
  var PAGE_URL = ${jsString(pageUrl)};
  var PROXY_ORIGIN = ${jsString(proxyOrigin)};
  var TARGET_ORIGIN = new URL(PAGE_URL).origin;
  var TARGET_HOST = new URL(PAGE_URL).hostname;
  var PROXY_HOST = new URL(PROXY_ORIGIN).hostname;
  var MARK = ${jsString(PROXY_PATH)};
  var EXPERIMENTAL = ${experimental ? "true" : "false"};

  // The page shown in a Devon tab, as opposed to a proxied frame inside it
  // (e.g. a reCAPTCHA widget): nested frames navigate themselves, not the tab
  var IS_TOP_PAGE = (function () {
    try { return window.parent === window || !window.parent.__devonProxied; } catch (e) { return true; }
  })();
  window.__devonProxied = true; // lets the app tell our pages from ones that escaped the proxy

  // Paths on the proxy origin that really belong to the app, not the proxied site
  var APP_PATH = new RegExp('^/(api/proxy|_next/)');

  // Turns an href/action/URL (possibly already proxied) into the real target URL.
  // The document lives on the proxy origin, so absolute URLs built from
  // location.origin/href point at the proxy; those are mapped back to the site.
  function realUrl(ref) {
    if (ref === undefined || ref === null) return null;
    ref = String(ref);
    var i = ref.indexOf(MARK);
    if (i !== -1) {
      try { return decodeURIComponent(ref.slice(i + MARK.length).split('&')[0]); } catch (e) { return null; }
    }
    var abs;
    try { abs = new URL(ref, PAGE_URL); } catch (e) { return null; }
    // blob:, data: etc. are not on any site (a blob: URL's origin is the app's)
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return abs.href;
    if (abs.origin === PROXY_ORIGIN && !APP_PATH.test(abs.pathname)) {
      return TARGET_ORIGIN + abs.pathname + abs.search + abs.hash;
    }
    // Sites that build hostnames from their own (e.g. "apis." + location.hostname)
    // get Devon's hostname, since the page lives on Devon's origin. Map
    // <sub>.<devon host> back to <sub>.<site's domain>.
    var suffix = '.' + PROXY_HOST;
    if (abs.hostname.length > suffix.length && abs.hostname.slice(-suffix.length) === suffix) {
      var sub = abs.hostname.slice(0, -suffix.length);
      var siteHost = TARGET_HOST.replace(new RegExp('^www[.]'), '');
      var mapped = new URL(abs.href);
      mapped.hostname = sub + '.' + siteHost;
      mapped.port = '';
      return mapped.href;
    }
    return abs.href;
  }

  // The same URL as seen from inside the frame: proxy origin + the real path,
  // so location.pathname/search/hash match the real site
  function frameUrl(url) {
    var u = new URL(url);
    return u.origin === TARGET_ORIGIN ? PROXY_ORIGIN + u.pathname + u.search + u.hash : null;
  }

  function isHttp(url) { return !!url && /^https?:/i.test(url); }

  var nativePushState = history.pushState;
  var nativeReplaceState = history.replaceState;

  // The app writes this page into a same-origin frame, so the document's URL
  // is on the proxy origin and can be rewritten to carry the real path before
  // any of the site's own scripts run.
  try {
    var initial = frameUrl(PAGE_URL);
    if (initial && location.protocol !== 'about:') nativeReplaceState.call(history, history.state, '', initial);
  } catch (e) {}

  function proxyPageUrl(url) { return PROXY_ORIGIN + MARK + encodeURIComponent(url); }

  // Messages for the app. Only the tab's page reports to it.
  function post(type, msg) {
    if (!IS_TOP_PAGE) return;
    msg.type = type;
    window.parent.postMessage(msg, '*');
  }

  function send(msg) {
    if (IS_TOP_PAGE) { post('proxy-navigate', msg); return; }
    // Nested proxied frame: new tabs go to the app, everything else loads in this frame
    if (msg.newTab) {
      msg.type = 'proxy-navigate';
      try { window.top.postMessage(msg, '*'); } catch (e) {}
      return;
    }
    var target = msg.reload ? PAGE_URL : msg.url;
    // Deferred: navigating from inside a navigate event handler is unreliable
    setTimeout(function () { location.assign(proxyPageUrl(target)); }, 0);
  }

  function samePage(url) {
    var hashAt = url.indexOf('#');
    return hashAt !== -1 && url.slice(0, hashAt) === PAGE_URL.split('#')[0];
  }

  function scrollToFragment(hash) {
    var id = '';
    try { id = decodeURIComponent(hash.replace(/^#/, '')); } catch (e) { id = hash.replace(/^#/, ''); }
    if (!id || id === 'top') { window.scrollTo(0, 0); return; }
    var el = document.getElementById(id) || document.getElementsByName(id)[0];
    if (el) el.scrollIntoView();
  }

  // ---- Link clicks (also handles new-tab intent, which the Navigation API can't see)
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!el) return;
    var raw = (el.getAttribute('href') || '').trim();
    var lower = raw.toLowerCase();
    if (!raw || lower.indexOf('javascript:') === 0 || lower.indexOf('mailto:') === 0 || lower.indexOf('tel:') === 0) return;

    // Same-page anchors: scroll instead of letting <base> send the frame to the real site
    if (raw.charAt(0) === '#') { e.preventDefault(); scrollToFragment(raw); return; }

    var url = realUrl(raw);
    if (!isHttp(url)) return;
    if (samePage(url)) { e.preventDefault(); scrollToFragment(url.slice(url.indexOf('#'))); return; }

    e.preventDefault();
    var newTab = e.ctrlKey || e.metaKey || (el.getAttribute('target') || '').toLowerCase() === '_blank';
    send({ url: url, newTab: newTab });
  }, true);

  // ---- Forms
  function handleForm(form, submitter) {
    var method = ((submitter && submitter.getAttribute('formmethod')) || form.getAttribute('method') || 'get').toLowerCase();
    if (method === 'dialog') return false;
    if (method === 'post' && !IS_TOP_PAGE) return false; // nested frames: no POST routing
    var actionAttr = (submitter && submitter.getAttribute('formaction')) || form.getAttribute('action') || '';
    var action = actionAttr ? realUrl(actionAttr) : PAGE_URL;
    if (!isHttp(action)) return false;

    var fd;
    try { fd = submitter ? new FormData(form, submitter) : new FormData(form); } catch (err) { fd = new FormData(form); }
    var params = new URLSearchParams();
    fd.forEach(function (v, k) { if (typeof v === 'string') params.append(k, v); });
    var newTab = (form.getAttribute('target') || '').toLowerCase() === '_blank';

    if (method === 'post') {
      send({ url: action, method: 'POST', body: params.toString(), newTab: newTab });
    } else {
      var u = new URL(action);
      u.hash = '';
      u.search = params.toString(); // GET forms replace the action's query string, like browsers do
      send({ url: u.href, newTab: newTab });
    }
    return true;
  }

  // Bubble phase so a site's own handlers (AJAX forms) get to preventDefault first
  document.addEventListener('submit', function (e) {
    if (e.defaultPrevented) return;
    var form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    if (handleForm(form, e.submitter || null)) e.preventDefault();
  });

  // form.submit() skips the submit event, so route it through the proxy too
  var nativeSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () {
    if (!handleForm(this, null)) nativeSubmit.call(this);
  };

  // ---- Script-driven navigation: location.href = ..., location.assign/replace(),
  // location.reload(), meta refresh, etc. The Navigation API sees all of them and
  // lets us cancel the frame's own navigation and hand it to the app instead.
  if (window.navigation && typeof window.navigation.addEventListener === 'function') {
    window.navigation.addEventListener('navigate', function (e) {
      if (!e.cancelable || e.navigationType === 'traverse') return;
      var dest = e.destination && e.destination.url;
      if (!dest) return;

      // Nested frames load their own proxied URLs; POSTs there aren't routed
      if (!IS_TOP_PAGE && (dest.indexOf(MARK) !== -1 || e.formData)) return;

      // location.reload(): the frame's URL isn't a real page on the proxy, so let the app reload
      if (e.navigationType === 'reload') {
        e.preventDefault();
        send({ reload: true });
        return;
      }

      if (/^(about|blob|data|javascript):/i.test(dest)) return;

      // location.hash = ...: a same-document navigation, fine to let it happen natively
      if (e.hashChange && !e.formData) {
        var hashed = realUrl(dest);
        if (isHttp(hashed)) post('proxy-url-change', { url: hashed, replace: false });
        return;
      }

      // pushState/replaceState (already reported by the patched history methods)
      // and other same-document changes stay in the page
      if (e.destination.sameDocument) return;

      var url = realUrl(dest);
      if (!isHttp(url)) return;
      e.preventDefault();

      if (samePage(url)) { scrollToFragment(url.slice(url.indexOf('#'))); return; }

      // formData is only present for POST form submissions
      if (e.formData) {
        var params = new URLSearchParams();
        e.formData.forEach(function (v, k) { if (typeof v === 'string') params.append(k, v); });
        send({ url: url, method: 'POST', body: params.toString() });
      } else {
        send({ url: url, replace: e.navigationType === 'replace' });
      }
    });
  }

  // ---- window.open(): open proxied pages in a new Devon tab
  var nativeOpen = window.open;
  window.open = function (u, target) {
    var url = u === undefined || u === '' ? null : realUrl(u);
    if (!isHttp(url)) return nativeOpen.apply(window, arguments);
    var t = String(target || '_blank').toLowerCase();
    send({ url: url, newTab: t !== '_self' && t !== '_parent' && t !== '_top' });
    return null; // same as a blocked popup
  };

  // ---- history.pushState/replaceState: the site passes URLs on its own origin, which
  // <base> resolves cross-origin (SecurityError). Translate them to the same path on
  // the proxy origin, so the frame's location keeps matching the real site.
  function trackUrl(url, replace) {
    PAGE_URL = url;
    var base = document.querySelector('base');
    if (base) base.setAttribute('href', url);
    post('proxy-url-change', { url: url, replace: replace });
  }

  // Patched on History.prototype (not just this history object), so calls like
  // History.prototype.pushState.call(history, ...) are translated too
  var HistoryProto = (window.History && window.History.prototype) || history;
  [['pushState', nativePushState], ['replaceState', nativeReplaceState]].forEach(function (pair) {
    var name = pair[0], native = pair[1];
    if (typeof native !== 'function') return;
    var patched = function (state, title, u) {
      if (this !== history || u === undefined || u === null) return native.apply(this, arguments);
      var url = realUrl(u);
      if (!isHttp(url)) return native.apply(history, arguments);
      var inFrame = frameUrl(url);
      trackUrl(url, name === 'replaceState');
      // A different origin can't be represented in the frame's URL; keep the state only
      return inFrame ? native.call(history, state, title, inFrame) : native.call(history, state, title);
    };
    try {
      Object.defineProperty(HistoryProto, name, { configurable: true, writable: true, enumerable: true, value: patched });
    } catch (e) {
      history[name] = patched;
    }
  });

  // Back/forward between the page's own pushState entries
  window.addEventListener('popstate', function () {
    var url = realUrl(location.href);
    if (isHttp(url) && url !== PAGE_URL) trackUrl(url, true);
  });

  // ---- fetch() / XMLHttpRequest: route the page's own requests through the proxy
  // (raw mode: method, body and headers forwarded; responses not rewritten)
  function toProxy(u) {
    var url = realUrl(u);
    if (!isHttp(url) || url.indexOf(PROXY_ORIGIN + '/') === 0) return null;
    return PROXY_ORIGIN + MARK + encodeURIComponent(url) + '&raw=1&ref=' + encodeURIComponent(PAGE_URL);
  }

  // Set by the diagnostics section below; reports problems to the app
  var reportHook = null;
  // Video/player requests are logged (successful ones too) for the page report
  var MEDIA_REQ = new RegExp('googlevideo[.]com|videoplayback|/youtubei/v1/(player|next|browse|search|reel)|[.](m3u8|mpd)([?]|$)', 'i');
  var activityHook = null;
  function logActivity(info) { try { if (activityHook) activityHook(info); } catch (e) {} }
  var nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    // Copies a Request to a new URL. Its body is read into memory first: re-wrapping a
    // Request that has a body gives it a stream body, and Safari refuses to upload
    // streams ("ReadableStream uploading is not supported")
    function retarget(req, target, init) {
      var m = String((init && init.method) || req.method || 'GET').toUpperCase();
      var opts = {
        method: m,
        headers: (init && init.headers) || req.headers,
        credentials: (init && init.credentials) || req.credentials,
        cache: (init && init.cache) || req.cache,
        redirect: (init && init.redirect) || req.redirect,
        integrity: (init && init.integrity) || req.integrity,
        keepalive: init && 'keepalive' in init ? init.keepalive : req.keepalive,
        signal: (init && init.signal) || req.signal,
        referrerPolicy: (init && init.referrerPolicy) || req.referrerPolicy
      };
      if (init && 'body' in init) {
        opts.body = init.body;
        return Promise.resolve(opts);
      }
      if (m === 'GET' || m === 'HEAD') return Promise.resolve(opts);
      return req.clone().arrayBuffer().then(function (buf) {
        opts.body = buf.byteLength ? buf : undefined;
        return opts;
      });
    }

    window.fetch = function (input, init) {
      var shown = '';
      var method = (init && init.method) || 'GET';
      var p;
      try {
        var isRequest = typeof Request !== 'undefined' && input instanceof Request;
        if (isRequest) method = init && init.method ? init.method : input.method;
        shown = realUrl(isRequest ? input.url : input) || '';
        var target = toProxy(isRequest ? input.url : input);
        if (target && isRequest) {
          p = retarget(input, target, init).then(function (opts) { return nativeFetch.call(window, target, opts); });
        } else if (target) {
          input = target;
        }
      } catch (e) {}
      // Always call the real fetch on window: sites often call fetch as a method of
      // another object (x.fetch = fetch), which the browser rejects ("Illegal invocation")
      if (!p) p = nativeFetch.call(window, input, init);
      var started = Date.now();
      var isMedia = MEDIA_REQ.test(shown);
      return p.then(function (res) {
        if (isMedia) {
          var entry = {
            via: 'fetch', method: method.toUpperCase(), url: shown, status: res.status, ms: Date.now() - started,
            type: res.headers.get('content-type') || '', length: res.headers.get('content-length') || '',
            proxyError: res.headers.get('x-proxy-final-url') ? '' : 'yes', detail: ''
          };
          if (res.status >= 400) {
            res.clone().text().then(function (t) { entry.detail = t.slice(0, 200); logActivity(entry); }, function () { logActivity(entry); });
          } else {
            logActivity(entry);
          }
        }
        if (res.status >= 400 && reportHook) {
          var base = { kind: 'network', message: method.toUpperCase() + ' ' + res.status + ' (fetch)', file: shown, proxied: res.url || '' };
          // An error from Devon's proxy itself (not the site): include its reason
          if (!res.headers.get('x-proxy-final-url')) {
            res.clone().text().then(function (t) {
              var reason = '';
              try { reason = JSON.parse(t).error || ''; } catch (e) { reason = t.slice(0, 160); }
              if (reason) base.message += ': ' + reason;
              reportHook(base);
            }, function () { reportHook(base); });
          } else {
            reportHook(base);
          }
        }
        return res;
      }, function (err) {
        if (isMedia) logActivity({ via: 'fetch', method: method.toUpperCase(), url: shown, status: 'failed: ' + (err && err.message ? err.message : String(err)), ms: Date.now() - started });
        if (reportHook && !(err && err.name === 'AbortError')) {
          reportHook({ kind: 'network', message: method.toUpperCase() + ' failed (fetch): ' + (err && err.message ? err.message : String(err)), file: shown, proxied: '' });
        }
        throw err;
      });
    };
  }

  var nativeXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, u) {
    var args = Array.prototype.slice.call(arguments);
    var xhr = this;
    try {
      var target = toProxy(u);
      if (target) args[1] = target;
      if (!xhr.__devonWatched) {
        xhr.__devonWatched = true;
        xhr.addEventListener('loadend', function () {
          if (xhr.__devonUrl && MEDIA_REQ.test(xhr.__devonUrl)) {
            var size = '';
            try {
              var r = xhr.response;
              size = r && r.byteLength !== undefined ? String(r.byteLength) : (typeof r === 'string' ? String(r.length) : '');
            } catch (e) {}
            logActivity({
              via: 'xhr', method: String(xhr.__devonMethod || 'GET').toUpperCase(), url: xhr.__devonUrl,
              status: xhr.__devonAborted ? 'aborted' : xhr.status, ms: xhr.__devonStart ? Date.now() - xhr.__devonStart : 0,
              type: (xhr.getResponseHeader && xhr.getResponseHeader('content-type')) || '', length: size,
              detail: xhr.status >= 400 && (xhr.responseType === '' || xhr.responseType === 'text') ? String(xhr.responseText || '').slice(0, 200) : ''
            });
          }
          if (!reportHook || xhr.__devonAborted) return;
          if (xhr.status >= 400 || xhr.status === 0) {
            reportHook({
              kind: 'network',
              message: String(xhr.__devonMethod || 'GET').toUpperCase() + ' ' + (xhr.status || 'failed') + ' (XHR)',
              file: xhr.__devonUrl || '',
              proxied: xhr.responseURL || ''
            });
          }
        });
        xhr.addEventListener('abort', function () { xhr.__devonAborted = true; });
      }
      xhr.__devonMethod = method;
      xhr.__devonStart = Date.now();
      xhr.__devonUrl = realUrl(u) || String(u);
      xhr.__devonAborted = false;
    } catch (e) {}
    return nativeXhrOpen.apply(this, args);
  };

  if (typeof EventSource === 'function') {
    var NativeEventSource = EventSource;
    window.EventSource = function (u, config) {
      var target = null;
      try { target = toProxy(u); } catch (e) {}
      return new NativeEventSource(target || u, config);
    };
    window.EventSource.prototype = NativeEventSource.prototype;
  }

  if (navigator.sendBeacon) {
    var nativeBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (u, data) {
      var target = null;
      try { target = toProxy(u); } catch (e) {}
      return nativeBeacon(target || u, data);
    };
  }

  // ---- Subresources added by scripts (img.src = ..., createElement('script'),
  // setAttribute, innerHTML...). Relative URLs resolve against <base>, i.e. the
  // real site, so without this they'd load straight from it — and fail on a
  // network that blocks the site. Scripts, stylesheets and frames go through
  // the rewriting proxy; images and media through raw mode (streamed, seekable).
  var PASSIVE_SIGNIN = new RegExp(${jsString(PASSIVE_SIGNIN_SOURCE)}, 'i');
  var SKIP_SCHEME = new RegExp('^(data|blob|javascript|about|mailto|tel|chrome|moz-extension):', 'i');
  function subUrl(el, value) {
    if (value === undefined || value === null) return null;
    var s = String(value).trim();
    if (!s || s.charAt(0) === '#' || s.indexOf(MARK) !== -1 || SKIP_SCHEME.test(s)) return null;
    var url = realUrl(s);
    if (!isHttp(url)) return null;
    var tag = el.tagName;
    // Classic scripts stream through raw mode (see processHTML); module scripts and
    // experimental mode need the rewriting proxy
    if (tag === 'SCRIPT' && !EXPERIMENTAL && String(el.type || '').toLowerCase() !== 'module') {
      el.removeAttribute('integrity');
      return PROXY_ORIGIN + MARK + encodeURIComponent(url) + '&raw=1';
    }
    // Google's hidden "are you signed in?" check (YouTube and other Google sites load
    // it in an invisible frame). It can't work through a proxy and only throws
    // errors, so it's skipped; the site just treats you as signed out.
    if ((tag === 'IFRAME' || tag === 'FRAME') && PASSIVE_SIGNIN.test(url)) return 'about:blank';
    if (tag === 'SCRIPT' || tag === 'LINK' || tag === 'IFRAME' || tag === 'FRAME') {
      if (tag === 'LINK') {
        var rel = (el.getAttribute('rel') || '').toLowerCase();
        if (rel.indexOf('preconnect') !== -1 || rel.indexOf('dns-prefetch') !== -1) return null;
      }
      if (tag !== 'IFRAME' && tag !== 'FRAME') el.removeAttribute('integrity'); // the proxy may rewrite it
      return proxyPageUrl(url);
    }
    return PROXY_ORIGIN + MARK + encodeURIComponent(url) + '&raw=1';
  }
  var WS = new RegExp('[ ' + String.fromCharCode(9, 10, 12, 13) + ']+'); // whitespace, without backslashes in this template
  function subSrcset(el, value) {
    if (value === undefined || value === null) return null;
    var s = String(value);
    if (!s.trim() || s.indexOf('data:') !== -1) return null;
    var changed = false;
    var out = s.split(',').map(function (part) {
      var bits = part.trim().split(WS);
      var r = subUrl(el, bits[0]);
      if (!r) return part.trim();
      changed = true;
      bits[0] = r;
      return bits.join(' ');
    }).join(', ');
    return changed ? out : null;
  }
  // Reading the property gives the site back the real URL, so its own checks still work
  function unproxied(v) {
    return typeof v === 'string' && v.indexOf(MARK) !== -1 ? (realUrl(v) || v) : v;
  }

  var URL_PROPS = [
    ['HTMLImageElement', 'src'], ['HTMLImageElement', 'srcset'],
    ['HTMLSourceElement', 'src'], ['HTMLSourceElement', 'srcset'],
    ['HTMLMediaElement', 'src'], ['HTMLVideoElement', 'poster'], ['HTMLTrackElement', 'src'],
    ['HTMLScriptElement', 'src'], ['HTMLLinkElement', 'href'],
    ['HTMLIFrameElement', 'src'], ['HTMLEmbedElement', 'src'], ['HTMLObjectElement', 'data'],
    ['HTMLInputElement', 'src']
  ];
  URL_PROPS.forEach(function (pair) {
    var C = window[pair[0]];
    if (!C) return;
    var proto = C.prototype, prop = pair[1];
    var d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set) return;
    var isSet = prop === 'srcset';
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: d.enumerable,
      get: function () { return isSet ? d.get.call(this) : unproxied(d.get.call(this)); },
      set: function (v) {
        var r = null;
        try { r = isSet ? subSrcset(this, v) : subUrl(this, v); } catch (e) {}
        d.set.call(this, r || v);
      }
    });
  });

  var URL_ATTRS = { src: 1, srcset: 1, poster: 1, data: 1, href: 1 };
  function attrValue(el, name, value) {
    var n = String(name).toLowerCase();
    if (!URL_ATTRS[n]) return null;
    var tag = el.tagName;
    if (n === 'href' && tag !== 'LINK') return null; // links (<a>) are handled on click
    if (n === 'data' && tag !== 'OBJECT') return null;
    if (!(el instanceof HTMLElement)) return null; // SVG etc.
    return n === 'srcset' ? subSrcset(el, value) : subUrl(el, value);
  }
  var nativeSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    var r = null;
    try { r = attrValue(this, name, value); } catch (e) {}
    return nativeSetAttr.call(this, name, r || value);
  };

  // Elements created from HTML strings (innerHTML, insertAdjacentHTML, templates) skip
  // the setters above; fix them up as soon as they're added
  var SUB_SELECTOR = 'img,source,video,audio,track,script[src],link[href],iframe[src],embed[src],object[data],input[src]';
  function fixNode(el) {
    ['src', 'srcset', 'poster', 'href', 'data'].forEach(function (a) {
      if (!el.hasAttribute || !el.hasAttribute(a)) return;
      var r = null;
      try { r = attrValue(el, a, el.getAttribute(a)); } catch (e) {}
      if (r) nativeSetAttr.call(el, a, r);
    });
  }
  new MutationObserver(function (records) {
    records.forEach(function (record) {
      record.addedNodes.forEach(function (node) {
        if (node.nodeType !== 1) return;
        if (node.matches && node.matches(SUB_SELECTOR)) fixNode(node);
        if (node.querySelectorAll) Array.prototype.forEach.call(node.querySelectorAll(SUB_SELECTOR), fixNode);
      });
    });
  }).observe(document, { childList: true, subtree: true });

  // Workers must be same-origin: load their scripts through the proxy
  ['Worker', 'SharedWorker'].forEach(function (name) {
    var NativeW = window[name];
    if (typeof NativeW !== 'function') return;
    var Wrapped = function (u, opts) {
      var target = null;
      try {
        var s = String(u);
        if (!SKIP_SCHEME.test(s) && s.indexOf(MARK) === -1) {
          var real = realUrl(s);
          if (isHttp(real)) target = proxyPageUrl(real);
        }
      } catch (e) {}
      return new NativeW(target || u, opts);
    };
    Wrapped.prototype = NativeW.prototype;
    window[name] = Wrapped;
  });

  // ---- Per-site storage (ported from WebKit's WebContent sandbox, which only lets a
  // page reach its own website-data container). Every proxied site shares Devon's
  // origin, so without this any site could read or clear Devon's saved tabs,
  // history and settings, and every other site's localStorage, IndexedDB, caches
  // and JS cookies. Each site now gets its own namespace: keys, database names,
  // cache names and cookie names carry a site tag the page never sees.
  var STORE_PREFIX = 'dvs:' + TARGET_ORIGIN + ':';
  var COOKIE_TAG = (function () {
    var site = TARGET_HOST.replace(new RegExp('^www[.]'), '');
    var b64 = btoa(site).split('=').join('').split('+').join('-').split('/').join('_');
    return 'dsc.' + b64 + '.';
  })();

  function partitionedStorage(native, proto) {
    function ownKeys() {
      var keys = [];
      for (var i = 0; i < native.length; i++) {
        var k = native.key(i);
        if (k !== null && k.indexOf(STORE_PREFIX) === 0) keys.push(k.slice(STORE_PREFIX.length));
      }
      return keys;
    }
    var api = {
      getItem: function (k) { return native.getItem(STORE_PREFIX + String(k)); },
      setItem: function (k, v) { native.setItem(STORE_PREFIX + String(k), String(v)); },
      removeItem: function (k) { native.removeItem(STORE_PREFIX + String(k)); },
      clear: function () { ownKeys().forEach(function (k) { native.removeItem(STORE_PREFIX + k); }); },
      key: function (i) { var keys = ownKeys(); i = Number(i) || 0; return i >= 0 && i < keys.length ? keys[i] : null; }
    };
    var has = Object.prototype.hasOwnProperty;
    // Named access (localStorage.foo, localStorage['foo'] = 1, delete, Object.keys,
    // JSON.stringify) behaves like a real Storage object
    return new Proxy(Object.create(proto), {
      get: function (t, p) {
        if (p === 'length') return ownKeys().length;
        if (typeof p === 'symbol') return t[p];
        if (has.call(api, p)) return api[p];
        if (p in t) return t[p];
        var v = api.getItem(p);
        return v === null ? undefined : v;
      },
      set: function (t, p, v) {
        if (typeof p === 'symbol') { t[p] = v; return true; }
        api.setItem(p, v);
        return true;
      },
      defineProperty: function (t, p, desc) {
        if (typeof p === 'symbol') return Reflect.defineProperty(t, p, desc);
        api.setItem(p, desc.value);
        return true;
      },
      has: function (t, p) {
        if (typeof p === 'symbol' || has.call(api, p) || p in t || p === 'length') return true;
        return api.getItem(p) !== null;
      },
      deleteProperty: function (t, p) {
        if (typeof p !== 'symbol') api.removeItem(p);
        return true;
      },
      ownKeys: function () { return ownKeys(); },
      getOwnPropertyDescriptor: function (t, p) {
        if (typeof p === 'symbol') return undefined;
        var v = api.getItem(p);
        return v === null ? undefined : { value: v, writable: true, enumerable: true, configurable: true };
      }
    });
  }

  function partitionRealm(w) {
    ['localStorage', 'sessionStorage'].forEach(function (name) {
      var native;
      try { native = w[name]; } catch (e) { return; } // storage disabled
      if (!native) return;
      var wrapped = partitionedStorage(native, (w.Storage || Storage).prototype);
      try { Object.defineProperty(w, name, { configurable: true, enumerable: true, get: function () { return wrapped; } }); } catch (e) {}
    });

    // Storage events from other tabs: only this site's keys, without the tag
    try {
      var SE = w.StorageEvent && w.StorageEvent.prototype;
      var keyDesc = SE && Object.getOwnPropertyDescriptor(SE, 'key');
      if (keyDesc && keyDesc.get && !SE.__devonPartitioned) {
        SE.__devonPartitioned = true;
        Object.defineProperty(SE, 'key', {
          configurable: true,
          enumerable: keyDesc.enumerable,
          get: function () {
            var k = keyDesc.get.call(this);
            return k && k.indexOf(STORE_PREFIX) === 0 ? k.slice(STORE_PREFIX.length) : k;
          }
        });
        var ETP = w.EventTarget.prototype;
        var nativeAdd = ETP.addEventListener, nativeRemove = ETP.removeEventListener;
        var storageWrappers = new WeakMap();
        ETP.addEventListener = function (type, fn, opts) {
          if (type === 'storage' && this === w && fn && (typeof fn === 'function' || typeof fn === 'object')) {
            var inner = fn;
            if (!storageWrappers.has(inner)) {
              storageWrappers.set(inner, function (ev) {
                var k = keyDesc.get.call(ev);
                if (k !== null && k.indexOf(STORE_PREFIX) !== 0) return; // another site's (or Devon's) key
                return typeof inner === 'function' ? inner.call(this, ev) : inner.handleEvent(ev);
              });
            }
            fn = storageWrappers.get(inner);
          }
          return nativeAdd.call(this, type, fn, opts);
        };
        ETP.removeEventListener = function (type, fn, opts) {
          if (type === 'storage' && this === w && fn && storageWrappers.has(fn)) fn = storageWrappers.get(fn);
          return nativeRemove.call(this, type, fn, opts);
        };
      }
    } catch (e) {}

    // IndexedDB: database names carry the site prefix
    try {
      var idb = w.indexedDB;
      if (idb && !idb.__devonPartitioned) {
        idb.__devonPartitioned = true;
        var nativeOpen = idb.open, nativeDelete = idb.deleteDatabase, nativeList = idb.databases;
        idb.open = function (name) {
          var args = Array.prototype.slice.call(arguments);
          args[0] = STORE_PREFIX + String(name);
          return nativeOpen.apply(idb, args);
        };
        idb.deleteDatabase = function (name) { return nativeDelete.call(idb, STORE_PREFIX + String(name)); };
        if (typeof nativeList === 'function') {
          idb.databases = function () {
            return nativeList.call(idb).then(function (list) {
              return list
                .filter(function (d) { return d.name && d.name.indexOf(STORE_PREFIX) === 0; })
                .map(function (d) { return { name: d.name.slice(STORE_PREFIX.length), version: d.version }; });
            });
          };
        }
      }
    } catch (e) {}

    // Cache Storage: cache names carry the site prefix
    try {
      var cs = w.caches;
      if (cs && !cs.__devonPartitioned) {
        cs.__devonPartitioned = true;
        var n = { open: cs.open, has: cs.has, del: cs['delete'], keys: cs.keys };
        cs.open = function (name) { return n.open.call(cs, STORE_PREFIX + String(name)); };
        cs.has = function (name) { return n.has.call(cs, STORE_PREFIX + String(name)); };
        cs['delete'] = function (name) { return n.del.call(cs, STORE_PREFIX + String(name)); };
        cs.keys = function () {
          return n.keys.call(cs).then(function (names) {
            return names
              .filter(function (x) { return x.indexOf(STORE_PREFIX) === 0; })
              .map(function (x) { return x.slice(STORE_PREFIX.length); });
          });
        };
        // caches.match() searches every cache: only this site's
        cs.match = function (req, opts) {
          if (opts && opts.cacheName) return n.open.call(cs, STORE_PREFIX + opts.cacheName).then(function (c) { return c.match(req, opts); });
          return cs.keys().then(function (names) {
            var i = 0;
            function next() {
              if (i >= names.length) return undefined;
              return n.open.call(cs, STORE_PREFIX + names[i++]).then(function (c) { return c.match(req, opts); }).then(function (r) { return r || next(); });
            }
            return next();
          });
        };
      }
    } catch (e) {}

    // document.cookie: names carry the site tag (so a site can't read another's
    // cookies or plant cookies in Devon's HttpOnly cookie jar). Domain= is dropped:
    // the page really lives on Devon's host, so the browser would reject it anyway.
    try {
      var doc = w.document;
      var cd = w.Document && Object.getOwnPropertyDescriptor(w.Document.prototype, 'cookie');
      if (doc && cd && cd.get && cd.set && !doc.__devonPartitioned) {
        doc.__devonPartitioned = true;
        Object.defineProperty(doc, 'cookie', {
          configurable: true,
          enumerable: cd.enumerable,
          get: function () {
            var all = cd.get.call(this);
            if (!all) return '';
            return all.split('; ')
              .filter(function (c) { return c.indexOf(COOKIE_TAG) === 0; })
              .map(function (c) { c = c.slice(COOKIE_TAG.length); return c.charAt(0) === '=' ? c.slice(1) : c; })
              .join('; ');
          },
          set: function (value) {
            var parts = String(value).split(';');
            var first = parts.shift();
            var eq = first.indexOf('=');
            var name = eq === -1 ? '' : first.slice(0, eq).trim();
            var val = eq === -1 ? first.trim() : first.slice(eq + 1);
            var attrs = parts.filter(function (a) { return a.split('=')[0].trim().toLowerCase() !== 'domain'; });
            cd.set.call(this, COOKIE_TAG + name + '=' + val + (attrs.length ? ';' + attrs.join(';') : ''));
          }
        });
      }
      // The async cookie API would bypass the tags: sites fall back to document.cookie
      if ('cookieStore' in w) Object.defineProperty(w, 'cookieStore', { configurable: true, value: undefined });
    } catch (e) {}
  }
  partitionRealm(window);

  // ---- Pristine functions from blank frames. Some sites (YouTube included) create an
  // empty <iframe> and take untouched built-ins from it (history.pushState, fetch,
  // XMLHttpRequest, element setters) to avoid patched ones. Those would skip the
  // translations above, so a blank frame's built-ins are patched to hand calls on
  // this page's objects back to this page's versions — the moment the site first
  // reaches into the frame (contentWindow/contentDocument).
  (function () {
    function mine(obj) {
      try { return obj === history || obj === window || (obj && obj.ownerDocument === document) || obj === document; } catch (e) { return false; }
    }
    function patchRealm(w) {
      try {
        if (!w || w === window || w.__devonRealmPatched || w.__devonProxied) return;
        w.__devonRealmPatched = true;
      } catch (e) { return; } // cross-origin: nothing to do

      // A blank frame's own storage, IndexedDB and cookies are Devon's origin's too
      partitionRealm(w);

      var WH = w.History && w.History.prototype;
      if (WH) ['pushState', 'replaceState'].forEach(function (name) {
        var own = WH[name];
        if (typeof own !== 'function') return;
        WH[name] = function () {
          return this === history ? history[name].apply(history, arguments) : own.apply(this, arguments);
        };
      });

      if (typeof w.fetch === 'function') {
        var ownFetch = w.fetch;
        w.fetch = function (input, init) {
          // Requests made with the blank frame's fetch still go through the proxy
          try { return window.fetch(input, init); } catch (e) { return ownFetch.call(w, input, init); }
        };
      }

      if (w.XMLHttpRequest) {
        var ownOpen = w.XMLHttpRequest.prototype.open;
        w.XMLHttpRequest.prototype.open = function (method, u) {
          var args = Array.prototype.slice.call(arguments);
          try {
            var target = toProxy(u);
            if (target) args[1] = target;
          } catch (e) {}
          return ownOpen.apply(this, args);
        };
      }

      if (w.navigator && w.navigator.sendBeacon) {
        w.navigator.sendBeacon = function (u, data) { return navigator.sendBeacon(u, data); };
      }

      // Element setters/setAttribute used on THIS page's elements run this page's versions
      URL_PROPS.forEach(function (pair) {
        var WC = w[pair[0]], C = window[pair[0]];
        if (!WC || !C) return;
        var wd = Object.getOwnPropertyDescriptor(WC.prototype, pair[1]);
        var d = Object.getOwnPropertyDescriptor(C.prototype, pair[1]);
        if (!wd || !wd.set || !d || !d.set) return;
        try {
          Object.defineProperty(WC.prototype, pair[1], {
            configurable: true,
            enumerable: wd.enumerable,
            get: function () { return mine(this) ? d.get.call(this) : wd.get.call(this); },
            set: function (v) { return mine(this) ? d.set.call(this, v) : wd.set.call(this, v); }
          });
        } catch (e) {}
      });
      if (w.Element) {
        var ownSetAttr = w.Element.prototype.setAttribute;
        w.Element.prototype.setAttribute = function (name, value) {
          return mine(this) ? Element.prototype.setAttribute.call(this, name, value) : ownSetAttr.call(this, name, value);
        };
      }
    }

    ['HTMLIFrameElement', 'HTMLFrameElement'].forEach(function (cls) {
      var C = window[cls];
      if (!C) return;
      ['contentWindow', 'contentDocument'].forEach(function (prop) {
        var d = Object.getOwnPropertyDescriptor(C.prototype, prop);
        if (!d || !d.get) return;
        Object.defineProperty(C.prototype, prop, {
          configurable: true,
          enumerable: d.enumerable,
          get: function () {
            var v = d.get.call(this);
            try {
              var win = prop === 'contentWindow' ? v : (v && v.defaultView);
              if (win) patchRealm(win);
            } catch (e) {}
            return v;
          }
        });
      });
    });
  })();

  // A proxied site must never register a service worker on the proxy's origin
  if (navigator.serviceWorker && navigator.serviceWorker.register) {
    try {
      navigator.serviceWorker.register = function () {
        return Promise.reject(new DOMException('Service workers are disabled in Devon', 'SecurityError'));
      };
    } catch (e) {}
  }

  // ==== Experimental reCAPTCHA support ====
  // reCAPTCHA's widget frames are loaded through the proxy too, so they share
  // the proxy's origin with the page. That breaks the origin checks on the
  // postMessage traffic between them, which the code below emulates:
  //  - the proxy rewrites every "x.postMessage(" call site to first call
  //    __devonPM(self), which records the calling window;
  //  - each proxied window's own postMessage checks targetOrigin against the
  //    site it stands for, and remembers the real sender;
  //  - MessageEvent.source/origin report that sender and its site.
  if (EXPERIMENTAL) (function () {
    window.__devonTargetOrigin = TARGET_ORIGIN;

    // Shared by all proxied frames (same origin): who is calling postMessage right now
    var shared;
    try { shared = window.top.__devonShared || (window.top.__devonShared = {}); } catch (e) { shared = {}; }
    var clearScheduled = false;
    window.__devonPM = function (caller, name) {
      shared.caller = caller;
      if (!clearScheduled) {
        clearScheduled = true;
        // Calls on ports/workers never consume it; don't let it go stale
        Promise.resolve().then(function () { clearScheduled = false; shared.caller = null; });
      }
      return name;
    };

    var nativePostMessage = window.postMessage;
    var pendingSenders = [];
    var senders = new WeakMap();

    function originOf(value) {
      try { return new URL(value).origin; } catch (e) { return null; }
    }

    // Note: this function lives in the RECEIVER's realm, so the native call
    // below makes the browser report this window as event.source. The sender
    // recorded by __devonPM is restored by the MessageEvent getters.
    window.postMessage = function (message, targetOrigin, transfer) {
      var caller = shared.caller || null;
      shared.caller = null;
      if (targetOrigin && typeof targetOrigin === 'object') {
        transfer = targetOrigin.transfer;
        targetOrigin = targetOrigin.targetOrigin;
      }
      var t = targetOrigin === undefined ? '/' : String(targetOrigin);
      if (t !== '*' && t !== '/') {
        var o = originOf(t);
        if (!o) return nativePostMessage.call(window, message, t, transfer); // throws like the browser would
        // A browser drops messages whose targetOrigin doesn't match the receiver;
        // this window stands for TARGET_ORIGIN (and really is PROXY_ORIGIN)
        if (o !== TARGET_ORIGIN && o !== PROXY_ORIGIN) return;
        t = '*';
      }
      nativePostMessage.call(window, message, t, transfer === undefined ? [] : transfer);
      pendingSenders.push(caller);
    };

    var sourceGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'source').get;
    var originGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'origin').get;

    // Messages sent through the function above arrive with this window as their
    // source, in order; pair each with the sender recorded when it was sent
    window.addEventListener('message', function (e) {
      if (!pendingSenders.length || sourceGetter.call(e) !== window) return;
      var caller = pendingSenders.shift();
      if (caller && caller !== window) senders.set(e, caller);
    }, true);

    Object.defineProperty(MessageEvent.prototype, 'source', {
      configurable: true,
      enumerable: true,
      get: function () { return senders.get(this) || sourceGetter.call(this); }
    });

    Object.defineProperty(MessageEvent.prototype, 'origin', {
      configurable: true,
      enumerable: true,
      get: function () {
        var o = originGetter.call(this);
        var sender = senders.get(this);
        if (sender && o === PROXY_ORIGIN) {
          var site = null;
          try { site = sender.__devonTargetOrigin; } catch (e) {}
          // Only when it differs: same-site messages keep matching location.origin
          if (site && site !== TARGET_ORIGIN) return site;
        }
        return o;
      }
    });

    // ---- Route reCAPTCHA's frames and scripts through the proxy
    function isHost(u, hosts) { return hosts.indexOf(u.hostname.replace(/^www[.]/, '')) !== -1; }

    // "co" tells Google which site embeds the widget; it's checked against the site
    // key's allowed domains, so it must be the real site, not the proxy
    function embedderCo() {
      var p = new URL(PAGE_URL);
      var port = p.port || (p.protocol === 'https:' ? '443' : '80');
      return btoa(p.protocol + '//' + p.hostname + ':' + port)
        .replace(/[+]/g, '-').replace(/[/]/g, '_').replace(/=/g, '.');
    }

    function recaptchaFrameUrl(ref) {
      if (ref.indexOf(MARK) !== -1) return null;
      var real = realUrl(ref);
      if (!isHttp(real)) return null;
      var u = new URL(real);
      if (!isHost(u, ['google.com', 'recaptcha.net']) || u.pathname.indexOf('/recaptcha/') !== 0) return null;
      return proxyPageUrl(u.href.replace(/([?&]co=)[^&#]*/, '$1' + embedderCo()));
    }

    function recaptchaScriptUrl(ref) {
      if (ref.indexOf(MARK) !== -1) return null;
      var real = realUrl(ref);
      if (!isHttp(real)) return null;
      var u = new URL(real);
      if (!isHost(u, ['google.com', 'gstatic.com', 'recaptcha.net']) || u.pathname.indexOf('/recaptcha/') !== 0) return null;
      return proxyPageUrl(u.href);
    }

    function rewriteFor(el, value) {
      try {
        if (el instanceof HTMLIFrameElement) return recaptchaFrameUrl(String(value));
        if (el instanceof HTMLScriptElement) {
          var r = recaptchaScriptUrl(String(value));
          if (r) el.removeAttribute('integrity'); // the proxy rewrites the script
          return r;
        }
      } catch (e) {}
      return null;
    }

    [HTMLIFrameElement.prototype, HTMLScriptElement.prototype].forEach(function (proto) {
      var d = Object.getOwnPropertyDescriptor(proto, 'src');
      if (!d || !d.set) return;
      Object.defineProperty(proto, 'src', {
        configurable: true,
        enumerable: d.enumerable,
        get: d.get,
        set: function (v) { d.set.call(this, rewriteFor(this, v) || v); }
      });
    });

    var nativeSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      if (String(name).toLowerCase() === 'src') {
        var r = rewriteFor(this, value);
        if (r) value = r;
      }
      return nativeSetAttribute.call(this, name, value);
    };

    // Frames inserted as HTML (innerHTML, templates) bypass the setters above
    function fixFrame(el) {
      if (!el || el.tagName !== 'IFRAME') return;
      var src = el.getAttribute('src');
      var r = src ? rewriteFor(el, src) : null;
      if (r) nativeSetAttribute.call(el, 'src', r);
    }
    new MutationObserver(function (records) {
      records.forEach(function (record) {
        record.addedNodes.forEach(function (node) {
          if (node.nodeType !== 1) return;
          fixFrame(node);
          if (node.querySelectorAll) Array.prototype.forEach.call(node.querySelectorAll('iframe[src]'), fixFrame);
        });
      });
    }).observe(document, { childList: true, subtree: true });
  })();

  // ---- Oversized scripts: hosts cap how big one response may be (EdgeOne Pages
  // answers 413), and some sites' bundles are bigger. When a proxied script
  // fails to load, fetch it again in slices, join them and run it from a blob:
  // URL, then fire "load" on the original element so the site's loader carries
  // on. (A script that failed to load never ran, so running it now is safe.)
  (function () {
    var SLICE_SIZE = 2 * 1024 * 1024;
    var fetchNative = typeof nativeFetch === 'function' ? nativeFetch : window.fetch;
    function fetchInSlices(real) {
      var parts = [];
      function next(i) {
        var u = PROXY_ORIGIN + MARK + encodeURIComponent(real) + '&raw=1&slice=' + i + '&sliceSize=' + SLICE_SIZE +
          (EXPERIMENTAL ? '&js=1' : '') + '&ref=' + encodeURIComponent(PAGE_URL);
        return fetchNative.call(window, u, { credentials: 'same-origin' }).then(function (r) {
          if (!r.ok) throw new Error('slice ' + i + ': HTTP ' + r.status);
          var more = r.headers.get('X-Devon-More') === '1';
          return r.arrayBuffer().then(function (b) {
            parts.push(b);
            if (more && i < 64) return next(i + 1);
            return new Blob(parts, { type: 'text/javascript' });
          });
        });
      }
      return next(0);
    }
    window.addEventListener('error', function (e) {
      var el = e.target;
      if (!el || el === window || el.tagName !== 'SCRIPT' || el.__devonRetried) return;
      var src = el.getAttribute('src') || '';
      if (src.indexOf(MARK) === -1) return;
      var real = realUrl(src);
      if (!isHttp(real)) return;
      el.__devonRetried = true;
      // Keep the site's onerror (and the diagnostics below) out of it while we retry
      e.stopImmediatePropagation();
      fetchInSlices(real).then(function (blob) {
        var url = URL.createObjectURL(blob);
        var s = document.createElement('script');
        s.__devonRetried = true;
        ['type', 'nonce', 'id', 'charset'].forEach(function (a) {
          var v = el.getAttribute(a);
          if (v !== null) s.setAttribute(a, v);
        });
        s.onload = function () {
          URL.revokeObjectURL(url);
          el.dispatchEvent(new Event('load'));
        };
        s.onerror = function () {
          URL.revokeObjectURL(url);
          el.dispatchEvent(new Event('error'));
        };
        s.src = url;
        var parent = el.parentNode || document.head || document.documentElement;
        parent.insertBefore(s, el.parentNode ? el.nextSibling : null);
      }).catch(function () {
        el.dispatchEvent(new Event('error'));
      });
    }, true);
  })();

  // ---- Diagnostics: script errors are reported to the app (with the real file
  // URL), so problems on complex sites can be seen without dev tools
  (function () {
    function appWindow() {
      try {
        var w = window;
        while (w.parent !== w && w.parent.__devonProxied) w = w.parent;
        return w.parent !== w ? w.parent : null;
      } catch (e) { return null; }
    }
    reportHook = function (info) { report(info); };
    activityHook = function (info) {
      try {
        var app = appWindow();
        if (app && typeof app.__devonPageActivity === 'function') app.__devonPageActivity(window, info);
      } catch (e) {}
    };
    function report(info) {
      try {
        var app = appWindow();
        if (app && typeof app.__devonPageError === 'function') {
          info.page = PAGE_URL;
          info.top = IS_TOP_PAGE;
          app.__devonPageError(window, info);
        }
      } catch (e) {}
    }
    window.addEventListener('error', function (e) {
      var t = e.target;
      // A <script> that failed to load (network/proxy error)
      if (t && t !== window && t.tagName === 'SCRIPT') {
        var src = t.getAttribute('src') || '';
        report({ kind: 'load', message: 'Script failed to load', file: realUrl(src) || src, proxied: src });
        return;
      }
      if (!e.message) return;
      // Harmless browser notice, not a real error
      if (String(e.message).indexOf('ResizeObserver loop') !== -1) return;
      var f = e.filename || '';
      report({
        kind: 'error',
        message: String(e.message),
        file: f.indexOf(MARK) !== -1 ? (realUrl(f) || f) : (f ? realUrl(f) || f : ''),
        proxied: f,
        line: e.lineno || 0,
        col: e.colno || 0,
        stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 600) : ''
      });
    }, true);
  })();

  // ---- Extensions: the app runs matching content scripts / userscripts in this
  // window now (document_start), before any of the page's own scripts
  try {
    var host = window;
    while (host.parent !== host && host.parent.__devonProxied) host = host.parent;
    host = host.parent !== host ? host.parent : null;
    if (host && typeof host.__devonExtHost === 'function') host.__devonExtHost(window, PAGE_URL, IS_TOP_PAGE);
  } catch (e) {}
})();
</script>`
}

function processHTML(content: string, pageUrl: string, proxyOrigin: string, experimental = false): string {
  const page = new URL(pageUrl)

  // Inline scripts and handlers need the same postMessage call-site rewrite as files
  if (experimental) content = rewritePostMessageCalls(content)

  // Markup is rewritten everywhere EXCEPT inside <script> elements: their code
  // may contain strings like '<style>…url('+x+')…' or 'src="'+u+'"' that the
  // attribute rewrites below would corrupt (breaking the whole script with
  // "SyntaxError: Unexpected EOF"). Scripts keep their code untouched; only
  // their opening tag (src, integrity) is rewritten.
  const rewriteMarkup = (input: string): string => {
    let markup = input
    // Protocol-relative references -> absolute, using the page's protocol
    markup = markup.replace(/\b(href|src|action)=(["'])\/\/([^"']+)\2/gi, `$1=$2${page.protocol}//$3$2`)

    // Relative resources go through the proxy. Rewritten URLs must be ABSOLUTE
    // (proxy origin) because the injected <base> would otherwise resolve
    // "/api/proxy?..." against the target site.
    markup = markup.replace(/\b(src|data-src|poster)=(["'])([^"']*)\2/gi, (match, attr: string, q: string, ref: string) => {
      const abs = proxiable(ref, pageUrl)
      return abs ? `${attr}=${q}${proxied(proxyOrigin, abs)}${q}` : match
    })

    // Responsive images
    markup = markup.replace(/\b(srcset|data-srcset)=(["'])([^"']*)\2/gi, (match, attr: string, q: string, value: string) => {
      if (!value.trim() || value.includes("data:")) return match // commas inside data URIs break parsing
      const out = value
        .split(",")
        .map((part) => {
          const [ref, ...descriptors] = part.trim().split(/\s+/)
          const abs = ref ? proxiable(ref, pageUrl) : null
          return abs ? [proxied(proxyOrigin, abs), ...descriptors].join(" ") : part.trim()
        })
        .join(", ")
      return `${attr}=${q}${out}${q}`
    })

    // Media streams through raw mode, so seeking (Range requests) works
    markup = markup.replace(/<(video|audio|source|track)\b[^>]*>/gi, rawMediaUrls)

    // Classic scripts need no rewriting, so they're streamed through raw mode too.
    // Buffering multi-megabyte bundles (YouTube's are ~10 MB) can hit a host's
    // response size or time limits, which truncates them: "Unexpected end of
    // script". Module scripts still need their import paths rewritten.
    if (!experimental) {
      markup = markup.replace(/<script\b[^>]*>/gi, (tag) =>
        /\btype=["']?module\b/i.test(tag) ? tag : rawMediaUrls(tag),
      )
    }

    // <style> blocks and style="" attributes
    markup = markup.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, open: string, css: string, close: string) =>
      open + processCSS(css, pageUrl, proxyOrigin) + close,
    )
    markup = markup.replace(/\bstyle="([^"]*url\([^"]*)"/gi, (_m, css: string) =>
      `style="${processCSS(css.replace(/&quot;/g, '"'), pageUrl, proxyOrigin).replace(/"/g, "&quot;")}"`,
    )
    markup = markup.replace(/\bstyle='([^']*url\([^']*)'/gi, (_m, css: string) =>
      `style='${processCSS(css, pageUrl, proxyOrigin).replace(/'/g, "&#39;")}'`,
    )

    markup = markup.replace(/<link\b([^>]*?)\bhref=(["'])([^"']*)\2([^>]*)>/gi, (match, before: string, q: string, ref: string, after: string) => {
      // Hints to connect to the real site are pointless (and leak) through a proxy
      if (/\brel=["']?(?:preconnect|dns-prefetch)/i.test(before + after)) return match
      const abs = proxiable(ref, pageUrl)
      return abs ? `<link${before}href=${q}${proxied(proxyOrigin, abs)}${q}${after}>` : match
    })

    // Subresource Integrity hashes can't match content the proxy rewrote
    markup = markup.replace(/<(script|link)\b[^>]*>/gi, (tag) =>
      tag.includes(PROXY_PATH) ? tag.replace(/\sintegrity=(["'])[^"']*\1/i, "") : tag,
    )
    return markup
  }

  content = content
    .split(/(<script\b[^>]*>[\s\S]*?<\/script\s*>)/i)
    .map((part, i) => {
      if (i % 2 === 0) return rewriteMarkup(part)
      const openEnd = part.indexOf(">") + 1
      return rewriteMarkup(part.slice(0, openEnd)) + part.slice(openEnd)
    })
    .join("")

  // <a> and <form> are left as-is: <base> resolves them and the injected
  // script intercepts clicks/submits and hands navigation to the parent app.
  // YouTube's embedded player refuses to start without referrer information
  // ("Error 153 Video player configuration error"), so its embed pages keep the
  // browser's default policy instead of no-referrer.
  const isYouTubeEmbed =
    /(^|\.)(youtube\.com|youtube-nocookie\.com)$/i.test(page.hostname) && page.pathname.startsWith("/embed/")
  const referrerPolicy = isYouTubeEmbed ? "strict-origin-when-cross-origin" : "no-referrer"
  const injection = `<base href="${page.href.replace(/"/g, "&quot;")}">
<meta name="referrer" content="${referrerPolicy}">
${buildInjectedScript(page.href, proxyOrigin, experimental)}`

  // Match <head> but not <header>
  const headRe = /<head(?:\s[^>]*)?>/i
  if (headRe.test(content)) return content.replace(headRe, (m) => `${m}\n${injection}`)
  const htmlRe = /<html(?:\s[^>]*)?>/i
  if (htmlRe.test(content)) return content.replace(htmlRe, (m) => `${m}\n<head>${injection}</head>`)
  return `<head>${injection}</head>\n${content}`
}

// ---------------------------------------------------------------------------
// Response building
// ---------------------------------------------------------------------------

/**
 * Compresses a rewritten body for the browser, with an exact Content-Length.
 * Hosting platforms cap response size (EdgeOne Pages truncated YouTube's
 * 4+ MB rewritten bundles at ~4 MB with no length set, and answers 413 when
 * a known length is over the cap, which the page script then recovers from by
 * loading the file in slices). Compressing makes most files ~4x smaller.
 */
function encodeBody(text: string, acceptEncoding: string | null): { body: Uint8Array; headers: Record<string, string> } {
  const raw = new TextEncoder().encode(text)
  const accepted = (acceptEncoding || "").toLowerCase()
  const offers = (e: string) => new RegExp(`(^|[\\s,])${e}(;|,|$|\\s)`).test(accepted)
  let body: Uint8Array = raw
  let encoding: string | null = null
  if (raw.byteLength > 1024) {
    if (offers("br")) {
      body = brotliCompressSync(raw, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 5, // fast, still ~4x smaller for JS
          [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.byteLength,
        },
      })
      encoding = "br"
    } else if (offers("gzip")) {
      body = gzipSync(raw, { level: 6 })
      encoding = "gzip"
    }
  }
  const headers: Record<string, string> = { "Content-Length": String(body.byteLength), Vary: "Accept-Encoding" }
  if (encoding) headers["Content-Encoding"] = encoding
  return { body, headers }
}

async function buildProxyResponse(
  upstream: Response,
  finalUrl: string,
  proxyOrigin: string,
  raw = false,
  isHead = false,
  experimental = false,
  acceptEncoding: string | null = null,
): Promise<NextResponse> {
  const status = upstream.status
  const contentType = upstream.headers.get("content-type") || "application/octet-stream"
  const path = new URL(finalUrl).pathname.toLowerCase()

  // Lets the client tell upstream responses (even 404s) apart from proxy errors
  const baseHeaders: Record<string, string> = { "X-Proxy-Final-Url": finalUrl }

  if (status === 204 || status === 205 || status === 304) {
    return new NextResponse(null, { status, headers: baseHeaders })
  }

  // Raw mode (the page's own fetch/XHR calls): pass the body through untouched
  if (raw) {
    // Static files (scripts, styles, images, fonts, media) may be cached like any
    // browser would; API responses never are
    const cacheable =
      status === 200 &&
      !isHead &&
      /javascript|ecmascript|text\/css|^image\/|^font\/|woff|^audio\/|^video\//i.test(contentType) &&
      !upstream.headers.get("set-cookie")
    const headers: Record<string, string> = {
      ...baseHeaders,
      "Content-Type": contentType,
      "Cache-Control": cacheable ? "public, max-age=3600" : "no-store",
    }
    // Never pass the upstream Content-Length on for a DECOMPRESSED body. The server's
    // fetch may have decompressed it (some runtimes even drop Content-Encoding
    // while doing so), and the host may re-compress the output: a copied length
    // then cuts files off early. On EdgeOne that truncated YouTube's 4+ MB
    // bundles at their compressed size ("SyntaxError: Unexpected EOF"). Streams
    // are sent chunked instead. HEAD has no body, so its length is safe (used
    // for download sizes).
    const length = upstream.headers.get("content-length")
    const encoding = upstream.headers.get("content-encoding")
    if (upstream.headers.get(PASSTHROUGH_HEADER)) {
      // Body is exactly the bytes the site sent: its encoding and length are accurate
      if (encoding) headers["Content-Encoding"] = encoding
      if (length) headers["Content-Length"] = length
      headers.Vary = "Accept-Encoding"
    } else if (isHead && length && !encoding) {
      headers["Content-Length"] = length
    }
    // Partial responses (media seeking) need their range to make sense
    for (const name of ["content-range", "accept-ranges"]) {
      const value = upstream.headers.get(name)
      if (value) headers[name === "content-range" ? "Content-Range" : "Accept-Ranges"] = value
    }
    const disposition = upstream.headers.get("content-disposition")
    if (disposition) headers["Content-Disposition"] = disposition
    // Raw responses are for the page's fetch/XHR: if one is opened as a document, no script runs
    if (DOCUMENT_TYPE_RE.test(contentType)) headers["Content-Security-Policy"] = SANDBOX_CSP
    // Streamed, so long-lived responses (EventSource, chunked APIs) keep working
    return new NextResponse(isHead ? null : upstream.body, { status, headers })
  }

  if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
    const html = processHTML(await upstream.text(), finalUrl, proxyOrigin, experimental)
    const encoded = encodeBody(html, acceptEncoding)
    return new NextResponse(isHead ? null : (encoded.body as BodyInit), {
      status,
      headers: {
        ...baseHeaders,
        ...encoded.headers,
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Permissions-Policy": PERMISSIONS_POLICY,
      },
    })
  }

  if (contentType.includes("javascript") || path.endsWith(".js") || path.endsWith(".mjs")) {
    const js = processJavaScript(await upstream.text(), finalUrl, proxyOrigin, experimental)
    const encoded = encodeBody(js, acceptEncoding)
    return new NextResponse(isHead ? null : (encoded.body as BodyInit), {
      status,
      headers: {
        ...baseHeaders,
        ...encoded.headers,
        "Content-Type": "application/javascript; charset=utf-8",
        // The rewrite depends on the experimental toggle (a cookie), so never
        // reuse a cached copy across modes
        "Cache-Control": experimental ? "no-store" : "public, max-age=3600",
        Vary: "Cookie, Accept-Encoding",
      },
    })
  }

  if (contentType.includes("text/css") || path.endsWith(".css")) {
    const css = processCSS(await upstream.text(), finalUrl, proxyOrigin)
    const encoded = encodeBody(css, acceptEncoding)
    return new NextResponse(isHead ? null : (encoded.body as BodyInit), {
      status,
      headers: {
        ...baseHeaders,
        ...encoded.headers,
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
    })
  }

  const headers: Record<string, string> = {
    ...baseHeaders,
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=3600",
  }
  const etag = upstream.headers.get("etag")
  if (etag) headers.ETag = etag
  const disposition = upstream.headers.get("content-disposition")
  if (disposition) headers["Content-Disposition"] = disposition
  // SVG/XML files are shown, not run: opened directly, their scripts stay off
  if (DOCUMENT_TYPE_RE.test(contentType)) headers["Content-Security-Policy"] = SANDBOX_CSP

  const data = await upstream.arrayBuffer()
  headers["Content-Length"] = String(data.byteLength) // lets an oversized file fail cleanly (413) instead of being cut off
  return new NextResponse(isHead ? null : data, { status, headers })
}

function emptyPage(url: string): NextResponse {
  return new NextResponse("<!DOCTYPE html><html><head><title></title></head><body></body></html>", {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Proxy-Final-Url": url },
  })
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof BlockedUrlError) {
    return NextResponse.json({ error: error.message }, { status: 403 })
  }
  if (error instanceof TypeError && /invalid url/i.test(error.message)) {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 })
  }
  const msg =
    error instanceof Error ? (error.name === "AbortError" ? "Request timeout" : error.message) : "Unknown error"
  return NextResponse.json({ error: msg }, { status: error instanceof Error && error.name === "AbortError" ? 504 : 502 })
}

// Request headers from the page that must not be forwarded upstream
const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "cookie",
  "origin",
  "referer",
  "connection",
  "content-length",
  "accept-encoding",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "forwarded",
])

function forwardableHeaders(request: NextRequest): Record<string, string> {
  const out: Record<string, string> = {}
  request.headers.forEach((value, key) => {
    const k = key.toLowerCase()
    if (DROPPED_REQUEST_HEADERS.has(k) || k.startsWith("sec-") || k.startsWith("x-vercel") || k.startsWith("next-")) return
    if (k === "content-type") return // set from the body below
    out[k] = value
  })
  return out
}

async function handle(
  request: NextRequest,
  targetUrl: string,
  init: UpstreamInit,
  raw = false,
): Promise<NextResponse> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS)
  // Also stop the upstream fetch if the browser cancels (e.g. the Stop button)
  const onClientAbort = () => controller.abort()
  request.signal?.addEventListener("abort", onClientAbort)

  const experimental = isExperimental(request)
  const jar = experimental ? new CookieJar(request.headers.get("cookie")) : undefined

  try {
    new URL(targetUrl) // validate early for a clean 400
    const method = init.method.toUpperCase()
    if (!raw && method === "GET" && PASSIVE_SIGNIN_RE.test(targetUrl)) return emptyPage(targetUrl)
    const fetcher = raw && (method === "GET" || method === "HEAD") ? fetchUpstreamPassthrough : fetchUpstream
    let upstreamResult: { response: Response; finalUrl: string }
    try {
      upstreamResult = await fetcher(
        targetUrl,
        { ...init, jar, acceptEncoding: request.headers.get("accept-encoding") },
        controller.signal,
      )
    } catch (error) {
      // The compressed passthrough is an optimisation; if it fails for any reason
      // other than a timeout or a blocked address, fall back to a normal fetch
      if (fetcher !== fetchUpstreamPassthrough || controller.signal.aborted || error instanceof BlockedUrlError) throw error
      console.warn("[proxy] passthrough failed, retrying with fetch:", error)
      upstreamResult = await fetchUpstream(targetUrl, { ...init, jar }, controller.signal)
    }
    const { response, finalUrl } = upstreamResult
    if (!raw && method === "GET" && PASSIVE_SIGNIN_RE.test(finalUrl)) {
      await response.body?.cancel().catch(() => {})
      return emptyPage(finalUrl)
    }
    const result = await buildProxyResponse(
      response,
      finalUrl,
      request.nextUrl.origin,
      raw,
      init.method.toUpperCase() === "HEAD",
      experimental,
      request.headers.get("accept-encoding"),
    )
    if (jar) {
      for (const header of jarSetCookieHeaders(jar, request.nextUrl.protocol === "https:")) {
        result.headers.append("Set-Cookie", header)
      }
    }
    return result
  } catch (error) {
    return errorResponse(error)
  } finally {
    clearTimeout(timeoutId)
    request.signal?.removeEventListener("abort", onClientAbort)
  }
}

/**
 * Raw mode: /api/proxy?url=<target>&raw=1 with any method. Used by the page's
 * own fetch()/XMLHttpRequest calls (rewritten by the injected script): the
 * method, body and most headers are forwarded, and the response is returned
 * without HTML/CSS/JS rewriting.
 */
async function handleRaw(request: NextRequest, targetUrl: string): Promise<NextResponse> {
  const method = request.method.toUpperCase()
  const hasBody = method !== "GET" && method !== "HEAD"
  const body = hasBody ? await request.arrayBuffer() : undefined
  const headers = forwardableHeaders(request)

  // ref = the real URL of the page making the request. Send the Referer and
  // Origin a browser would have sent from that page (many APIs check them).
  const ref = request.nextUrl.searchParams.get("ref")
  if (ref) {
    try {
      const refUrl = new URL(ref)
      if (refUrl.protocol === "http:" || refUrl.protocol === "https:") {
        refUrl.hash = ""
        headers.referer = refUrl.href
        if (hasBody || new URL(targetUrl).origin !== refUrl.origin) headers.origin = refUrl.origin
      }
    } catch {
      // ignore a bad ref
    }
  }

  return handle(
    request,
    targetUrl,
    {
      method,
      body: body && body.byteLength > 0 ? body : undefined,
      contentType: request.headers.get("content-type") || undefined,
      headers,
    },
    true,
  )
}

function rawTarget(request: NextRequest): string | null {
  const params = request.nextUrl.searchParams
  return params.get("raw") === "1" ? params.get("url") : null
}

/** Deletes every site cookie stored by the experimental cookie jar */
function clearJarCookies(request: NextRequest): NextResponse {
  const response = NextResponse.json({ cleared: true })
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const name = part.split("=")[0].trim()
    if (name.startsWith(JAR_PREFIX)) {
      response.headers.append("Set-Cookie", `${name}=; Path=${JAR_PATH}; Max-Age=0; HttpOnly; SameSite=Lax`)
    }
  }
  return response
}

/**
 * ?slice=<i>&sliceSize=<n> (raw mode): returns bytes [i*n, (i+1)*n) of the
 * DECOMPRESSED file, with X-Devon-More: 1 when there's more after it. Used by
 * the injected script to load files bigger than the host allows in one
 * response. Uses a Range request when the site supports it, otherwise reads
 * the file from the start and cuts the slice out.
 */
async function handleSlice(request: NextRequest, targetUrl: string, index: number, size: number): Promise<NextResponse> {
  const start = index * size
  const end = start + size // exclusive; one extra byte is read to detect "more"
  const headers: Record<string, string> = { range: `bytes=${start}-${end}`, "accept-encoding": "identity" }
  const ref = request.nextUrl.searchParams.get("ref")
  if (ref) {
    try {
      const refUrl = new URL(ref)
      if (refUrl.protocol === "http:" || refUrl.protocol === "https:") headers.referer = refUrl.href
    } catch {
      // ignore
    }
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    // Experimental mode rewrites scripts (postMessage calls), so slices must come
    // from the rewritten file, which only exists whole
    if (isExperimental(request) && request.nextUrl.searchParams.get("js") === "1") {
      const { response, finalUrl } = await fetchUpstream(targetUrl, { method: "GET" }, controller.signal)
      if (!response.ok) return NextResponse.json({ error: `HTTP ${response.status}` }, { status: 502 })
      const bytes = new TextEncoder().encode(
        processJavaScript(await response.text(), finalUrl, request.nextUrl.origin, true),
      )
      return new NextResponse(bytes.slice(start, end) as BodyInit, {
        status: 200,
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "X-Devon-More": bytes.byteLength > end ? "1" : "0",
          "X-Proxy-Final-Url": finalUrl,
          "Cache-Control": "no-store",
        },
      })
    }

    const { response, finalUrl } = await fetchUpstream(targetUrl, { method: "GET", headers }, controller.signal)
    if (response.status !== 200 && response.status !== 206) {
      await response.body?.cancel().catch(() => {})
      return NextResponse.json({ error: `HTTP ${response.status}` }, { status: 502 })
    }

    // 206: the body starts at `start`; 200: skip up to it ourselves
    let skip = response.status === 206 ? 0 : start
    const chunks: Uint8Array[] = []
    let kept = 0
    let more = false
    const reader = response.body?.getReader()
    if (reader) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        let chunk = value
        if (skip > 0) {
          if (chunk.byteLength <= skip) {
            skip -= chunk.byteLength
            continue
          }
          chunk = chunk.subarray(skip)
          skip = 0
        }
        const room = size - kept
        if (chunk.byteLength > room) {
          chunks.push(chunk.subarray(0, room))
          kept += room
          more = true
          break
        }
        chunks.push(chunk)
        kept += chunk.byteLength
      }
      await reader.cancel().catch(() => {})
    }
    // A 206 whose Content-Range says the file continues also means "more"
    const range = response.headers.get("content-range")
    const total = range ? Number(range.split("/")[1]) : NaN
    if (!more && Number.isFinite(total) && total > start + kept) more = true

    const body = new Uint8Array(kept)
    let offset = 0
    for (const c of chunks) {
      body.set(c, offset)
      offset += c.byteLength
    }
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": response.headers.get("content-type") || "application/octet-stream",
        "X-Devon-More": more ? "1" : "0",
        "X-Proxy-Final-Url": finalUrl,
        "Cache-Control": "public, max-age=3600",
        // Slices are only ever fetched; never let one run as a document
        "Content-Security-Policy": SANDBOX_CSP,
      },
    })
  } catch (error) {
    return errorResponse(error)
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function GET(request: NextRequest) {
  if (request.nextUrl.searchParams.get("clearCookies") === "1") return clearJarCookies(request)
  const targetUrl = request.nextUrl.searchParams.get("url")
  if (!targetUrl) {
    return NextResponse.json({ error: "URL parameter is required" }, { status: 400 })
  }
  const slice = request.nextUrl.searchParams.get("slice")
  if (rawTarget(request) && slice !== null) {
    const index = Math.max(0, Math.floor(Number(slice)) || 0)
    const size = Math.min(8 * 1024 * 1024, Math.max(64 * 1024, Math.floor(Number(request.nextUrl.searchParams.get("sliceSize"))) || 2 * 1024 * 1024))
    return handleSlice(request, targetUrl, index, size)
  }
  if (rawTarget(request)) {
    const response = await handleRaw(request, targetUrl)
    // ?download=<name>: save the file instead of displaying it (media downloads)
    const download = request.nextUrl.searchParams.get("download")
    const finalUrl = response.headers.get("X-Proxy-Final-Url")
    if (download !== null && finalUrl && response.status >= 200 && response.status < 300) {
      response.headers.set("Content-Disposition", attachmentHeader(download || fileNameFromUrl(finalUrl)))
      response.headers.set("X-Content-Type-Options", "nosniff")
    }
    return response
  }
  return handle(request, targetUrl, { method: "GET" })
}

function fileNameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop()
    if (last) return decodeURIComponent(last)
  } catch {
    // fall through
  }
  return "download"
}

/** Content-Disposition with an ASCII fallback plus the exact UTF-8 name (RFC 6266) */
function attachmentHeader(name: string): string {
  const clean = name.replace(/[\\/\r\n"]+/g, "_").slice(0, 200) || "download"
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_")
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`
}

export async function HEAD(request: NextRequest) {
  const targetUrl = request.nextUrl.searchParams.get("url")
  if (!targetUrl) return new NextResponse(null, { status: 400 })
  return handleRaw(request, targetUrl)
}

/**
 * Two modes:
 * - ?url=...&raw=1: raw passthrough (see handleRaw)
 * - JSON body { url: string, body?: string | object, contentType?: string }:
 *   used by the app for form submissions. A string body is forwarded as-is
 *   (urlencoded); an object body is sent as JSON, for backwards compatibility.
 */
export async function POST(request: NextRequest) {
  const raw = rawTarget(request)
  if (raw) return handleRaw(request, raw)

  const payload = await request.json().catch(() => ({}))
  const targetUrl = typeof payload?.url === "string" ? payload.url : ""
  if (!targetUrl) {
    return NextResponse.json({ error: "URL is required" }, { status: 400 })
  }

  let body: string | undefined
  let contentType: string | undefined
  if (typeof payload.body === "string") {
    body = payload.body
    contentType = typeof payload.contentType === "string" ? payload.contentType : "application/x-www-form-urlencoded"
  } else if (payload.body !== undefined && payload.body !== null) {
    body = JSON.stringify(payload.body)
    contentType = "application/json"
  }

  return handle(request, targetUrl, { method: "POST", body, contentType })
}

async function rawOnly(request: NextRequest): Promise<NextResponse> {
  const raw = rawTarget(request)
  if (!raw) return NextResponse.json({ error: "Only supported with raw=1" }, { status: 405 })
  return handleRaw(request, raw)
}

export const PUT = rawOnly
export const PATCH = rawOnly
export const DELETE = rawOnly
