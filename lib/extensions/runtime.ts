/**
 * Runs installed extensions inside proxied pages.
 *
 * The proxy's injected script calls window.__devonExtHost(pageWindow, url, isTop)
 * on the app window at document_start (see app/api/proxy/route.tsx). Pages are
 * same-origin with the app, so the host can compile the scripts directly in the
 * page's realm (new pageWindow.Function) and hand them a chrome.* / GM_* API.
 *
 * Content scripts share the page's window (there is no isolated world), and
 * only the parts of the chrome.* API that make sense without a background
 * page are provided.
 */
import { matchesContentScript, matchesPattern, matchesUserscript } from "./match"
import { PackageFiles, buildBackgroundHtml, buildPageHtml, resolvePath } from "./pages"
import {
  type ChromeExtension,
  type LoadedExtension,
  type RunAt,
  type Userscript,
  localizeMessage,
  storageKey,
} from "./store"

type AnyFn = (...args: any[]) => any // eslint-disable-line @typescript-eslint/no-explicit-any
type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

/** A Devon tab, as extensions see it */
export interface TabInfo {
  key: string
  url: string
  title: string
  active: boolean
  favIconUrl?: string
  /** The tab's page window (only the active tab has one) */
  win: Window | null
}

export type ExtensionPageKind = "popup" | "options" | "background"

export interface HostCallbacks {
  openTab: (url: string) => void
  notify: (title: string, text: string, onClick?: () => void) => void
  getTabs?: () => TabInfo[]
  navigateTab?: (key: string, url: string) => void
  activateTab?: (key: string) => void
  reloadTab?: (key: string) => void
  closeTab?: (key: string) => void
  /** Show an extension's popup or options page */
  openExtensionPage?: (extId: string, kind: "popup" | "options") => void
  closePopup?: () => void
  /** Badges etc. changed: re-render */
  changed?: () => void
}

/** A place an extension's code runs: a content script in a page, or one of its own pages */
interface Ctx {
  extId: string
  kind: "content" | ExtensionPageKind
  win: Window
  /** content scripts: the real page URL; pages: chrome-extension://id/path */
  url: string
  isTop?: boolean
  tabKey?: string
}

export interface MenuCommand {
  key: string
  extensionId: string
  extensionName: string
  caption: string
  run: () => void
}

interface Listener {
  extId: string
  kind: "storage" | "gm" | "message" | "connect" | "event"
  win: Window
  fn: AnyFn
  ctx?: Ctx
  /** kind "event": which chrome.* event (e.g. "alarms.onAlarm") */
  name?: string
}

interface Port {
  name: string
  sender?: Json
  onMessage: Json
  onDisconnect: Json
  postMessage: (m: Json) => void
  disconnect: () => void
}

interface InnerPort extends Port {
  __receive: (text: string) => void
  __peerGone: (peer: unknown) => void
  __link: (peer: InnerPort) => void
}

interface RegisteredCommand extends MenuCommand {
  win: Window
  id: string
}

declare global {
  interface Window {
    __devonExtHost?: (win: Window, url: string, isTop: boolean) => void
    __devonProxied?: boolean
    // Page windows are used as realms (their own console, constructors)
    console: Console
    MutationObserver: typeof MutationObserver
  }
}

const HANDLER_NAME = "Devon"
const HANDLER_VERSION = "1.0"

function alive(win: Window): boolean {
  try {
    return !win.closed && Boolean(win.document)
  } catch {
    return false
  }
}

/** The proxied page at the top of this frame's chain (the tab's page) */
function tabWindow(win: Window): Window {
  let w = win
  try {
    while (w.parent !== w && w.parent.__devonProxied) w = w.parent
  } catch {
    // cross-origin parent: stop here
  }
  return w
}

function readData(id: string): Record<string, Record<string, Json>> {
  try {
    const raw = localStorage.getItem(storageKey(id))
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function writeData(id: string, data: Record<string, Record<string, Json>>) {
  try {
    localStorage.setItem(storageKey(id), JSON.stringify(data))
  } catch (error) {
    console.warn("[Devon extensions] Couldn't save extension data:", error)
  }
}

const clone = (value: Json): Json => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

export class ExtensionHost {
  private loaded: LoadedExtension[] = []
  private blobUrls = new Map<string, { stamp: number; urls: Map<string, string> }>()
  private listeners: Listener[] = []
  private commands: RegisteredCommand[] = []
  private ran = new WeakMap<Window, Set<string>>()
  private sessionStorage = new Map<string, Record<string, Json>>()

  private appWindow: Window | null = null
  private contexts: Ctx[] = []
  private packages = new Map<string, { stamp: number; pkg: PackageFiles }>()
  private backgrounds = new Map<string, { stamp: number; frame: HTMLIFrameElement }>()
  private manifests = new Map<string, Record<string, Json>>()
  private badges = new Map<string, { text: string; color?: string }>()
  private popupOverride = new Map<string, string>()
  private alarms = new Map<string, Map<string, { timer: number; info: Json }>>()
  private tabIds = new Map<string, number>()
  private nextTabId = 1

  constructor(private callbacks: HostCallbacks) {}

  attach(appWindow: Window) {
    this.appWindow = appWindow
    appWindow.__devonExtHost = (win, url, isTop) => this.run(win, url, isTop)
    return () => {
      if (appWindow.__devonExtHost) delete appWindow.__devonExtHost
    }
  }

  setCallbacks(callbacks: HostCallbacks) {
    this.callbacks = callbacks
  }

  setExtensions(list: LoadedExtension[]) {
    this.loaded = list
    // Drop object URLs of extensions that were removed, disabled or updated
    for (const [id, entry] of this.blobUrls) {
      const current = list.find((l) => l.ext.id === id && l.ext.enabled)
      if (!current || current.ext.updatedAt !== entry.stamp) {
        entry.urls.forEach((u) => URL.revokeObjectURL(u))
        this.blobUrls.delete(id)
      }
    }
    for (const [id, entry] of this.packages) {
      const current = list.find((l) => l.ext.id === id && l.ext.enabled)
      if (!current || current.ext.updatedAt !== entry.stamp) {
        entry.pkg.revoke()
        this.packages.delete(id)
      }
    }
    void this.syncBackgrounds()
  }

  // =========================================================================
  // Extension pages: popup, options, background
  // =========================================================================

  private findLoaded(extId: string) {
    const loaded = this.loaded.find((l) => l.ext.id === extId && l.ext.enabled && l.ext.type === "chrome")
    return loaded as (LoadedExtension & { ext: ChromeExtension }) | undefined
  }

  private pkgFor(loaded: LoadedExtension): PackageFiles {
    let entry = this.packages.get(loaded.ext.id)
    if (!entry || entry.stamp !== loaded.ext.updatedAt) {
      entry?.pkg.revoke()
      entry = { stamp: loaded.ext.updatedAt, pkg: new PackageFiles(loaded.ext.id, loaded.files) }
      this.packages.set(loaded.ext.id, entry)
    }
    return entry.pkg
  }

  private async manifestOf(loaded: LoadedExtension): Promise<Record<string, Json>> {
    const cached = this.manifests.get(loaded.ext.id)
    if (cached) return cached
    let manifest: Record<string, Json> = {}
    try {
      const blob = loaded.files["manifest.json"]
      if (blob) manifest = JSON.parse((await blob.text()).replace(/^\uFEFF/, ""))
    } catch {
      manifest = {}
    }
    this.manifests.set(loaded.ext.id, manifest)
    return manifest
  }

  /** Popup path of an extension (chrome.action.setPopup can change it), if any */
  popupOf(extId: string): string | undefined {
    const loaded = this.findLoaded(extId)
    if (!loaded) return undefined
    return this.popupOverride.has(extId) ? this.popupOverride.get(extId) || undefined : loaded.ext.pages?.popup
  }

  optionsOf(extId: string): string | undefined {
    return this.findLoaded(extId)?.ext.pages?.options
  }

  badgeOf(extId: string) {
    return this.badges.get(extId)
  }

  /** True if clicking the extension should do something (popup, or background onClicked listeners) */
  hasAction(extId: string): boolean {
    if (this.popupOf(extId)) return true
    return this.listeners.some(
      (l) => l.extId === extId && l.kind === "event" && /^(action|browserAction|pageAction)\.onClicked$/.test(l.name ?? "") && alive(l.win),
    )
  }

  /** The toolbar button was clicked and there's no popup: fire action.onClicked */
  clickAction(extId: string) {
    const tab = this.activeTabObject()
    for (const name of ["action.onClicked", "browserAction.onClicked", "pageAction.onClicked"]) {
      this.fireNamed(extId, name, (w) => [this.toRealm(w, tab)])
    }
  }

  /** Loads an extension page into a frame (the UI calls this for popups and options pages) */
  async mountPage(frame: HTMLIFrameElement, extId: string, kind: "popup" | "options", path?: string) {
    const loaded = this.findLoaded(extId)
    if (!loaded) throw new Error("This extension isn't installed or is turned off")
    const pagePath = path ?? (kind === "popup" ? this.popupOf(extId) : this.optionsOf(extId))
    if (!pagePath) throw new Error(`This extension has no ${kind === "popup" ? "popup" : "options page"}`)
    const pkg = this.pkgFor(loaded)
    await this.manifestOf(loaded)
    const html = await buildPageHtml(pkg, pagePath)
    await this.writeFrame(frame, html, (win) => this.bootPage(win, loaded, kind, pkg, pagePath))
  }

  /** Loads /devon-frame.html (a real same-origin page), then writes the extension's HTML into it */
  private writeFrame(frame: HTMLIFrameElement, html: string, boot: (win: Window) => void): Promise<void> {
    return new Promise((resolve) => {
      const onLoad = () => {
        frame.removeEventListener("load", onLoad)
        const doc = frame.contentDocument
        if (!doc) return resolve()
        ;(frame as HTMLIFrameElement & { __devonBoot?: (w: Window) => void }).__devonBoot = boot
        setTimeout(() => {
          doc.open()
          doc.write(html)
          doc.close()
          resolve()
        }, 0)
      }
      frame.addEventListener("load", onLoad)
      frame.src = `/devon-frame.html?ext=${Date.now()}`
    })
  }

  private async syncBackgrounds() {
    const app = this.appWindow
    if (!app) return
    const wanted = this.loaded.filter(
      (l) => l.ext.enabled && l.ext.type === "chrome" && (l.ext as ChromeExtension).pages?.background,
    ) as (LoadedExtension & { ext: ChromeExtension })[]
    // Stop backgrounds of removed / disabled / updated extensions
    for (const [id, bg] of this.backgrounds) {
      const current = wanted.find((l) => l.ext.id === id)
      if (!current || current.ext.updatedAt !== bg.stamp) {
        this.stopBackground(id)
      }
    }
    for (const loaded of wanted) {
      if (this.backgrounds.has(loaded.ext.id)) continue
      try {
        await this.startBackground(loaded)
      } catch (error) {
        console.error(`[${loaded.ext.name}] background failed to start:`, error)
      }
    }
  }

  private stopBackground(extId: string) {
    const bg = this.backgrounds.get(extId)
    if (!bg) return
    const win = bg.frame.contentWindow
    this.contexts = this.contexts.filter((c) => c.win !== win)
    this.alarms.get(extId)?.forEach((a) => clearTimeout(a.timer))
    this.alarms.delete(extId)
    bg.frame.remove()
    this.backgrounds.delete(extId)
  }

  private async startBackground(loaded: LoadedExtension & { ext: ChromeExtension }) {
    const app = this.appWindow
    const bg = loaded.ext.pages?.background
    if (!app || !bg) return
    const pkg = this.pkgFor(loaded)
    await this.manifestOf(loaded)
    if (bg.serviceWorker) await pkg.prefetchScripts()
    const html = await buildBackgroundHtml(pkg, bg)
    const frame = app.document.createElement("iframe")
    frame.setAttribute("data-devon-extension-background", loaded.ext.id)
    frame.setAttribute("aria-hidden", "true")
    frame.tabIndex = -1
    frame.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none;left:-9999px;top:0"
    app.document.body.appendChild(frame)
    this.backgrounds.set(loaded.ext.id, { stamp: loaded.ext.updatedAt, frame })
    const path = bg.page ?? bg.scripts[0] ?? "background.js"
    await this.writeFrame(frame, html, (win) => this.bootPage(win, loaded, "background", pkg, path))
    const win = frame.contentWindow
    if (!win) return
    const afterLoad = () => this.afterBackgroundStart(loaded, win, bg.serviceWorker)
    if (win.document.readyState === "complete") win.setTimeout(afterLoad, 50)
    else win.addEventListener("load", () => win.setTimeout(afterLoad, 50), { once: true })
  }

  private afterBackgroundStart(loaded: LoadedExtension, win: Window, serviceWorker: boolean) {
    if (serviceWorker) {
      // Service worker lifecycle events some workers wait for
      for (const type of ["install", "activate"]) {
        try {
          const ev = new (win as unknown as { Event: typeof Event }).Event(type) as Event & { waitUntil?: AnyFn }
          ev.waitUntil = () => {}
          win.dispatchEvent(ev)
        } catch {
          // ignore
        }
      }
    }
    const key = `devon-ext-installed:${loaded.ext.id}`
    let previous: string | null = null
    try {
      previous = localStorage.getItem(key)
      localStorage.setItem(key, loaded.ext.version || "0")
    } catch {
      // ignore
    }
    if (previous === null) {
      this.fireNamed(loaded.ext.id, "runtime.onInstalled", (w) => [this.toRealm(w, { reason: "install" })])
    } else if (previous !== (loaded.ext.version || "0")) {
      this.fireNamed(loaded.ext.id, "runtime.onInstalled", (w) => [
        this.toRealm(w, { reason: "update", previousVersion: previous }),
      ])
    } else {
      this.fireNamed(loaded.ext.id, "runtime.onStartup", () => [])
    }
  }

  /** Runs in the extension page's window before any of its own scripts */
  private bootPage(win: Window, loaded: LoadedExtension, kind: ExtensionPageKind, pkg: PackageFiles, path: string) {
    const ext = loaded.ext as ChromeExtension
    const ctx: Ctx = { extId: ext.id, kind, win, url: `chrome-extension://${ext.id}/${path}` }
    this.contexts = this.contexts.filter((c) => alive(c.win) && c.win !== win)
    this.contexts.push(ctx)
    const api = this.chromeApi(loaded, ext, win, ctx)
    for (const name of ["chrome", "browser"]) {
      try {
        Object.defineProperty(win, name, { value: api, configurable: true, writable: true })
      } catch {
        ;(win as unknown as Record<string, unknown>)[name] = api
      }
    }

    const w = win as Window & typeof globalThis
    const appOrigin = location.origin

    // Package files and chrome-extension:// URLs -> blob: URLs; other sites -> through the proxy
    const mapTarget = (raw: string): string | null => {
      if (!raw) return null
      const s = String(raw)
      if (/^(blob|data):/i.test(s)) return null
      if (/^chrome-extension:/i.test(s) || !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(s)) {
        const p = resolvePath(path, s, ext.id)
        return p ? pkg.fileUrl(p) : null
      }
      try {
        const u = new URL(s)
        if (u.origin === appOrigin) {
          const p = decodeURIComponent(u.pathname.replace(/^\//, ""))
          return pkg.has(p) ? pkg.fileUrl(p) : null
        }
        if (u.protocol === "http:" || u.protocol === "https:") {
          return `${appOrigin}/api/proxy?url=${encodeURIComponent(u.href)}&raw=1`
        }
      } catch {
        // not a URL
      }
      return null
    }
    const mapLocal = (raw: string): string | null => {
      const s = String(raw ?? "")
      if (/^(https?:)?\/\//i.test(s) && !s.startsWith(appOrigin)) return null // leave external images etc. alone
      return mapTarget(s)
    }

    const nativeFetch = w.fetch.bind(w)
    w.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const isReq = typeof input === "object" && input !== null && "url" in input && !(input instanceof w.URL)
      const url = isReq ? (input as Request).url : String(input)
      const target = mapTarget(url)
      if (!target) return nativeFetch(input, init)
      if (!isReq) return nativeFetch(target, init)
      const req = input as Request
      const method = String(init?.method || req.method || "GET").toUpperCase()
      const body: Promise<BodyInit | null | undefined> =
        init && "body" in init ? Promise.resolve(init.body) : method === "GET" || method === "HEAD" ? Promise.resolve(undefined) : req.clone().arrayBuffer()
      return body.then((b) =>
        nativeFetch(target, { method, headers: init?.headers || req.headers, body: b, signal: init?.signal || req.signal }),
      )
    }) as typeof fetch

    const xhrOpen = w.XMLHttpRequest.prototype.open
    w.XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      const target = mapTarget(String(url))
      return (xhrOpen as AnyFn).call(this, method, target ?? url, ...rest)
    } as typeof xhrOpen

    // Elements whose src/href is set to a package path
    const props: [string, string][] = [
      ["HTMLImageElement", "src"],
      ["HTMLScriptElement", "src"],
      ["HTMLLinkElement", "href"],
      ["HTMLSourceElement", "src"],
      ["HTMLMediaElement", "src"],
      ["HTMLInputElement", "src"],
    ]
    for (const [cls, prop] of props) {
      const C = (w as unknown as Record<string, { prototype: object } | undefined>)[cls]
      if (!C) continue
      const d = Object.getOwnPropertyDescriptor(C.prototype, prop)
      if (!d?.set || !d.get) continue
      Object.defineProperty(C.prototype, prop, {
        configurable: true,
        enumerable: d.enumerable,
        get: d.get,
        set(this: Element, v: unknown) {
          d.set!.call(this, mapLocal(String(v)) ?? v)
        },
      })
    }
    const setAttr = w.Element.prototype.setAttribute
    w.Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
      const n = String(name).toLowerCase()
      if ((n === "src" || (n === "href" && this.tagName === "LINK")) && typeof value === "string") {
        const mapped = mapLocal(value)
        if (mapped) value = mapped
      }
      return setAttr.call(this, name, value)
    }
    new w.MutationObserver((records) => {
      for (const r of records) {
        r.addedNodes.forEach((node) => {
          if (node.nodeType !== 1) return
          const el = node as Element
          const all = [el, ...Array.from(el.querySelectorAll("img[src],script[src],link[href],source[src]"))]
          for (const e of all) {
            const attr = e.tagName === "LINK" ? "href" : "src"
            const v = e.getAttribute(attr)
            if (!v || /^(blob|data):/i.test(v)) continue
            const mapped = mapLocal(v)
            if (mapped && mapped !== v) setAttr.call(e, attr, mapped)
          }
        })
      }
    }).observe(w.document, { childList: true, subtree: true })

    // Links: other sites open in a Devon tab; the extension's own pages load in place
    w.document.addEventListener(
      "click",
      (e) => {
        const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null
        if (!a || e.defaultPrevented) return
        const href = a.getAttribute("href") || ""
        if (!href || href.startsWith("#") || /^javascript:/i.test(href)) return
        const p = resolvePath(path, href, ext.id)
        if (p && pkg.has(p)) {
          e.preventDefault()
          const frame = w.frameElement as HTMLIFrameElement | null
          if (frame && kind !== "background") void this.mountPage(frame, ext.id, kind, p)
          return
        }
        if (/^https?:/i.test(href) || /^\/\//.test(href)) {
          e.preventDefault()
          this.callbacks.openTab(new URL(href, "https://x.invalid").href)
        }
      },
      true,
    )
    w.open = ((url?: string | URL) => {
      const s = url === undefined ? "" : String(url)
      const p = s ? resolvePath(path, s, ext.id) : null
      if (p && p === (this.optionsOf(ext.id) ?? "")) this.callbacks.openExtensionPage?.(ext.id, "options")
      else if (/^https?:/i.test(s)) this.callbacks.openTab(s)
      return null
    }) as typeof window.open
    if (kind === "popup") w.close = () => this.callbacks.closePopup?.()

    if (kind === "background") {
      const scope = w as unknown as Record<string, unknown>
      // Service worker globals the page doesn't have
      scope.importScripts = (...files: string[]) => {
        for (const f of files) {
          const p = resolvePath(path, String(f), ext.id)
          const code = p ? pkg.scriptTexts.get(p) : undefined
          if (code === undefined) throw new Error(`importScripts: ${f} not found in the extension`)
          ;(0, w.eval)(`${code}\n//# sourceURL=devon-extension://${encodeURIComponent(ext.name)}/${p}`)
        }
      }
      const P = w.Promise
      scope.clients = {
        matchAll: () => P.resolve([]),
        claim: () => P.resolve(),
        get: () => P.resolve(undefined),
        openWindow: (u: string) => {
          if (/^https?:/i.test(u)) this.callbacks.openTab(u)
          return P.resolve(null)
        },
      }
      scope.registration = {
        scope: `chrome-extension://${ext.id}/`,
        active: null,
        showNotification: (title: string, opts?: { body?: string }) => {
          this.callbacks.notify(String(title), opts?.body ?? "")
          return P.resolve()
        },
        getNotifications: () => P.resolve([]),
        unregister: () => P.resolve(true),
        update: () => P.resolve(),
      }
      scope.skipWaiting = () => P.resolve()
    }
  }

  // =========================================================================
  // Messaging
  // =========================================================================

  private toRealm(win: Window, value: Json): Json {
    if (value === undefined) return undefined
    try {
      return (win as unknown as { JSON: JSON }).JSON.parse(JSON.stringify(value))
    } catch {
      return value
    }
  }

  private tabKeyFor(win: Window): string | undefined {
    const tabs = this.callbacks.getTabs?.() ?? []
    const top = tabWindow(win)
    return tabs.find((t) => t.win === top)?.key ?? tabs.find((t) => t.active)?.key
  }

  private tabIdOf(key: string): number {
    let id = this.tabIds.get(key)
    if (!id) {
      id = this.nextTabId++
      this.tabIds.set(key, id)
    }
    return id
  }

  private tabKeyOf(id: number): string | undefined {
    for (const [key, n] of this.tabIds) if (n === id) return key
    return undefined
  }

  private tabObject(info: TabInfo, index: number) {
    return {
      id: this.tabIdOf(info.key),
      index,
      windowId: 1,
      active: info.active,
      highlighted: info.active,
      selected: info.active,
      pinned: false,
      audible: false,
      discarded: false,
      autoDiscardable: true,
      incognito: false,
      status: "complete",
      url: info.url,
      pendingUrl: undefined,
      title: info.title,
      favIconUrl: info.favIconUrl,
      groupId: -1,
      mutedInfo: { muted: false },
    }
  }

  private allTabObjects() {
    return (this.callbacks.getTabs?.() ?? []).map((t, i) => this.tabObject(t, i))
  }

  private activeTabObject() {
    const tabs = this.callbacks.getTabs?.() ?? []
    const i = tabs.findIndex((t) => t.active)
    return i >= 0 ? this.tabObject(tabs[i], i) : undefined
  }

  private tabInfoById(id: number | undefined): TabInfo | undefined {
    const tabs = this.callbacks.getTabs?.() ?? []
    if (id === undefined || id === null) return tabs.find((t) => t.active)
    const key = this.tabKeyOf(id)
    return tabs.find((t) => t.key === key)
  }

  private senderFor(from: Ctx) {
    const tabs = this.callbacks.getTabs?.() ?? []
    const i = from.tabKey ? tabs.findIndex((t) => t.key === from.tabKey) : -1
    let origin = ""
    try {
      origin = new URL(from.url).origin
    } catch {
      origin = ""
    }
    return {
      id: from.extId,
      url: from.url,
      origin,
      frameId: from.kind === "content" ? (from.isTop === false ? 1 : 0) : undefined,
      tab: from.kind === "content" && i >= 0 ? this.tabObject(tabs[i], i) : undefined,
    }
  }

  /** Delivers a one-off message; resolves with the first response */
  private deliver(extId: string, from: Ctx, target: (c: Ctx) => boolean, message: Json): Promise<Json> {
    const payload = JSON.stringify(message === undefined ? null : message)
    return new Promise((resolve) => {
      const app = this.appWindow ?? window
      app.setTimeout(() => {
        const listeners = this.listeners.filter(
          (l) => l.extId === extId && l.kind === "message" && l.ctx && l.win !== from.win && alive(l.win) && target(l.ctx),
        )
        let done = false
        let waiting = 0
        const finish = (v: Json) => {
          if (done) return
          done = true
          resolve(v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
        }
        const sender = this.senderFor(from)
        for (const l of listeners) {
          let keep = false
          try {
            const msg = (l.win as unknown as { JSON: JSON }).JSON.parse(payload)
            const r = l.fn(msg, this.toRealm(l.win, sender), (v: Json) => finish(v))
            if (r === true) keep = true
            else if (r && typeof (r as Promise<Json>).then === "function") {
              keep = true
              ;(r as Promise<Json>).then(
                (v) => finish(v),
                (e) => {
                  l.win.console.error(e)
                  finish(undefined)
                },
              )
            }
          } catch (error) {
            l.win.console.error(error)
          }
          if (keep) waiting++
        }
        if (!waiting) finish(undefined)
      }, 0)
    })
  }

  private makePort(win: Window, name: string, sender?: Json): InnerPort {
    const msgFns = new Set<AnyFn>()
    const discFns = new Set<AnyFn>()
    let peers: InnerPort[] = []
    let connected = true
    const evt = (set: Set<AnyFn>) => ({
      addListener: (f: AnyFn) => typeof f === "function" && set.add(f),
      removeListener: (f: AnyFn) => set.delete(f),
      hasListener: (f: AnyFn) => set.has(f),
      hasListeners: () => set.size > 0,
    })
    const port: InnerPort = {
      name,
      sender,
      onMessage: evt(msgFns),
      onDisconnect: evt(discFns),
      postMessage: (m: Json) => {
        if (!connected) throw new Error("Attempting to use a disconnected port object")
        const text = JSON.stringify(m === undefined ? null : m)
        for (const peer of peers) peer.__receive(text)
      },
      disconnect: () => {
        if (!connected) return
        connected = false
        const gone = peers
        peers = []
        for (const peer of gone) peer.__peerGone(port)
      },
      __receive: (text: string) => {
        win.setTimeout(() => {
          for (const f of msgFns) {
            try {
              f((win as unknown as { JSON: JSON }).JSON.parse(text), port)
            } catch (error) {
              win.console.error(error)
            }
          }
        }, 0)
      },
      __peerGone: (peer: unknown) => {
        peers = peers.filter((p) => p !== peer)
        if (!peers.length && connected) {
          connected = false
          win.setTimeout(() => {
            for (const f of discFns) {
              try {
                f(port)
              } catch (error) {
                win.console.error(error)
              }
            }
          }, 0)
        }
      },
      __link: (peer: InnerPort) => {
        peers.push(peer)
      },
    }
    for (const k of ["__receive", "__peerGone", "__link"]) Object.defineProperty(port, k, { enumerable: false })
    return port
  }

  private connect(extId: string, from: Ctx, target: (c: Ctx) => boolean, name: string): Port {
    const mine = this.makePort(from.win, name)
    const sender = this.senderFor(from)
    const app = this.appWindow ?? window
    app.setTimeout(() => {
      const listeners = this.listeners.filter(
        (l) => l.extId === extId && l.kind === "connect" && l.ctx && l.win !== from.win && alive(l.win) && target(l.ctx),
      )
      if (!listeners.length) {
        mine.__peerGone(null)
        return
      }
      for (const l of listeners) {
        const theirs = this.makePort(l.win, name, this.toRealm(l.win, sender))
        mine.__link(theirs)
        theirs.__link(mine)
        try {
          l.fn(theirs)
        } catch (error) {
          l.win.console.error(error)
        }
      }
    }, 0)
    return mine
  }

  /** Fires a named chrome.* event (e.g. "alarms.onAlarm") in every context that listens */
  private fireNamed(extId: string, name: string, args: (win: Window) => unknown[]) {
    for (const l of this.listeners) {
      if (l.extId !== extId || l.kind !== "event" || l.name !== name || !alive(l.win)) continue
      l.win.setTimeout(() => {
        try {
          l.fn(...args(l.win))
        } catch (error) {
          l.win.console.error(error)
        }
      }, 0)
    }
  }

  /** A Devon tab finished loading or changed URL: tell extensions (tabs.onUpdated) */
  tabUpdated(key: string) {
    const tabs = this.callbacks.getTabs?.() ?? []
    const i = tabs.findIndex((t) => t.key === key)
    if (i < 0) return
    const tab = this.tabObject(tabs[i], i)
    for (const loaded of this.loaded) {
      if (loaded.ext.type !== "chrome" || !loaded.ext.enabled) continue
      this.fireNamed(loaded.ext.id, "tabs.onUpdated", (w) => [
        tab.id,
        this.toRealm(w, { status: "complete", url: tab.url, title: tab.title }),
        this.toRealm(w, tab),
      ])
    }
  }

  /** The active Devon tab changed (tabs.onActivated) */
  tabActivated(key: string) {
    const id = this.tabIdOf(key)
    for (const loaded of this.loaded) {
      if (loaded.ext.type !== "chrome" || !loaded.ext.enabled) continue
      this.fireNamed(loaded.ext.id, "tabs.onActivated", (w) => [this.toRealm(w, { tabId: id, windowId: 1 })])
    }
  }

  /** Extensions that ran in the given tab page (or frames inside it) */
  ranIn(win: Window | null | undefined): Set<string> {
    return (win && this.ran.get(win)) || new Set()
  }

  /** Userscript menu commands registered by the given tab page and its frames */
  menuCommands(win: Window | null | undefined): MenuCommand[] {
    this.commands = this.commands.filter((c) => alive(c.win))
    if (!win) return []
    return this.commands.filter((c) => tabWindow(c.win) === win)
  }

  // -------------------------------------------------------------------------

  private run(win: Window, url: string, isTop: boolean) {
    this.listeners = this.listeners.filter((l) => alive(l.win))
    for (const loaded of this.loaded) {
      if (!loaded.ext.enabled) continue
      try {
        const ran =
          loaded.ext.type === "chrome"
            ? this.runChrome(loaded, loaded.ext, win, url, isTop)
            : this.runUserscript(loaded, loaded.ext, win, url, isTop)
        if (ran) {
          const tab = tabWindow(win)
          const set = this.ran.get(tab) ?? new Set<string>()
          set.add(loaded.ext.id)
          this.ran.set(tab, set)
        }
      } catch (error) {
        win.console.error(`[${loaded.ext.name}]`, error)
      }
    }
  }

  private schedule(win: Window, when: RunAt | "document_body", fn: () => void) {
    const doc = win.document
    const ready = (cb: () => void) => {
      if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", cb, { once: true })
      else cb()
    }
    if (when === "document_start") fn()
    else if (when === "document_end") ready(fn)
    else if (when === "document_idle") ready(() => win.setTimeout(fn, 0))
    else {
      // document_body: as soon as <body> exists
      if (doc.body) return fn()
      const observer = new win.MutationObserver(() => {
        if (doc.body) {
          observer.disconnect()
          fn()
        }
      })
      observer.observe(doc.documentElement, { childList: true })
    }
  }

  /**
   * Compiles now (document_start, before any page CSP <meta> applies) and
   * returns a runner. Code shares one scope, like files of one content script.
   */
  private compile(win: Window, ext: { name: string }, label: string, params: string[], code: string) {
    const source = `${code}\n//# sourceURL=devon-extension://${encodeURIComponent(ext.name)}/${label}`
    let fn: AnyFn
    try {
      fn = new (win as unknown as { Function: FunctionConstructor }).Function(...params, source) as AnyFn
    } catch (error) {
      win.console.error(`[${ext.name}] ${label} failed to compile:`, error)
      return null
    }
    return (args: unknown[]) => {
      try {
        fn.apply(win, args)
      } catch (error) {
        win.console.error(`[${ext.name}]`, error)
      }
    }
  }

  private fileUrl(loaded: LoadedExtension, path: string): string | null {
    const clean = path.replace(/^\//, "").split(/[?#]/)[0]
    let entry = this.blobUrls.get(loaded.ext.id)
    if (!entry) {
      entry = { stamp: loaded.ext.updatedAt, urls: new Map() }
      this.blobUrls.set(loaded.ext.id, entry)
    }
    const existing = entry.urls.get(clean)
    if (existing) return existing
    const blob = loaded.files[clean]
    if (!blob) return null
    const url = URL.createObjectURL(blob)
    entry.urls.set(clean, url)
    return url
  }

  private addStyle(win: Window, css: string): HTMLStyleElement {
    const doc = win.document
    const style = doc.createElement("style")
    style.setAttribute("data-devon-extension", "")
    style.textContent = css
    ;(doc.head || doc.documentElement).appendChild(style)
    // A page CSP (<meta> style-src) blocks inline <style>; constructed sheets aren't affected
    if (!style.sheet) {
      try {
        const sheet = new (win as unknown as { CSSStyleSheet: typeof CSSStyleSheet }).CSSStyleSheet()
        sheet.replaceSync(css)
        doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet]
      } catch {
        // very old browser
      }
    }
    return style
  }

  // ---- Chrome extensions --------------------------------------------------

  private runChrome(loaded: LoadedExtension, ext: ChromeExtension, win: Window, url: string, isTop: boolean): boolean {
    const rules = ext.contentScripts.filter((r) => (isTop || r.allFrames) && matchesContentScript(r, url))
    if (!rules.length) return false

    const css = rules
      .flatMap((r) => r.css)
      .map((p) => loaded.texts.get(p) ?? "")
      .join("\n")
      .replace(
        new RegExp(`chrome-extension://(?:__MSG_@@extension_id__|${ext.id})/([^'")\\s]+)`, "g"),
        (m, p: string) => this.fileUrl(loaded, p) ?? m,
      )
    if (css.trim()) this.addStyle(win, css)

    const ctx: Ctx = { extId: ext.id, kind: "content", win, url, isTop, tabKey: this.tabKeyFor(win) }
    this.contexts = this.contexts.filter((c) => alive(c.win))
    this.contexts.push(ctx)
    const chrome = this.chromeApi(loaded, ext, win, ctx)
    for (const when of ["document_start", "document_end", "document_idle"] as const) {
      const files = [...new Set(rules.filter((r) => r.runAt === when).flatMap((r) => r.js))]
      if (!files.length) continue
      const code = files.map((p) => `${loaded.texts.get(p) ?? ""}\n;`).join("\n")
      const runner = this.compile(win, ext, `${when}.js`, ["chrome", "browser"], code)
      if (runner) this.schedule(win, when, () => runner([chrome, chrome]))
    }
    return true
  }

  private event(extId: string, win: Window, kind?: "storage") {
    const local = new Set<AnyFn>()
    return {
      addListener: (fn: AnyFn) => {
        if (typeof fn !== "function") return
        local.add(fn)
        if (kind) this.listeners.push({ extId, kind, win, fn })
      },
      removeListener: (fn: AnyFn) => {
        local.delete(fn)
        if (kind) this.listeners = this.listeners.filter((l) => l.fn !== fn)
      },
      hasListener: (fn: AnyFn) => local.has(fn),
      hasListeners: () => local.size > 0,
    }
  }

  private fire(extId: string, kind: Listener["kind"], args: (win: Window) => unknown[]) {
    for (const l of this.listeners) {
      if (l.extId !== extId || l.kind !== kind || !alive(l.win)) continue
      l.win.setTimeout(() => {
        try {
          l.fn(...args(l.win))
        } catch (error) {
          l.win.console.error(error)
        }
      }, 0)
    }
  }

  /** Calls back and/or resolves a Promise from the page's realm, like chrome.* does */
  private respond<T>(win: Window, callback: unknown, value: () => T): Promise<T> | undefined {
    const P = (win as unknown as { Promise: PromiseConstructor }).Promise
    const promise = new P<T>((resolve, reject) => {
      win.setTimeout(() => {
        try {
          resolve(value())
        } catch (error) {
          reject(error)
        }
      }, 0)
    })
    if (typeof callback === "function") {
      promise.then(
        (v) => (callback as AnyFn)(v),
        (e) => win.console.error(e),
      )
      return undefined
    }
    return promise
  }

  private chromeApi(loaded: LoadedExtension, ext: ChromeExtension, win: Window, ctx: Ctx) {
    const toPage = (value: Json) => (value === undefined ? undefined : (win as unknown as { JSON: JSON }).JSON.parse(JSON.stringify(value)))

    const area = (name: "local" | "sync" | "session") => {
      const read = (): Record<string, Json> =>
        name === "session" ? { ...(this.sessionStorage.get(ext.id) ?? {}) } : { ...(readData(ext.id)[name] ?? {}) }
      const write = (items: Record<string, Json>) => {
        if (name === "session") this.sessionStorage.set(ext.id, items)
        else {
          const data = readData(ext.id)
          data[name] = items
          writeData(ext.id, data)
        }
      }
      const changed = (changes: Record<string, { oldValue?: Json; newValue?: Json }>) => {
        if (!Object.keys(changes).length) return
        this.fire(ext.id, "storage", (w) => {
          const c = (w as unknown as { JSON: JSON }).JSON.parse(JSON.stringify(changes))
          return [c, name]
        })
      }
      return {
        QUOTA_BYTES: 10485760,
        get: (keys?: unknown, callback?: unknown) => {
          if (typeof keys === "function") [keys, callback] = [undefined, keys]
          return this.respond(win, callback, () => {
            const all = read()
            let out: Record<string, Json> = {}
            if (keys === undefined || keys === null) out = all
            else if (typeof keys === "string") {
              if (keys in all) out[keys] = all[keys]
            } else if (Array.isArray(keys)) {
              for (const k of keys) if (k in all) out[k] = all[k]
            } else if (typeof keys === "object") {
              for (const [k, def] of Object.entries(keys as object)) out[k] = k in all ? all[k] : def
            }
            return toPage(out)
          })
        },
        set: (items: Record<string, Json>, callback?: unknown) =>
          this.respond(win, callback, () => {
            const all = read()
            const changes: Record<string, { oldValue?: Json; newValue?: Json }> = {}
            for (const [k, v] of Object.entries(items ?? {})) {
              const newValue = clone(v)
              changes[k] = { oldValue: all[k], newValue }
              all[k] = newValue
            }
            write(all)
            changed(changes)
            return undefined
          }),
        remove: (keys: string | string[], callback?: unknown) =>
          this.respond(win, callback, () => {
            const all = read()
            const changes: Record<string, { oldValue?: Json }> = {}
            for (const k of Array.isArray(keys) ? keys : [keys]) {
              if (k in all) {
                changes[k] = { oldValue: all[k] }
                delete all[k]
              }
            }
            write(all)
            changed(changes)
            return undefined
          }),
        clear: (callback?: unknown) =>
          this.respond(win, callback, () => {
            const all = read()
            write({})
            changed(Object.fromEntries(Object.entries(all).map(([k, v]) => [k, { oldValue: v }])))
            return undefined
          }),
        getBytesInUse: (_keys?: unknown, callback?: unknown) => {
          if (typeof _keys === "function") callback = _keys
          return this.respond(win, callback, () => JSON.stringify(read()).length)
        },
        setAccessLevel: () => this.respond(win, undefined, () => undefined),
        onChanged: this.event(ext.id, win),
      }
    }

    const isPage = ctx.kind !== "content"
    const pkg = isPage ? this.pkgFor(loaded) : null
    const getURL = (path: string) => {
      const p = String(path ?? "").replace(/^\//, "")
      return (pkg ? pkg.fileUrl(p.split(/[?#]/)[0]) : this.fileUrl(loaded, p)) ?? `chrome-extension://${ext.id}/${p}`
    }
    const P = (win as unknown as { Promise: PromiseConstructor }).Promise
    const ok = (callback?: unknown, value?: () => Json) => this.respond(win, callback, () => (value ? toPage(value()) : undefined))
    const lastArgFn = (args: unknown[]) => (typeof args[args.length - 1] === "function" ? (args[args.length - 1] as AnyFn) : undefined)
    const named = (name: string) => {
      const local = new Set<AnyFn>()
      return {
        addListener: (fn: AnyFn) => {
          if (typeof fn !== "function") return
          local.add(fn)
          this.listeners.push({ extId: ext.id, kind: "event", name, win, fn })
        },
        removeListener: (fn: AnyFn) => {
          local.delete(fn)
          this.listeners = this.listeners.filter((l) => !(l.fn === fn && l.name === name && l.win === win))
        },
        hasListener: (fn: AnyFn) => local.has(fn),
        hasListeners: () => local.size > 0,
      }
    }
    const typedEvent = (kind: "message" | "connect") => {
      const local = new Set<AnyFn>()
      return {
        addListener: (fn: AnyFn) => {
          if (typeof fn !== "function") return
          local.add(fn)
          this.listeners.push({ extId: ext.id, kind, win, fn, ctx })
        },
        removeListener: (fn: AnyFn) => {
          local.delete(fn)
          this.listeners = this.listeners.filter((l) => !(l.fn === fn && l.kind === kind && l.win === win))
        },
        hasListener: (fn: AnyFn) => local.has(fn),
        hasListeners: () => local.size > 0,
      }
    }

    // Content scripts talk to the extension's pages; pages talk to each other
    const toPages = (c: Ctx) => c.kind !== "content"
    const sendMessage = (...args: unknown[]) => {
      const callback = lastArgFn(args)
      const rest = callback ? args.slice(0, -1) : args
      // (extensionId?, message, options?)
      if (rest.length >= 2 && typeof rest[0] === "string" && /^[a-p]{32}$/.test(rest[0] as string)) rest.shift()
      const message = rest[0]
      const promise = this.deliver(ext.id, ctx, toPages, message as Json).then((v) => toPage(v))
      if (callback) {
        promise.then((v) => callback(v), (e) => win.console.error(e))
        return undefined
      }
      return P.resolve(promise)
    }
    const connect = (...args: unknown[]) => {
      const info = args.find((a) => a && typeof a === "object") as { name?: string } | undefined
      return this.connect(ext.id, ctx, toPages, info?.name ?? "")
    }

    // ---- tabs
    const tabTarget = (tabId: unknown) => {
      const info = this.tabInfoById(typeof tabId === "number" ? tabId : undefined)
      return (c: Ctx) => c.kind === "content" && Boolean(info) && c.tabKey === info!.key
    }
    const runInTab = (tabId: unknown, code: string, params: string[] = [], args: unknown[] = []) => {
      const info = this.tabInfoById(typeof tabId === "number" ? tabId : undefined)
      const tabWin = info?.win
      if (!tabWin || !alive(tabWin)) throw new Error("Cannot access contents of this tab (only the tab shown in Devon can be scripted)")
      const tabCtx: Ctx = { extId: ext.id, kind: "content", win: tabWin, url: info!.url, isTop: true, tabKey: info!.key }
      this.contexts.push(tabCtx)
      const chrome = this.chromeApi(loaded, ext, tabWin, tabCtx)
      const fn = new (tabWin as unknown as { Function: FunctionConstructor }).Function("chrome", "browser", ...params, code)
      return fn.call(tabWin, chrome, chrome, ...args)
    }
    const filesCode = async (files: unknown) =>
      (await Promise.all((Array.isArray(files) ? files : [files]).map((f) => this.pkgFor(loaded).text(String(f).replace(/^\//, ""))))).join("\n;\n")
    const tabs = {
      TAB_ID_NONE: -1,
      query: (queryInfo: Record<string, Json> = {}, callback?: unknown) =>
        ok(callback, () => {
          const all = this.allTabObjects()
          const urls = queryInfo.url === undefined ? null : Array.isArray(queryInfo.url) ? queryInfo.url : [queryInfo.url]
          return all.filter((t) => {
            if (queryInfo.active !== undefined && t.active !== queryInfo.active) return false
            if (queryInfo.highlighted !== undefined && t.highlighted !== queryInfo.highlighted) return false
            if (queryInfo.status !== undefined && queryInfo.status !== "complete") return false
            if (urls && !urls.some((u: string) => matchesPattern(u, t.url))) return false
            if (typeof queryInfo.title === "string" && queryInfo.title !== t.title) return false
            return true
          })
        }),
      get: (tabId: number, callback?: unknown) => ok(callback, () => this.allTabObjects().find((t) => t.id === tabId)),
      getCurrent: (callback?: unknown) => ok(callback, () => (ctx.kind === "content" ? this.senderFor(ctx).tab : undefined)),
      create: (props: { url?: string; active?: boolean } = {}, callback?: unknown) =>
        ok(callback, () => {
          const url = props.url ? String(props.url) : ""
          const p = url ? resolvePath(ctx.kind === "content" ? "" : ctx.url.split("/").slice(3).join("/"), url, ext.id) : null
          if (p && p === this.optionsOf(ext.id)) this.callbacks.openExtensionPage?.(ext.id, "options")
          else if (p && p === this.popupOf(ext.id)) this.callbacks.openExtensionPage?.(ext.id, "popup")
          else if (/^https?:/i.test(url)) this.callbacks.openTab(url)
          else if (url) win.console.warn(`[${ext.name}] Devon can't open ${url} in a tab`)
          return { id: -1, index: -1, windowId: 1, active: props.active !== false, url, pinned: false, incognito: false, highlighted: false }
        }),
      update: (...args: unknown[]) => {
        const callback = lastArgFn(args)
        const rest = callback ? args.slice(0, -1) : args
        const tabId = typeof rest[0] === "number" ? (rest.shift() as number) : undefined
        const props = (rest[0] ?? {}) as { url?: string; active?: boolean }
        return ok(callback, () => {
          const info = this.tabInfoById(tabId)
          if (info && props.url && /^https?:/i.test(props.url)) this.callbacks.navigateTab?.(info.key, props.url)
          if (info && props.active) this.callbacks.activateTab?.(info.key)
          return info ? this.allTabObjects().find((t) => t.id === this.tabIdOf(info.key)) : undefined
        })
      },
      reload: (...args: unknown[]) => {
        const callback = lastArgFn(args)
        const tabId = typeof args[0] === "number" ? (args[0] as number) : undefined
        return ok(callback, () => {
          const info = this.tabInfoById(tabId)
          if (info) this.callbacks.reloadTab?.(info.key)
          return undefined
        })
      },
      remove: (ids: number | number[], callback?: unknown) =>
        ok(callback, () => {
          for (const id of Array.isArray(ids) ? ids : [ids]) {
            const key = this.tabKeyOf(id)
            if (key) this.callbacks.closeTab?.(key)
          }
          return undefined
        }),
      sendMessage: (tabId: number, message: Json, ...rest: unknown[]) => {
        const callback = lastArgFn(rest)
        const promise = this.deliver(ext.id, ctx, tabTarget(tabId), message).then((v) => toPage(v))
        if (callback) {
          promise.then((v) => callback(v), (e) => win.console.error(e))
          return undefined
        }
        return P.resolve(promise)
      },
      connect: (tabId: number, info?: { name?: string }) => this.connect(ext.id, ctx, tabTarget(tabId), info?.name ?? ""),
      executeScript: (...args: unknown[]) => {
        const callback = lastArgFn(args)
        const rest = callback ? args.slice(0, -1) : args
        const tabId = typeof rest[0] === "number" ? (rest.shift() as number) : undefined
        const details = (rest[0] ?? {}) as { code?: string; file?: string }
        const promise = (async () => {
          const code = details.code ?? (details.file ? await filesCode(details.file) : "")
          const value = runInTab(tabId, `return eval(${JSON.stringify(code)})`)
          return toPage([await value])
        })()
        if (callback) {
          promise.then((v) => callback(v), (e) => win.console.error(e))
          return undefined
        }
        return P.resolve(promise)
      },
      insertCSS: (...args: unknown[]) => {
        const callback = lastArgFn(args)
        const rest = callback ? args.slice(0, -1) : args
        const tabId = typeof rest[0] === "number" ? (rest.shift() as number) : undefined
        const details = (rest[0] ?? {}) as { code?: string; file?: string }
        const promise = (async () => {
          const css = details.code ?? (details.file ? await filesCode(details.file) : "")
          const info = this.tabInfoById(tabId)
          if (info?.win) this.addStyle(info.win, css)
          return undefined
        })()
        if (callback) {
          promise.then(() => callback(), (e) => win.console.error(e))
          return undefined
        }
        return P.resolve(promise)
      },
      captureVisibleTab: () => P.reject(new Error("Devon can't capture tab screenshots")),
      onUpdated: named("tabs.onUpdated"),
      onActivated: named("tabs.onActivated"),
      onCreated: named("tabs.onCreated"),
      onRemoved: named("tabs.onRemoved"),
      onReplaced: named("tabs.onReplaced"),
      onHighlighted: named("tabs.onHighlighted"),
      onMoved: named("tabs.onMoved"),
    }

    // ---- scripting (MV3)
    const scripting = {
      executeScript: (injection: { target?: { tabId?: number }; func?: AnyFn; args?: unknown[]; files?: string[] }, callback?: unknown) => {
        const promise = (async () => {
          const tabId = injection.target?.tabId
          let result: unknown
          if (typeof injection.func === "function") {
            result = await runInTab(tabId, `return (${injection.func.toString()}).apply(this, __devonArgs)`, ["__devonArgs"], [
              this.toRealm(this.tabInfoById(tabId)?.win ?? win, injection.args ?? []),
            ])
          } else if (injection.files?.length) {
            result = runInTab(tabId, await filesCode(injection.files))
          }
          return toPage([{ frameId: 0, result: result === undefined ? null : result, documentId: "devon" }])
        })()
        if (typeof callback === "function") {
          promise.then((v) => (callback as AnyFn)(v), (e) => win.console.error(e))
          return undefined
        }
        return P.resolve(promise)
      },
      insertCSS: (injection: { target?: { tabId?: number }; css?: string; files?: string[] }, callback?: unknown) => {
        const promise = (async () => {
          const css = injection.css ?? (injection.files?.length ? await filesCode(injection.files) : "")
          const info = this.tabInfoById(injection.target?.tabId)
          if (info?.win) this.addStyle(info.win, css)
          return undefined
        })()
        if (typeof callback === "function") {
          promise.then(() => (callback as AnyFn)(), (e) => win.console.error(e))
          return undefined
        }
        return P.resolve(promise)
      },
      removeCSS: (_i: unknown, callback?: unknown) => ok(callback),
      registerContentScripts: (_s: unknown, callback?: unknown) => ok(callback),
      unregisterContentScripts: (_s: unknown, callback?: unknown) => ok(callback),
      getRegisteredContentScripts: (_f: unknown, callback?: unknown) => ok(typeof _f === "function" ? _f : callback, () => []),
    }

    // ---- toolbar button (action / browserAction / pageAction)
    const actionApi = (prefix: string) => ({
      setBadgeText: (details: { text?: string }, callback?: unknown) =>
        ok(callback, () => {
          const prev = this.badges.get(ext.id)
          this.badges.set(ext.id, { ...prev, text: String(details?.text ?? "") })
          this.callbacks.changed?.()
          return undefined
        }),
      getBadgeText: (_d: unknown, callback?: unknown) => ok(callback, () => this.badges.get(ext.id)?.text ?? ""),
      setBadgeBackgroundColor: (details: { color?: unknown }, callback?: unknown) =>
        ok(callback, () => {
          const c = details?.color
          const color = Array.isArray(c) ? `rgba(${c[0]},${c[1]},${c[2]},${(c[3] ?? 255) / 255})` : typeof c === "string" ? c : undefined
          this.badges.set(ext.id, { text: this.badges.get(ext.id)?.text ?? "", color })
          this.callbacks.changed?.()
          return undefined
        }),
      getBadgeBackgroundColor: (_d: unknown, callback?: unknown) => ok(callback, () => [0, 0, 0, 0]),
      setBadgeTextColor: (_d: unknown, callback?: unknown) => ok(callback),
      setTitle: (_d: unknown, callback?: unknown) => ok(callback),
      getTitle: (_d: unknown, callback?: unknown) => ok(callback, () => ext.name),
      setIcon: (_d: unknown, callback?: unknown) => ok(callback),
      setPopup: (details: { popup?: string }, callback?: unknown) =>
        ok(callback, () => {
          const p = details?.popup ? resolvePath("", String(details.popup), ext.id) : ""
          this.popupOverride.set(ext.id, p || "")
          this.callbacks.changed?.()
          return undefined
        }),
      getPopup: (_d: unknown, callback?: unknown) =>
        ok(callback, () => (this.popupOf(ext.id) ? `chrome-extension://${ext.id}/${this.popupOf(ext.id)}` : "")),
      enable: (_t?: unknown, callback?: unknown) => ok(typeof _t === "function" ? _t : callback),
      disable: (_t?: unknown, callback?: unknown) => ok(typeof _t === "function" ? _t : callback),
      isEnabled: (_t?: unknown, callback?: unknown) => ok(typeof _t === "function" ? _t : callback, () => true),
      show: (_t?: unknown, callback?: unknown) => ok(callback),
      hide: (_t?: unknown, callback?: unknown) => ok(callback),
      openPopup: (_o?: unknown, callback?: unknown) =>
        ok(typeof _o === "function" ? _o : callback, () => {
          this.callbacks.openExtensionPage?.(ext.id, "popup")
          return undefined
        }),
      getUserSettings: (callback?: unknown) => ok(callback, () => ({ isOnToolbar: true })),
      onClicked: named(`${prefix}.onClicked`),
    })

    // ---- alarms
    const alarmMap = () => {
      let m = this.alarms.get(ext.id)
      if (!m) this.alarms.set(ext.id, (m = new Map()))
      return m
    }
    const app = this.appWindow ?? window
    const alarms = {
      create: (...args: unknown[]) => {
        const name = typeof args[0] === "string" ? (args.shift() as string) : ""
        const info = (args[0] ?? {}) as { when?: number; delayInMinutes?: number; periodInMinutes?: number }
        const map = alarmMap()
        const old = map.get(name)
        if (old) clearTimeout(old.timer)
        const first = info.when ? Math.max(0, info.when - Date.now()) : (info.delayInMinutes ?? info.periodInMinutes ?? 1) * 60000
        const period = info.periodInMinutes ? info.periodInMinutes * 60000 : 0
        const entry = { timer: 0, info: { name, scheduledTime: Date.now() + first, periodInMinutes: info.periodInMinutes } }
        const fire = () => {
          this.fireNamed(ext.id, "alarms.onAlarm", (w) => [this.toRealm(w, entry.info)])
          if (period) {
            entry.info.scheduledTime = Date.now() + period
            entry.timer = app.setTimeout(fire, period)
          } else map.delete(name)
        }
        entry.timer = app.setTimeout(fire, Math.max(first, 1000))
        map.set(name, entry)
        return ok(lastArgFn(args))
      },
      get: (...args: unknown[]) => {
        const name = typeof args[0] === "string" ? (args[0] as string) : ""
        return ok(lastArgFn(args), () => alarmMap().get(name)?.info)
      },
      getAll: (callback?: unknown) => ok(callback, () => [...alarmMap().values()].map((a) => a.info)),
      clear: (...args: unknown[]) => {
        const name = typeof args[0] === "string" ? (args[0] as string) : ""
        const a = alarmMap().get(name)
        if (a) clearTimeout(a.timer)
        alarmMap().delete(name)
        return ok(lastArgFn(args), () => Boolean(a))
      },
      clearAll: (callback?: unknown) => {
        alarmMap().forEach((a) => clearTimeout(a.timer))
        alarmMap().clear()
        return ok(callback, () => true)
      },
      onAlarm: named("alarms.onAlarm"),
    }

    // ---- notifications
    let notificationSeq = 0
    const notifications = {
      create: (...args: unknown[]) => {
        const callback = lastArgFn(args)
        const id = typeof args[0] === "string" ? (args.shift() as string) : `devon-${++notificationSeq}`
        const opts = (args[0] ?? {}) as { title?: string; message?: string }
        this.callbacks.notify(String(opts.title || ext.name), String(opts.message || ""), () =>
          this.fireNamed(ext.id, "notifications.onClicked", () => [id]),
        )
        return ok(callback, () => id)
      },
      update: (_id: string, _o: unknown, callback?: unknown) => ok(callback, () => true),
      clear: (_id: string, callback?: unknown) => ok(callback, () => true),
      getAll: (callback?: unknown) => ok(callback, () => ({})),
      getPermissionLevel: (callback?: unknown) => ok(callback, () => "granted"),
      onClicked: named("notifications.onClicked"),
      onClosed: named("notifications.onClosed"),
      onButtonClicked: named("notifications.onButtonClicked"),
    }

    // ---- context menus (accepted, not shown)
    let menuSeq = 0
    const contextMenus = {
      create: (props: { id?: string } = {}, callback?: unknown) => {
        if (typeof callback === "function") win.setTimeout(() => (callback as AnyFn)(), 0)
        return props.id ?? ++menuSeq
      },
      update: (_id: unknown, _p: unknown, callback?: unknown) => ok(callback),
      remove: (_id: unknown, callback?: unknown) => ok(callback),
      removeAll: (callback?: unknown) => ok(callback),
      onClicked: named("contextMenus.onClicked"),
    }

    const manifest = this.manifests.get(ext.id) ?? {}
    const windowObj = { id: 1, focused: true, top: 0, left: 0, width: 1280, height: 800, incognito: false, type: "normal", state: "normal", alwaysOnTop: false }
    const noopEvent = () => named(`noop.${Math.random()}`)

    const api = {
      runtime: {
        id: ext.id,
        lastError: undefined,
        getURL,
        getManifest: () =>
          toPage(
            Object.keys(manifest).length
              ? manifest
              : { name: ext.name, version: ext.version, description: ext.description, manifest_version: ext.manifestVersion },
          ),
        sendMessage,
        connect,
        onMessage: typedEvent("message"),
        onConnect: typedEvent("connect"),
        onMessageExternal: noopEvent(),
        onConnectExternal: noopEvent(),
        onInstalled: named("runtime.onInstalled"),
        onStartup: named("runtime.onStartup"),
        onSuspend: noopEvent(),
        onUpdateAvailable: noopEvent(),
        getPlatformInfo: (callback?: unknown) => ok(callback, () => ({ os: "win", arch: "x86-64", nacl_arch: "x86-64" })),
        getBackgroundPage: (callback?: unknown) => {
          const bgWin = this.backgrounds.get(ext.id)?.frame.contentWindow ?? null
          if (typeof callback === "function") {
            win.setTimeout(() => (callback as AnyFn)(bgWin), 0)
            return undefined
          }
          return P.resolve(bgWin)
        },
        openOptionsPage: (callback?: unknown) =>
          ok(callback, () => {
            this.callbacks.openExtensionPage?.(ext.id, "options")
            return undefined
          }),
        setUninstallURL: (_u: string, callback?: unknown) => ok(callback),
        reload: () => {
          this.stopBackground(ext.id)
          void this.syncBackgrounds()
        },
        requestUpdateCheck: (callback?: unknown) => ok(callback, () => ({ status: "no_update" })),
        getContexts: (_f: unknown, callback?: unknown) => ok(callback, () => []),
        sendNativeMessage: () => P.reject(new Error("Native messaging isn't available in Devon")),
        connectNative: () => {
          throw new Error("Native messaging isn't available in Devon")
        },
      },
      storage: {
        local: area("local"),
        sync: area("sync"),
        session: area("session"),
        managed: area("session"),
        onChanged: this.event(ext.id, win, "storage"),
      },
      i18n: {
        getMessage: (name: string, subs?: unknown) =>
          name === "@@extension_id" ? ext.id : name === "@@ui_locale" ? navigator.language.replace("-", "_") : localizeMessage(ext.messages, String(name), subs),
        getUILanguage: () => navigator.language,
        getAcceptLanguages: (callback?: unknown) => this.respond(win, callback, () => toPage([...navigator.languages])),
        detectLanguage: (_text: string, callback?: unknown) =>
          this.respond(win, callback, () => toPage({ isReliable: false, languages: [] })),
      },
      extension: {
        getURL,
        inIncognitoContext: false,
        sendMessage,
        getBackgroundPage: () => this.backgrounds.get(ext.id)?.frame.contentWindow ?? null,
        getViews: (filter?: { type?: string }) =>
          this.contexts
            .filter((c) => c.extId === ext.id && c.kind !== "content" && alive(c.win))
            .filter((c) => !filter?.type || (filter.type === "popup" ? c.kind === "popup" : filter.type === "tab" ? c.kind === "options" : true))
            .map((c) => c.win),
        isAllowedIncognitoAccess: (callback?: unknown) => ok(callback, () => false),
        isAllowedFileSchemeAccess: (callback?: unknown) => ok(callback, () => false),
      },
    } as Record<string, Json>

    if (isPage) {
      Object.assign(api, {
        tabs,
        scripting,
        action: actionApi("action"),
        browserAction: actionApi("browserAction"),
        pageAction: actionApi("pageAction"),
        alarms,
        notifications,
        contextMenus,
        menus: contextMenus,
        permissions: {
          contains: (_p: unknown, callback?: unknown) => ok(callback, () => true),
          request: (_p: unknown, callback?: unknown) => ok(callback, () => true),
          remove: (_p: unknown, callback?: unknown) => ok(callback, () => true),
          getAll: (callback?: unknown) =>
            ok(callback, () => ({ permissions: manifest.permissions ?? [], origins: manifest.host_permissions ?? [] })),
          onAdded: noopEvent(),
          onRemoved: noopEvent(),
        },
        windows: {
          WINDOW_ID_CURRENT: -2,
          WINDOW_ID_NONE: -1,
          get: (_id: unknown, ...rest: unknown[]) => ok(lastArgFn(rest), () => windowObj),
          getCurrent: (...args: unknown[]) => ok(lastArgFn(args), () => windowObj),
          getLastFocused: (...args: unknown[]) => ok(lastArgFn(args), () => windowObj),
          getAll: (...args: unknown[]) => ok(lastArgFn(args), () => [windowObj]),
          create: (data: { url?: string | string[] } = {}, callback?: unknown) =>
            ok(callback, () => {
              for (const u of Array.isArray(data.url) ? data.url : data.url ? [data.url] : []) {
                if (/^https?:/i.test(u)) this.callbacks.openTab(u)
              }
              return windowObj
            }),
          update: (_id: unknown, _i: unknown, callback?: unknown) => ok(callback, () => windowObj),
          remove: (_id: unknown, callback?: unknown) => ok(callback),
          onFocusChanged: noopEvent(),
          onCreated: noopEvent(),
          onRemoved: noopEvent(),
        },
        commands: { getAll: (callback?: unknown) => ok(callback, () => []), onCommand: named("commands.onCommand") },
        downloads: {
          download: (opts: { url: string; filename?: string }, callback?: unknown) =>
            ok(callback, () => {
              const target = /^https?:/i.test(opts.url)
                ? `/api/proxy?url=${encodeURIComponent(opts.url)}&raw=1&download=${encodeURIComponent(opts.filename ?? "")}`
                : opts.url
              const a = (this.appWindow ?? window).document.createElement("a")
              a.href = target
              a.download = opts.filename ?? ""
              a.click()
              return 1
            }),
          onChanged: noopEvent(),
        },
        webNavigation: {
          onCommitted: noopEvent(),
          onCompleted: noopEvent(),
          onBeforeNavigate: noopEvent(),
          onDOMContentLoaded: noopEvent(),
          onHistoryStateUpdated: noopEvent(),
          getAllFrames: (_d: unknown, callback?: unknown) => ok(callback, () => [{ frameId: 0, parentFrameId: -1 }]),
        },
        webRequest: {
          onBeforeRequest: noopEvent(),
          onBeforeSendHeaders: noopEvent(),
          onHeadersReceived: noopEvent(),
          onCompleted: noopEvent(),
          onErrorOccurred: noopEvent(),
        },
        sidePanel: {
          open: (_o: unknown, callback?: unknown) => ok(callback),
          setOptions: (_o: unknown, callback?: unknown) => ok(callback),
          setPanelBehavior: (_o: unknown, callback?: unknown) => ok(callback),
        },
        offscreen: {
          createDocument: (_o: unknown, callback?: unknown) => ok(callback),
          closeDocument: (callback?: unknown) => ok(callback),
          hasDocument: (callback?: unknown) => ok(callback, () => false),
        },
        identity: {
          getRedirectURL: (p = "") => `https://${ext.id}.chromiumapp.org/${p}`,
          launchWebAuthFlow: () => P.reject(new Error("Sign-in flows aren't available in Devon")),
        },
      })
    }

    // Per-area onChanged listeners also hear about changes to that area
    for (const name of ["local", "sync", "session"] as const) {
      const areaEvent = api.storage[name].onChanged
      const add = areaEvent.addListener
      areaEvent.addListener = (fn: AnyFn) => {
        add(fn)
        this.listeners.push({
          extId: ext.id,
          kind: "storage",
          win,
          fn: (changes: unknown, areaName: string) => {
            if (areaName === name && areaEvent.hasListener(fn)) fn(changes)
          },
        })
      }
    }
    return api
  }

  // ---- Userscripts --------------------------------------------------------

  private runUserscript(loaded: LoadedExtension, script: Userscript, win: Window, url: string, isTop: boolean): boolean {
    if (!isTop && script.meta.noframes) return false
    if (!matchesUserscript(script.meta, url)) return false

    const gm = this.gmApi(loaded, script, win, url)
    const names = Object.keys(gm)
    const code = [...script.requires.map((r) => `${r.code}\n;`), script.code].join("\n")
    const runner = this.compile(win, script, `${script.meta.name}.user.js`, names, code)
    if (!runner) return false
    this.schedule(win, script.meta.runAt, () => runner(names.map((n) => gm[n])))
    return true
  }

  private gmApi(loaded: LoadedExtension, script: Userscript, win: Window, pageUrl: string): Record<string, unknown> {
    const P = (win as unknown as { Promise: PromiseConstructor }).Promise
    const values = () => readData(script.id).values ?? {}
    const saveValues = (v: Record<string, Json>) => {
      const data = readData(script.id)
      data.values = v
      writeData(script.id, data)
    }

    const getValue = (key: string, def?: Json) => {
      const all = values()
      return key in all ? clone(all[key]) : def
    }
    const setValue = (key: string, value: Json) => {
      const all = values()
      const old = all[key]
      all[key] = clone(value)
      saveValues(all)
      this.fire(script.id, "gm", (w) => [key, old, all[key], w !== win])
    }
    const deleteValue = (key: string) => {
      const all = values()
      const old = all[key]
      delete all[key]
      saveValues(all)
      this.fire(script.id, "gm", (w) => [key, old, undefined, w !== win])
    }
    const listValues = () => Object.keys(values())

    const valueListeners = new Map<number, Listener>()
    let listenerSeq = 0
    const addValueChangeListener = (key: string, fn: AnyFn) => {
      const listener: Listener = {
        extId: script.id,
        kind: "gm",
        win,
        fn: (name: string, oldValue: Json, newValue: Json, remote: boolean) => {
          if (name === key) fn(name, oldValue, newValue, remote)
        },
      }
      this.listeners.push(listener)
      valueListeners.set(++listenerSeq, listener)
      return listenerSeq
    }
    const removeValueChangeListener = (id: number) => {
      const listener = valueListeners.get(id)
      this.listeners = this.listeners.filter((l) => l !== listener)
      valueListeners.delete(id)
    }

    const addStyle = (css: string) => this.addStyle(win, String(css))
    const addElement = (...args: unknown[]) => {
      const doc = win.document
      let parent: Node | null = null
      if (typeof args[0] !== "string") parent = args.shift() as Node
      const [tag, attrs] = args as [string, Record<string, string> | undefined]
      const el = doc.createElement(tag)
      for (const [k, v] of Object.entries(attrs ?? {})) {
        if (k === "textContent") el.textContent = v
        else el.setAttribute(k, v)
      }
      ;(parent ?? (["script", "style", "link", "meta"].includes(tag) ? doc.head : doc.body) ?? doc.documentElement).appendChild(el)
      return el
    }

    const getResourceText = (name: string) => loaded.texts.get(`@resource/${name}`) ?? null
    const getResourceURL = (name: string) => this.fileUrl(loaded, `@resource/${name}`)

    const openInTab = (url: string) => {
      try {
        this.callbacks.openTab(new URL(url, pageUrl).href)
      } catch {
        // bad URL
      }
      return { close: () => {}, closed: false, onclose: null }
    }

    const setClipboard = (data: string) => {
      const text = String(data)
      navigator.clipboard?.writeText(text).catch(() => {
        const doc = win.document
        const ta = doc.createElement("textarea")
        ta.value = text
        doc.body.appendChild(ta)
        ta.select()
        doc.execCommand("copy")
        ta.remove()
      })
    }

    const notification = (details: unknown, title?: string, _image?: string, onclick?: AnyFn) => {
      const d =
        typeof details === "object" && details
          ? (details as { text?: string; title?: string; onclick?: AnyFn })
          : { text: String(details), title, onclick }
      this.callbacks.notify(d.title || script.name, d.text || "", d.onclick ? () => d.onclick!() : undefined)
    }

    let commandSeq = 0
    const registerMenuCommand = (caption: string, fn: AnyFn, options?: unknown) => {
      const id =
        options && typeof options === "object" && "id" in options ? String((options as { id: unknown }).id) : String(++commandSeq)
      this.commands = this.commands.filter((c) => !(c.win === win && c.extensionId === script.id && c.id === id))
      this.commands.push({
        key: `${script.id}:${id}:${Math.random()}`,
        id,
        win,
        extensionId: script.id,
        extensionName: script.name,
        caption: String(caption),
        run: () => {
          try {
            fn()
          } catch (error) {
            win.console.error(`[${script.name}]`, error)
          }
        },
      })
      return id
    }
    const unregisterMenuCommand = (id: string | number) => {
      this.commands = this.commands.filter((c) => !(c.win === win && c.extensionId === script.id && c.id === String(id)))
    }

    const xmlhttpRequest = (details: Record<string, Json>) => {
      const controller = new AbortController()
      let target: string
      try {
        target = new URL(String(details.url), pageUrl).href
      } catch {
        target = String(details.url)
      }
      const call = (name: string, arg?: unknown) => {
        const fn = details[name]
        if (typeof fn === "function") {
          try {
            fn.call(details, arg)
          } catch (error) {
            win.console.error(error)
          }
        }
      }
      const base = { finalUrl: target, readyState: 0, status: 0, statusText: "", responseHeaders: "", context: details.context }
      let timer: number | undefined
      if (details.timeout) {
        timer = window.setTimeout(() => {
          controller.abort()
          call("ontimeout", { ...base, readyState: 4 })
          call("onloadend", { ...base, readyState: 4 })
        }, Number(details.timeout))
      }
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries((details.headers as Record<string, string>) ?? {})) headers[k] = String(v)
      call("onloadstart", base)
      const method = String(details.method || "GET").toUpperCase()
      fetch(`/api/proxy?url=${encodeURIComponent(target)}&raw=1&ref=${encodeURIComponent(pageUrl)}`, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : (details.data as BodyInit),
        signal: controller.signal,
      })
        .then(async (res) => {
          const finalUrl = res.headers.get("x-proxy-final-url") || target
          const responseHeaders = [...res.headers.entries()]
            .filter(([k]) => k !== "x-proxy-final-url")
            .map(([k, v]) => `${k}: ${v}`)
            .join("\r\n")
          const type = String(details.responseType || "").toLowerCase()
          let responseText = ""
          let response: unknown
          if (type === "arraybuffer") response = await res.arrayBuffer()
          else if (type === "blob") response = await res.blob()
          else {
            responseText = await res.text()
            response = responseText
            if (type === "json") {
              try {
                response = (win as unknown as { JSON: JSON }).JSON.parse(responseText)
              } catch {
                response = undefined
              }
            } else if (type === "document") {
              response = new (win as unknown as { DOMParser: typeof DOMParser }).DOMParser().parseFromString(
                responseText,
                (res.headers.get("content-type") || "text/html").split(";")[0] as DOMParserSupportedType,
              )
            }
          }
          if (timer) window.clearTimeout(timer)
          const result = {
            ...base,
            finalUrl,
            readyState: 4,
            status: res.status,
            statusText: res.statusText,
            responseHeaders,
            response,
            responseText,
            responseXML: type === "document" ? response : null,
          }
          call("onreadystatechange", result)
          call("onprogress", { ...result, loaded: responseText.length, total: responseText.length, lengthComputable: true })
          call("onload", result)
          call("onloadend", result)
        })
        .catch((error: unknown) => {
          if (timer) window.clearTimeout(timer)
          const aborted = error instanceof DOMException && error.name === "AbortError"
          if (aborted && details.timeout) return // reported as a timeout
          const result = { ...base, readyState: 4, error: String(error) }
          call(aborted ? "onabort" : "onerror", result)
          call("onloadend", result)
        })
      return { abort: () => controller.abort() }
    }

    const xmlHttpRequestPromise = (details: Record<string, Json>) => {
      let handle: { abort: () => void } | undefined
      const promise = new P((resolve, reject) => {
        handle = xmlhttpRequest({
          ...details,
          onload: (r: unknown) => {
            details.onload?.(r)
            resolve(r)
          },
          onerror: (r: unknown) => {
            details.onerror?.(r)
            reject(r)
          },
          ontimeout: (r: unknown) => {
            details.ontimeout?.(r)
            reject(r)
          },
          onabort: (r: unknown) => {
            details.onabort?.(r)
            reject(r)
          },
        })
      }) as Promise<unknown> & { abort?: () => void }
      promise.abort = () => handle?.abort()
      return promise
    }

    const download = (details: unknown, name?: string) => {
      const d = typeof details === "object" && details ? (details as { url: string; name?: string }) : { url: String(details), name }
      fetch(`/api/proxy?url=${encodeURIComponent(new URL(d.url, pageUrl).href)}&raw=1`)
        .then((r) => r.blob())
        .then((blob) => {
          const a = document.createElement("a")
          a.href = URL.createObjectURL(blob)
          a.download = d.name || d.url.split("/").pop() || "download"
          a.click()
          setTimeout(() => URL.revokeObjectURL(a.href), 30000)
        })
        .catch((e) => win.console.error(e))
    }

    const info = {
      script: {
        name: script.meta.name,
        namespace: script.meta.namespace,
        version: script.meta.version,
        description: script.meta.description,
        author: script.meta.author,
        matches: script.meta.match,
        includes: script.meta.include,
        excludes: script.meta.exclude,
        grant: script.meta.grant,
        "run-at": script.meta.runAt.replace("_", "-"),
        resources: script.meta.resource,
        homepage: script.meta.homepage,
      },
      scriptMetaStr: /\/\/\s*==UserScript==[\s\S]*?\/\/\s*==\/UserScript==/.exec(script.code)?.[0] ?? "",
      scriptHandler: HANDLER_NAME,
      version: HANDLER_VERSION,
      isIncognito: false,
    }

    const later = <T>(fn: () => T) => new P<T>((resolve, reject) => {
      try {
        resolve(fn())
      } catch (error) {
        reject(error)
      }
    })

    const GM = {
      info,
      getValue: (k: string, d?: Json) => later(() => getValue(k, d)),
      setValue: (k: string, v: Json) => later(() => setValue(k, v)),
      deleteValue: (k: string) => later(() => deleteValue(k)),
      listValues: () => later(listValues),
      getValues: (keys: string[]) => later(() => Object.fromEntries(keys.map((k) => [k, getValue(k)]))),
      setValues: (obj: Record<string, Json>) => later(() => Object.entries(obj).forEach(([k, v]) => setValue(k, v))),
      deleteValues: (keys: string[]) => later(() => keys.forEach(deleteValue)),
      addValueChangeListener: (k: string, fn: AnyFn) => later(() => addValueChangeListener(k, fn)),
      removeValueChangeListener: (id: number) => later(() => removeValueChangeListener(id)),
      getResourceUrl: (n: string) => later(() => getResourceURL(n)),
      getResourceURL: (n: string) => later(() => getResourceURL(n)),
      getResourceText: (n: string) => later(() => getResourceText(n)),
      xmlHttpRequest: xmlHttpRequestPromise,
      openInTab: (u: string) => later(() => openInTab(u)),
      setClipboard: (t: string) => later(() => setClipboard(t)),
      notification: (d: unknown, t?: string, i?: string, c?: AnyFn) => later(() => notification(d, t, i, c)),
      addStyle: (css: string) => later(() => addStyle(css)),
      addElement: (...args: unknown[]) => later(() => addElement(...args)),
      registerMenuCommand: (c: string, fn: AnyFn, o?: unknown) => later(() => registerMenuCommand(c, fn, o)),
      unregisterMenuCommand: (id: string) => later(() => unregisterMenuCommand(id)),
      download: (d: unknown, n?: string) => later(() => download(d, n)),
      log: (...args: unknown[]) => later(() => win.console.log(...args)),
    }

    return {
      unsafeWindow: win,
      GM,
      GM_info: info,
      GM_getValue: getValue,
      GM_setValue: setValue,
      GM_deleteValue: deleteValue,
      GM_listValues: listValues,
      GM_addValueChangeListener: addValueChangeListener,
      GM_removeValueChangeListener: removeValueChangeListener,
      GM_addStyle: addStyle,
      GM_addElement: addElement,
      GM_getResourceText: getResourceText,
      GM_getResourceURL: getResourceURL,
      GM_xmlhttpRequest: xmlhttpRequest,
      GM_openInTab: openInTab,
      GM_setClipboard: setClipboard,
      GM_notification: notification,
      GM_registerMenuCommand: registerMenuCommand,
      GM_unregisterMenuCommand: unregisterMenuCommand,
      GM_download: download,
      GM_log: (...args: unknown[]) => win.console.log(...args),
      GM_getTab: (cb: AnyFn) => win.setTimeout(() => cb({}), 0),
      GM_saveTab: () => {},
      GM_getTabs: (cb: AnyFn) => win.setTimeout(() => cb({}), 0),
    }
  }
}
