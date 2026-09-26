/**
 * Builds extension pages (popup, options, background) from an installed
 * package so they can run in a same-origin frame of the app.
 *
 * Package files become blob: URLs. Blob URLs can't resolve relative paths, so
 * everything that refers to another file is rewritten first: <script src>,
 * stylesheets (and the url()s inside them), images, and the import paths of
 * ES modules (recursively). chrome-extension://<id>/… URLs are mapped too.
 */

type Files = Record<string, Blob>

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i

/** Package path of `ref` as seen from the file at `fromPath` (null for external URLs) */
export function resolvePath(fromPath: string, ref: string, extId: string): string | null {
  let r = ref.trim()
  if (!r || r.startsWith("#") || r.startsWith("data:") || r.startsWith("blob:")) return null
  const own = new RegExp(`^chrome-extension://(?:${extId}|__MSG_@@extension_id__)/`, "i")
  if (own.test(r)) r = "/" + r.replace(own, "")
  else if (EXTERNAL.test(r)) return null
  try {
    const u = new URL(r, `https://ext.invalid/${fromPath}`)
    return decodeURIComponent(u.pathname.replace(/^\//, ""))
  } catch {
    return null
  }
}

export class PackageFiles {
  private urls = new Map<string, string>()
  private modules = new Map<string, Promise<string>>()
  private styles = new Map<string, Promise<string>>()
  /** Text of every .js file, prefetched for importScripts() (which must be synchronous) */
  readonly scriptTexts = new Map<string, string>()

  constructor(
    readonly extId: string,
    readonly files: Files,
  ) {}

  has(path: string) {
    return Boolean(this.files[path])
  }

  async text(path: string): Promise<string> {
    const blob = this.files[path]
    return blob ? blob.text() : ""
  }

  /** blob: URL of a file as-is */
  fileUrl(path: string): string | null {
    const clean = path.replace(/^\//, "").split(/[?#]/)[0]
    const existing = this.urls.get(clean)
    if (existing) return existing
    const blob = this.files[clean]
    if (!blob) return null
    const url = URL.createObjectURL(blob)
    this.urls.set(clean, url)
    return url
  }

  /** chrome-extension:// URL (or path) -> blob: URL, else the input unchanged */
  mapUrl(ref: string, fromPath = ""): string {
    const path = resolvePath(fromPath, ref, this.extId)
    return (path && this.fileUrl(path)) || ref
  }

  private blob(text: string, type: string) {
    const url = URL.createObjectURL(new Blob([text], { type }))
    this.urls.set(`@generated/${this.urls.size}`, url)
    return url
  }

  rewriteCss(css: string, fromPath: string): Promise<string> {
    const imports: Promise<[string, string]>[] = []
    css.replace(/@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1\s*\)?/gi, (m, _q, ref: string) => {
      const p = resolvePath(fromPath, ref, this.extId)
      if (p && this.files[p]) imports.push(this.cssUrl(p).then((u) => [ref, u]))
      return m
    })
    return Promise.all(imports).then((done) => {
      const map = new Map(done)
      return css
        .replace(/@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1\s*\)?/gi, (m, _q, ref: string) =>
          map.has(ref) ? `@import url("${map.get(ref)}")` : m,
        )
        .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, _q, ref: string) => {
          const p = resolvePath(fromPath, ref, this.extId)
          const u = p ? this.fileUrl(p) : null
          return u ? `url("${u}")` : m
        })
    })
  }

  /** Stylesheet with its url()s and @imports pointing at blob: URLs */
  cssUrl(path: string): Promise<string> {
    let p = this.styles.get(path)
    if (!p) {
      p = this.text(path).then((css) => this.rewriteCss(css, path)).then((css) => this.blob(css, "text/css"))
      this.styles.set(path, p)
    }
    return p
  }

  /** ES module with its imports rewritten to blob: URLs (recursively) */
  moduleUrl(path: string, visiting: Set<string> = new Set()): Promise<string> {
    const cached = this.modules.get(path)
    if (cached) return cached
    if (visiting.has(path)) return Promise.resolve(this.fileUrl(path) ?? "") // import cycle: best effort
    const next = new Set(visiting).add(path)
    const p = this.text(path).then(async (code) => {
      const specs = new Set<string>()
      const STATIC = /(\bfrom\s*|\bimport\s*)(["'])([^"'\n]+)\2/g
      const DYNAMIC = /\bimport\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g
      for (const m of code.matchAll(STATIC)) specs.add(m[3])
      for (const m of code.matchAll(DYNAMIC)) specs.add(m[2])
      const map = new Map<string, string>()
      await Promise.all(
        [...specs].map(async (spec) => {
          const target = resolvePath(path, spec, this.extId)
          if (!target || !this.files[target]) return
          const url = /\.(m?js|jsx?|ts)$/i.test(target) || !/\.[a-z0-9]+$/i.test(target)
            ? await this.moduleUrl(target, next)
            : /\.css$/i.test(target)
              ? await this.cssUrl(target)
              : this.fileUrl(target)
          if (url) map.set(spec, url)
        }),
      )
      const out = code
        .replace(STATIC, (m, pre: string, q: string, spec: string) => (map.has(spec) ? `${pre}${q}${map.get(spec)}${q}` : m))
        .replace(DYNAMIC, (m, q: string, spec: string) => (map.has(spec) ? `import(${q}${map.get(spec)}${q})` : m))
        // new URL("./asset.png", import.meta.url) etc. resolve against the extension's own URL
        .replace(/\bimport\.meta\.url\b/g, JSON.stringify(`chrome-extension://${this.extId}/${path}`))
      return this.blob(out, "text/javascript")
    })
    this.modules.set(path, p)
    return p
  }

  /** Prefetches every script's text (for importScripts in service workers) */
  async prefetchScripts() {
    await Promise.all(
      Object.keys(this.files)
        .filter((p) => /\.m?js$/i.test(p))
        .map(async (p) => this.scriptTexts.set(p, await this.text(p))),
    )
  }

  revoke() {
    this.urls.forEach((u) => URL.revokeObjectURL(u))
    this.urls.clear()
    this.modules.clear()
    this.styles.clear()
  }
}

const BOOT = `<script>(function(){try{var f=window.frameElement;if(f&&f.__devonBoot)f.__devonBoot(window)}catch(e){console.error(e)}})();</script>`

/** HTML of an extension page with every package reference turned into a blob: URL */
export async function buildPageHtml(pkg: PackageFiles, path: string): Promise<string> {
  const html = await pkg.text(path)
  const doc = new DOMParser().parseFromString(html || "<!DOCTYPE html><html><head></head><body></body></html>", "text/html")
  const jobs: Promise<void>[] = []

  doc.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]').forEach((m) => m.remove())

  doc.querySelectorAll("script[src]").forEach((el) => {
    const p = resolvePath(path, el.getAttribute("src") || "", pkg.extId)
    if (!p || !pkg.has(p)) return
    if ((el.getAttribute("type") || "").toLowerCase() === "module") {
      jobs.push(pkg.moduleUrl(p).then((u) => el.setAttribute("src", u)))
    } else {
      el.setAttribute("src", pkg.fileUrl(p)!)
    }
  })

  // Inline module scripts can import package files too
  doc.querySelectorAll('script[type="module"]:not([src])').forEach((el) => {
    const code = el.textContent || ""
    const specs = [...code.matchAll(/(\bfrom\s*|\bimport\s*)(["'])([^"'\n]+)\2/g)].map((m) => m[3])
    jobs.push(
      Promise.all(
        specs.map(async (spec) => {
          const p = resolvePath(path, spec, pkg.extId)
          return [spec, p && pkg.has(p) ? await pkg.moduleUrl(p) : null] as const
        }),
      ).then((pairs) => {
        let out = code
        for (const [spec, url] of pairs) if (url) out = out.split(spec).join(url)
        el.textContent = out
      }),
    )
  })

  doc.querySelectorAll("link[href]").forEach((el) => {
    const p = resolvePath(path, el.getAttribute("href") || "", pkg.extId)
    if (!p || !pkg.has(p)) return
    const rel = (el.getAttribute("rel") || "").toLowerCase()
    if (rel.includes("stylesheet")) jobs.push(pkg.cssUrl(p).then((u) => el.setAttribute("href", u)))
    else if (rel.includes("modulepreload")) jobs.push(pkg.moduleUrl(p).then((u) => el.setAttribute("href", u)))
    else el.setAttribute("href", pkg.fileUrl(p)!)
  })

  doc.querySelectorAll("style").forEach((el) => {
    jobs.push(pkg.rewriteCss(el.textContent || "", path).then((css) => void (el.textContent = css)))
  })

  for (const [sel, attr] of [
    ["img[src]", "src"],
    ["source[src]", "src"],
    ["video[src]", "src"],
    ["audio[src]", "src"],
    ["video[poster]", "poster"],
    ["input[type=image][src]", "src"],
    ["embed[src]", "src"],
    ["object[data]", "data"],
  ] as const) {
    doc.querySelectorAll(sel).forEach((el) => {
      const p = resolvePath(path, el.getAttribute(attr) || "", pkg.extId)
      const u = p ? pkg.fileUrl(p) : null
      if (u) el.setAttribute(attr, u)
    })
  }
  doc.querySelectorAll("img[srcset], source[srcset]").forEach((el) => {
    const v = el.getAttribute("srcset") || ""
    el.setAttribute(
      "srcset",
      v
        .split(",")
        .map((part) => {
          const [ref, ...rest] = part.trim().split(/\s+/)
          const p = ref ? resolvePath(path, ref, pkg.extId) : null
          const u = p ? pkg.fileUrl(p) : null
          return [u || ref, ...rest].join(" ")
        })
        .join(", "),
    )
  })

  await Promise.all(jobs)

  const head = doc.head || doc.documentElement
  head.insertAdjacentHTML("afterbegin", BOOT)
  return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML
}

/** HTML that runs a background page, background scripts or a service worker */
export async function buildBackgroundHtml(
  pkg: PackageFiles,
  bg: { page?: string; scripts: string[]; module: boolean },
): Promise<string> {
  if (bg.page && pkg.has(bg.page)) return buildPageHtml(pkg, bg.page)
  const tags = await Promise.all(
    bg.scripts
      .filter((p) => pkg.has(p))
      .map(async (p) =>
        bg.module ? `<script type="module" src="${await pkg.moduleUrl(p)}"></script>` : `<script src="${pkg.fileUrl(p)}"></script>`,
      ),
  )
  return `<!DOCTYPE html>\n<html><head>${BOOT}</head><body>${tags.join("\n")}</body></html>`
}
