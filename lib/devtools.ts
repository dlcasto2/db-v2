/**
 * Developer tools for proxied pages, powered by Eruda (https://github.com/liriliri/eruda).
 *
 * Eruda has to run inside the page's own window to see its console, DOM,
 * network requests and storage. Proxied pages are same-origin with the app,
 * so the app evaluates Eruda's browser build (served from /vendor/eruda.js,
 * copied there by scripts/copy-vendor.mjs) directly in the page's realm.
 *
 * When dev tools are on, this happens at document_start (from the proxy's
 * __devonExtHost hook), before the page's own scripts, so early console
 * output and requests are captured too.
 */

const ERUDA_SRC = "/vendor/eruda.js"
const PREF_KEY = "devon-devtools"

interface Eruda {
  init(options?: Record<string, unknown>): void
  destroy(): void
  show(name?: string): void
  hide(): void
  position(p: { x: number; y: number }): void
  _isInit?: boolean
  _devTools?: { toggle?: () => void; _isShow?: boolean }
}

type DevtoolsWindow = Window & { eruda?: Eruda; __devonErudaReady?: boolean; eval: (code: string) => unknown }

let source: string | null = null
let loading: Promise<string | null> | null = null

/** Fetches Eruda's source once; resolves null if it couldn't be loaded */
export function loadDevtoolsSource(): Promise<string | null> {
  if (source) return Promise.resolve(source)
  if (!loading) {
    loading = fetch(ERUDA_SRC)
      .then((res) => (res.ok ? res.text() : null))
      .then((text) => (source = text))
      .catch(() => null)
      .finally(() => {
        if (!source) loading = null // allow a retry later
      })
  }
  return loading
}

export function readDevtoolsPref(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === "1"
  } catch {
    return false
  }
}

export function writeDevtoolsPref(on: boolean) {
  try {
    localStorage.setItem(PREF_KEY, on ? "1" : "0")
  } catch {
    // not persisted
  }
}

function initIn(win: DevtoolsWindow) {
  const eruda = win.eruda
  if (!eruda || win.__devonErudaReady) return
  eruda.init({
    useShadowDom: true,
    autoScale: true,
    defaults: { theme: "Dark", displaySize: 45, transparency: 1 },
  })
  win.__devonErudaReady = true
}

/**
 * Loads and starts Eruda in a page window. Synchronous when the source is
 * already cached (the document_start path); otherwise loads it first.
 * Returns true if Eruda is running in the window afterwards.
 */
export function injectDevtools(win: Window | null | undefined): boolean {
  const w = win as DevtoolsWindow | null | undefined
  if (!w) return false
  try {
    if (w.__devonErudaReady) return true
    if (!w.eruda) {
      if (!source) {
        loadDevtoolsSource().then(() => injectDevtools(w))
        return false
      }
      // Indirect eval: runs as a global script in the page's realm
      ;(0, w.eval)(`${source}\n//# sourceURL=devon-eruda.js`)
    }
    const start = () => {
      try {
        initIn(w)
      } catch (error) {
        console.error("[Devon] Eruda failed to start:", error)
      }
    }
    // Eruda mounts under <html>, which exists even at document_start
    if (w.document.documentElement) start()
    else w.addEventListener("DOMContentLoaded", start, { once: true })
    return true
  } catch (error) {
    // The page's CSP can forbid eval; fall back to a script tag
    try {
      const doc = w.document
      if (doc.querySelector("script[data-devon-eruda]")) return false
      const script = doc.createElement("script")
      script.src = ERUDA_SRC
      script.setAttribute("data-devon-eruda", "")
      script.onload = () => initIn(w)
      ;(doc.head || doc.documentElement).appendChild(script)
    } catch {
      console.error("[Devon] Could not load dev tools into this page:", error)
    }
    return false
  }
}

export function removeDevtools(win: Window | null | undefined) {
  const w = win as DevtoolsWindow | null | undefined
  try {
    if (w?.eruda && w.__devonErudaReady) {
      w.eruda.destroy()
      w.__devonErudaReady = false
    }
  } catch {
    // page gone
  }
}

/** Opens or closes the Eruda panel in a page window */
export function toggleDevtoolsPanel(win: Window | null | undefined) {
  const w = win as DevtoolsWindow | null | undefined
  if (!w) return
  try {
    if (!w.__devonErudaReady) {
      if (injectDevtools(w)) w.eruda?.show()
      else loadDevtoolsSource().then(() => injectDevtools(w) && w.eruda?.show())
      return
    }
    const devTools = w.eruda?._devTools
    if (devTools?.toggle) devTools.toggle()
    else if (devTools?._isShow) w.eruda?.hide()
    else w.eruda?.show()
  } catch {
    // page gone
  }
}
