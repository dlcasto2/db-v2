/**
 * Saves the page shown in a tab as a self-contained, offline-viewable ZIP
 * (index.html + assets/ + metadata.json). Port of the "Download for iOS"
 * userscript, adapted to Devon:
 *
 * - The DOM comes from the live proxied frame, so whatever the page has
 *   rendered (including script-built content) is what gets saved.
 * - Proxy URLs (/api/proxy?url=...) are turned back into the real ones, and
 *   Devon's injected <base>, referrer meta and script are stripped.
 * - Assets are downloaded through the proxy in raw mode, which returns the
 *   site's original bytes and avoids CORS entirely (the userscript needed
 *   GM_xmlhttpRequest for that).
 */

export interface ArchiveOptions {
  /**
   * Keep the page's scripts. Scripts often re-render an app on load and wipe
   * the saved DOM, so pages can open blank with this on.
   */
  saveScripts: boolean
  maxConcurrent?: number
  timeoutMs?: number
  maxAssetBytes?: number
  signal?: AbortSignal
}

export type ArchiveProgress =
  | { stage: "reading" }
  | { stage: "assets"; done: number; total: number }
  | { stage: "zipping"; percent: number }

export interface ArchiveResult {
  blob: Blob
  filename: string
  saved: number
  failed: string[]
}

type AssetKind = "css" | "js" | "bin"

interface AssetEntry {
  url: string
  kind: AssetKind
  path: string
}

const PROXY_PATH = "/api/proxy"
const HTML_PATH = "index.html"

/* ------------------------------------------------------------------- URLs */

/** Real URL behind a Devon proxy URL (or the URL itself if it isn't one) */
export function unproxy(url: string): string {
  try {
    const u = new URL(url)
    if (typeof location !== "undefined" && u.origin === location.origin && u.pathname === PROXY_PATH) {
      const target = u.searchParams.get("url")
      if (target) return target
    }
  } catch {
    // not a URL
  }
  return url
}

function absolutize(raw: string | null | undefined, base: string): string | null {
  if (!raw) return null
  const s = String(raw).trim()
  if (!s || s.startsWith("#")) return null
  if (/^(data|blob|javascript|about|mailto|tel|chrome|moz-extension):/i.test(s)) return null
  try {
    const u = new URL(unproxy(new URL(s, base).href))
    if (u.protocol !== "http:" && u.protocol !== "https:") return null
    u.hash = ""
    return u.href
  } catch {
    return null
  }
}

/** Like absolutize, but keeps the #fragment (for links) */
function absoluteLink(raw: string | null | undefined, base: string): string | null {
  if (!raw) return null
  const s = String(raw).trim()
  if (!s || s.startsWith("#") || /^(javascript|mailto|tel|data|blob):/i.test(s)) return null
  try {
    const u = new URL(unproxy(new URL(s, base).href))
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null
  } catch {
    return null
  }
}

function safeName(url: string): string {
  let name = ""
  try {
    name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "")
  } catch {
    // keep empty
  }
  name = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._]+/, "").slice(-60)
  return name || "asset"
}

/** Path of `to` as seen from the file at `from` (both relative to the ZIP root) */
function relativeTo(from: string, to: string): string {
  const dir = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "")
  const fromDir = dir(from)
  const toDir = dir(to)
  return fromDir === toDir ? to.slice(toDir ? toDir.length + 1 : 0) : to
}

/* -------------------------------------------------------------- Archiver */

class Archiver {
  private counter = 0
  readonly assets = new Map<string, AssetEntry>()
  private queue: AssetEntry[] = []
  readonly files = new Map<string, ArrayBuffer | string>()
  readonly failures: string[] = []

  constructor(
    private pageUrl: string,
    private opts: Required<Omit<ArchiveOptions, "signal">> & { signal?: AbortSignal },
  ) {}

  /** Assigns a local path now (so rewriting stays synchronous) and queues the download */
  register(url: string, kind: AssetKind): string {
    const existing = this.assets.get(url)
    if (existing) return existing.path

    let name = safeName(url)
    if (!/\.[A-Za-z0-9]{1,8}$/.test(name)) {
      if (kind === "css") name += ".css"
      else if (kind === "js") name += ".js"
    }
    const entry: AssetEntry = { url, kind, path: `assets/${String(++this.counter).padStart(3, "0")}-${name}` }
    this.assets.set(url, entry)
    this.queue.push(entry)
    return entry.path
  }

  /* ---- fetching (through the proxy, raw mode) ---- */

  private async grab(url: string, as: "text" | "bin"): Promise<string | ArrayBuffer | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs)
    const onAbort = () => controller.abort()
    this.opts.signal?.addEventListener("abort", onAbort)
    try {
      const res = await fetch(
        `${PROXY_PATH}?url=${encodeURIComponent(url)}&raw=1&ref=${encodeURIComponent(this.pageUrl)}`,
        { signal: controller.signal, credentials: "same-origin" },
      )
      // No final-URL header = the proxy itself refused (blocked host, DNS...)
      if (!res.ok || !res.headers.get("x-proxy-final-url")) return null
      const length = Number(res.headers.get("content-length") || 0)
      if (length > this.opts.maxAssetBytes) return null
      return as === "text" ? await res.text() : await res.arrayBuffer()
    } catch {
      return null
    } finally {
      clearTimeout(timer)
      this.opts.signal?.removeEventListener("abort", onAbort)
    }
  }

  async drain(onProgress: (done: number, total: number) => void) {
    let done = 0
    const worker = async () => {
      while (this.queue.length) {
        this.opts.signal?.throwIfAborted()
        const job = this.queue.shift()!
        try {
          if (job.kind === "css") {
            const text = await this.grab(job.url, "text")
            if (text == null) this.failures.push(job.url)
            // A stylesheet can queue more jobs; the loop picks them up
            else this.files.set(job.path, this.rewriteCss(text as string, job.url, job.path))
          } else {
            const buf = (await this.grab(job.url, "bin")) as ArrayBuffer | null
            if (!buf || !buf.byteLength) this.failures.push(job.url)
            else if (buf.byteLength > this.opts.maxAssetBytes) this.failures.push(`${job.url} (too large)`)
            else this.files.set(job.path, buf)
          }
        } catch {
          this.failures.push(job.url)
        }
        onProgress(++done, done + this.queue.length)
      }
    }
    await Promise.all(Array.from({ length: this.opts.maxConcurrent }, worker))
    this.opts.signal?.throwIfAborted()
  }

  /* ---- CSS ---- */

  rewriteCss(css: string, cssUrl: string, ownerPath: string): string {
    const holds: string[] = []

    // @import first, parked behind a placeholder so the url() pass below
    // doesn't re-resolve the path just written
    let out = css.replace(/@import\s+(?:url\(\s*)?(['"]?)([^'")\s]+)\1\s*\)?/gi, (match, _q, raw: string) => {
      const abs = absolutize(raw, cssUrl)
      if (!abs) return match
      holds.push(`@import url("${relativeTo(ownerPath, this.register(abs, "css"))}")`)
      return `@__HOLD_${holds.length - 1}__@`
    })

    out = out.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, _q, raw: string) => {
      const abs = absolutize(raw, cssUrl)
      if (!abs) return match
      return `url("${relativeTo(ownerPath, this.register(abs, "bin"))}")`
    })

    return out.replace(/@__HOLD_(\d+)__@/g, (_m, i) => holds[Number(i)])
  }

  /* ---- DOM ---- */

  rewriteDom(root: HTMLElement) {
    const base = this.pageUrl

    const local = (el: Element, attr: string, kind: AssetKind) => {
      const abs = absolutize(el.getAttribute(attr), base)
      if (abs) el.setAttribute(attr, relativeTo(HTML_PATH, this.register(abs, kind)))
    }

    const keepAbsolute = (el: Element, attr: string) => {
      const abs = absoluteLink(el.getAttribute(attr), base)
      if (abs) el.setAttribute(attr, abs)
    }

    const srcset = (el: Element, attr: string) => {
      const value = el.getAttribute(attr)
      if (!value || value.includes("data:")) return // commas inside data URIs break parsing
      const out = value
        .split(",")
        .map((part) => {
          const trimmed = part.trim()
          if (!trimmed) return null
          const [url, ...descriptors] = trimmed.split(/\s+/)
          const abs = absolutize(url, base)
          if (!abs) return trimmed
          return [relativeTo(HTML_PATH, this.register(abs, "bin")), ...descriptors].join(" ")
        })
        .filter(Boolean)
        .join(", ")
      el.setAttribute(attr, out)
    }

    // <noscript> content is plain text in a live page, so the passes below
    // can't see into it. Without scripts, unwrap it (it's what non-JS visitors
    // see) so it gets archived; with scripts, just point its URLs at the real site.
    root.querySelectorAll("noscript").forEach((el) => {
      const html = el.textContent || ""
      if (!this.opts.saveScripts) {
        const holder = el.ownerDocument.createElement("div")
        holder.innerHTML = html
        el.replaceWith(...Array.from(holder.childNodes))
      } else {
        el.textContent = html.replace(/(?:https?:)?\/\/[^\s"'()<>]*\/api\/proxy\?url=[^\s"'()<>]+/g, (m) => {
          const url = m.startsWith("//") ? location.protocol + m : m
          return unproxy(url.replace(/&amp;/g, "&"))
        })
      }
    })

    // Lazy-loaded images: promote the real URL into src before rewriting
    root.querySelectorAll("img[data-src], img[data-original]").forEach((img) => {
      const current = img.getAttribute("src") || ""
      if (!current || current.startsWith("data:")) {
        const real = img.getAttribute("data-src") || img.getAttribute("data-original")
        if (real) img.setAttribute("src", real)
      }
      if (!img.getAttribute("srcset") && img.getAttribute("data-srcset")) {
        img.setAttribute("srcset", img.getAttribute("data-srcset")!)
      }
    })
    root.querySelectorAll('img[loading="lazy"]').forEach((img) => img.removeAttribute("loading"))

    root.querySelectorAll("img[src], source[src], video[src], audio[src], embed[src], input[type=image][src]")
      .forEach((el) => local(el, "src", "bin"))
    root.querySelectorAll("img[srcset], source[srcset]").forEach((el) => srcset(el, "srcset"))
    root.querySelectorAll("video[poster]").forEach((el) => local(el, "poster", "bin"))
    root.querySelectorAll("object[data]").forEach((el) => local(el, "data", "bin"))
    root.querySelectorAll("image[href], use[href]").forEach((el) => {
      if (!(el.getAttribute("href") || "").startsWith("#")) local(el, "href", "bin")
    })
    const XLINK = "http://www.w3.org/1999/xlink"
    root.querySelectorAll("image, use").forEach((el) => {
      const raw = el.getAttributeNS(XLINK, "href")
      if (!raw || raw.startsWith("#")) return
      const abs = absolutize(raw, base)
      if (abs) el.setAttributeNS(XLINK, "xlink:href", relativeTo(HTML_PATH, this.register(abs, "bin")))
    })

    root.querySelectorAll("link[href]").forEach((el) => {
      const rel = (el.getAttribute("rel") || "").toLowerCase()
      const as = (el.getAttribute("as") || "").toLowerCase()
      if (rel.includes("stylesheet")) local(el, "href", "css")
      else if (rel.includes("icon")) local(el, "href", "bin")
      else if (rel.includes("preload") && ["font", "image", "style"].includes(as)) {
        local(el, "href", as === "style" ? "css" : "bin")
      } else if (/manifest|prefetch|preconnect|dns-prefetch|modulepreload/.test(rel)) {
        el.remove()
      } else {
        keepAbsolute(el, "href")
      }
    })

    root.querySelectorAll("script[src]").forEach((el) => {
      if (this.opts.saveScripts) local(el, "src", "js")
      else el.remove()
    })
    if (!this.opts.saveScripts) {
      root.querySelectorAll("script:not([src])").forEach((el) => {
        // Keep data blocks (JSON-LD etc.), drop code
        const type = (el.getAttribute("type") || "").toLowerCase()
        if (!type || /javascript|module|ecmascript/.test(type)) el.remove()
      })
    }

    // Anything not archived still needs an absolute URL, or it 404s offline
    root.querySelectorAll("a[href], area[href]").forEach((el) => keepAbsolute(el, "href"))
    root.querySelectorAll("form[action]").forEach((el) => keepAbsolute(el, "action"))
    root.querySelectorAll("iframe[src], frame[src]").forEach((el) => keepAbsolute(el, "src"))

    root.querySelectorAll("style").forEach((el) => {
      el.textContent = this.rewriteCss(el.textContent || "", base, HTML_PATH)
    })
    root.querySelectorAll("[style]").forEach((el) => {
      const value = el.getAttribute("style") || ""
      if (value.includes("url(")) el.setAttribute("style", this.rewriteCss(value, base, HTML_PATH))
    })
  }
}

/* --------------------------------------------------------------- Helpers */

/** Clone of the live page with everything Devon added removed */
function snapshot(doc: Document): HTMLElement {
  // Copy into an inert document of the app's own realm: the page's realm has
  // Devon's patched setAttribute/src setters, which would re-proxy the local
  // asset paths written below
  const inert = document.implementation.createHTMLDocument("")
  const root = inert.importNode(doc.documentElement, true) as HTMLElement

  // Devon's injected script (it marks pages with __devonProxied)
  root.querySelectorAll("script:not([src])").forEach((s) => {
    if ((s.textContent || "").includes("__devonProxied")) s.remove()
  })
  // Dev tools (Eruda) mounted by Devon
  root.querySelectorAll("#eruda, script[data-devon-eruda]").forEach((n) => n.remove())
  root.querySelectorAll("base").forEach((n) => n.remove())
  root.querySelectorAll('meta[name="referrer"][content="no-referrer"]').forEach((n) => n.remove())
  root.querySelectorAll("[integrity]").forEach((n) => n.removeAttribute("integrity"))
  root.querySelectorAll("[crossorigin]").forEach((n) => n.removeAttribute("crossorigin"))
  root.querySelectorAll("meta[http-equiv]").forEach((n) => {
    if (/content-security-policy/i.test(n.getAttribute("http-equiv") || "")) n.remove()
  })

  // Form state lives in properties, not attributes: copy it over so it's saved
  const live = doc.documentElement.querySelectorAll("input, textarea, select")
  const copies = root.querySelectorAll("input, textarea, select")
  if (live.length === copies.length) {
    live.forEach((el, i) => {
      const copy = copies[i]
      if (el instanceof HTMLInputElement) {
        if (el.type === "password" || el.type === "file" || el.type === "hidden") return
        if (el.type === "checkbox" || el.type === "radio") {
          if (el.checked) copy.setAttribute("checked", "")
          else copy.removeAttribute("checked")
        } else copy.setAttribute("value", el.value)
      } else if (el instanceof HTMLTextAreaElement) {
        copy.textContent = el.value
      }
    })
  }

  return root
}

export function archiveFilename(pageUrl: string, title: string, ext = "zip"): string {
  let host = "page"
  try {
    host = new URL(pageUrl).hostname.replace(/^www\./, "")
  } catch {
    // keep default
  }
  const slug =
    (title || "page")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "page"
  const stamp = new Date().toISOString().slice(0, 10)
  return `${host}-${slug}-${stamp}.${ext}`
}

/** Triggers a download; the object URL is kept for a while since revoking early cancels downloads on iOS Safari */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = name
  a.rel = "noopener"
  a.style.display = "none"
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    a.remove()
    URL.revokeObjectURL(url)
  }, 60_000)
}

/* ------------------------------------------------------------------ API */

export async function archivePage(
  doc: Document,
  pageUrl: string,
  title: string,
  options: ArchiveOptions,
  onProgress: (p: ArchiveProgress) => void,
): Promise<ArchiveResult> {
  const { default: JSZip } = await import("jszip")

  const archiver = new Archiver(pageUrl, {
    saveScripts: options.saveScripts,
    maxConcurrent: options.maxConcurrent ?? 6,
    timeoutMs: options.timeoutMs ?? 20_000,
    maxAssetBytes: options.maxAssetBytes ?? 25 * 1024 * 1024,
    signal: options.signal,
  })

  onProgress({ stage: "reading" })
  const root = snapshot(doc)
  archiver.rewriteDom(root)

  onProgress({ stage: "assets", done: 0, total: archiver.assets.size })
  await archiver.drain((done, total) => onProgress({ stage: "assets", done, total }))

  onProgress({ stage: "zipping", percent: 0 })
  const zip = new JSZip()
  const doctype = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>\n` : "<!DOCTYPE html>\n"
  const savedNote = `<!-- Saved with Devon Browser from ${pageUrl.replace(/--/g, "%2D%2D")} on ${new Date().toISOString()} -->\n`
  zip.file(HTML_PATH, doctype + savedNote + root.outerHTML)
  for (const [path, data] of archiver.files) zip.file(path, data)

  zip.file(
    "metadata.json",
    JSON.stringify(
      {
        url: pageUrl,
        title,
        downloadDate: new Date().toISOString(),
        savedWith: "Devon Browser",
        scriptsIncluded: options.saveScripts,
        savedAssets: [...archiver.assets.values()]
          .filter((a) => archiver.files.has(a.path))
          .map((a) => ({ path: a.path, source: a.url })),
        failed: archiver.failures,
      },
      null,
      2,
    ),
  )

  const blob = await zip.generateAsync(
    { type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } },
    (meta) => onProgress({ stage: "zipping", percent: Math.round(meta.percent) }),
  )
  options.signal?.throwIfAborted()

  return {
    blob,
    filename: archiveFilename(pageUrl, title),
    saved: archiver.files.size,
    failed: archiver.failures,
  }
}
