"use client"

import type React from "react"

import { useState, useEffect, useRef, useCallback } from "react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Switch } from "@/components/ui/switch"
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Clock,
  Download,
  EllipsisVertical,
  FlaskConical,
  Gamepad2,
  Home,
  Library,
  Loader2,
  Lock,
  LockOpen,
  Plus,
  Puzzle,
  SquareTerminal,
  RotateCw,
  Search,
  ShieldAlert,
  Star,
  Trash2,
  TvMinimalPlay,
  WifiOff,
  X,
} from "lucide-react"
import { fetchThroughProxy, formatUrl } from "@/lib/proxy-utils"
import { SessionManager, type BookmarkItem, type HistoryItem } from "@/lib/session-manager"
import { LibraryPanel, type LibraryView } from "@/components/library-panel"
import { NewTabPage } from "@/components/new-tab-page"
import { GamesPage } from "@/components/games-page"
import { GAMES, GAMES_URL, parseGamesUrl } from "@/lib/games"
import { YouTubePage } from "@/components/youtube-page"
import { YOUTUBE_ICON, YOUTUBE_URL, parseYouTubeUrl, videoIdFromUrl, youTubePageUrl } from "@/lib/youtube"
import { Favicon } from "@/components/favicon"
import { cn } from "@/lib/utils"
import { SavePageDialog, type SaveTarget } from "@/components/save-page-dialog"
import { saveBlob } from "@/lib/page-archiver"
import { MediaDownloads, mediaItemForTab } from "@/components/media-downloads"
import { type MediaItem, findMedia } from "@/lib/media"
import { OPEN_REPORT_EVENT, PageProblems } from "@/components/page-problems"
import type { PageActivity, PageError } from "@/lib/diagnostics"
import { ExtensionsDialog, installFromLink } from "@/components/extensions-dialog"
import { ExtensionOptions, ExtensionPopup } from "@/components/extension-page"
import { SuggestionList } from "@/components/suggestion-list"
import { type Suggestion, useSuggestionKeys, useSuggestions } from "@/lib/suggestions"
import { Toaster } from "@/components/ui/sonner"
import { toast } from "sonner"
import { ExtensionHost, type MenuCommand } from "@/lib/extensions/runtime"
import { type Extension, loadExtensions } from "@/lib/extensions/store"
import {
  injectDevtools,
  loadDevtoolsSource,
  readDevtoolsPref,
  removeDevtools,
  toggleDevtoolsPanel,
  writeDevtoolsPref,
} from "@/lib/devtools"

interface Tab {
  id: string
  title: string
  url: string
  isActive: boolean
  isLoading?: boolean
  favicon?: string
  /** Rewritten HTML, written into a same-origin frame (see ProxiedFrame) */
  content?: string
  /** Changes on every successful load, so each page gets a fresh frame */
  loadId?: string
  /** Object URL for non-HTML responses (images, PDFs, text) */
  frameSrc?: string
  frameType?: string
  error?: string
  errorDetails?: string
  history: string[]
  historyIndex: number
  isSecure?: boolean
  /** The frame navigated somewhere the proxy couldn't intercept */
  leftProxy?: boolean
}

/**
 * "push" = new entry, "replace" = new URL in the current entry (location.replace),
 * "reload" = same page again, { index } = back/forward
 */
type HistoryMode = "push" | "replace" | "reload" | { index: number }

interface NavRequest {
  method?: "GET" | "POST"
  body?: string
}

const STOPPED_MESSAGE = "Page loading was stopped."

/** Cookie read by the proxy route; turns on experimental reCAPTCHA support (and site cookies) */
const EXPERIMENTAL_COOKIE = "devon_recaptcha"

function readExperimentalCookie(): boolean {
  if (typeof document === "undefined") return false
  return document.cookie.split(";").some((part) => part.trim() === `${EXPERIMENTAL_COOKIE}=1`)
}

function writeExperimentalCookie(on: boolean) {
  document.cookie = on
    ? `${EXPERIMENTAL_COOKIE}=1; Path=/; Max-Age=31536000; SameSite=Lax`
    : `${EXPERIMENTAL_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
}

const makeId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

const blankTab = (isActive = true): Tab => ({
  id: makeId(),
  title: "New Tab",
  url: "",
  isActive,
  history: [],
  historyIndex: -1,
})

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return "Unknown"
  }
}

/** Only what's worth persisting — page content can blow past the localStorage quota */
function persistableTabs(tabs: Tab[]) {
  return tabs.map(({ id, title, url, isActive, favicon, history, historyIndex, isSecure }) => ({
    id,
    title,
    url,
    isActive,
    favicon,
    history,
    historyIndex,
    isSecure,
  }))
}

/** Reload the current history entry, or push if the URL never made it into history (failed load) */
function reloadMode(tab: Tab): HistoryMode {
  return tab.history[tab.historyIndex] === tab.url ? "reload" : "push"
}

/** Frames whose page has been written (later loads mean the frame navigated away) */
const writtenFrames = new WeakSet<HTMLIFrameElement>()

/**
 * Renders proxied HTML by loading a blank same-origin page and then writing the
 * HTML into it with document.open/write, instead of using srcdoc. The written
 * document takes an http(s) URL on the app's origin (a srcdoc document is stuck
 * at "about:srcdoc"), which lets the injected script rewrite it with
 * history.replaceState so location.pathname, search and hash match the real page.
 *
 * The blank page must be a real navigation, not the frame's initial about:blank:
 * Chrome treats history entries pushed on a written initial about:blank as
 * cross-document, so the page's own back/forward would reload the frame.
 *
 * Each page needs a fresh frame (use a changing key): document.open() keeps
 * the previous page's window and globals.
 */
function ProxiedFrame({
  html,
  title,
  frameRef,
  onLoad,
}: {
  html: string
  title: string
  frameRef: React.MutableRefObject<HTMLIFrameElement | null>
  onLoad: (event: React.SyntheticEvent<HTMLIFrameElement>) => void
}) {
  const handleLoad = (event: React.SyntheticEvent<HTMLIFrameElement>) => {
    const frame = event.currentTarget
    if (writtenFrames.has(frame)) {
      onLoad(event)
      return
    }
    let doc: Document | null = null
    try {
      doc = frame.contentDocument
    } catch {
      doc = null
    }
    // Only write into our own blank page (not the initial about:blank)
    if (!doc || !doc.location.pathname.endsWith("/devon-frame.html")) return
    writtenFrames.add(frame)
    frameRef.current = frame
    // Leave the load event before replacing the document
    setTimeout(() => {
      doc.open()
      doc.write(html)
      doc.close()
    }, 0)
  }

  return (
    <iframe
      ref={(el) => {
        if (el) frameRef.current = el
      }}
      src="/devon-frame.html"
      data-devon-page=""
      onLoad={handleLoad}
      className="w-full flex-1 min-h-0 border-0 bg-white"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
      title={title}
    />
  )
}

export function ProxyBrowser() {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [currentUrl, setCurrentUrl] = useState("")
  const [libraryView, setLibraryView] = useState<LibraryView | null>(null)
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>([])
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [addressFocused, setAddressFocused] = useState(false)
  /** The user has typed in the address bar since focusing it (so show suggestions) */
  const [addressTyped, setAddressTyped] = useState(false)
  const [showSave, setShowSave] = useState(false)
  const [devtoolsOn, setDevtoolsOn] = useState(false)
  /** Script errors reported by each tab's page, cleared on every navigation */
  const [pageErrors, setPageErrors] = useState<Record<string, PageError[]>>({})
  /** Video/player requests per tab, for the page report */
  const [pageActivity, setPageActivity] = useState<Record<string, PageActivity[]>>({})
  /** Tabs where the "YouTube blocks playback" notice was dismissed */
  const [ytNoticeDismissed, setYtNoticeDismissed] = useState<Record<string, boolean>>({})
  /** Chrome Web Store id being installed from the store page banner */
  const [storeInstalling, setStoreInstalling] = useState<string | null>(null)
  /** Extension popup / options page being shown */
  const [extPage, setExtPage] = useState<{ extId: string; kind: "popup" | "options" } | null>(null)
  /** Bumped when extension badges etc. change */
  const [, setExtTick] = useState(0)
  const [extensions, setExtensions] = useState<Extension[]>([])
  const [extensionsOpen, setExtensionsOpen] = useState(false)
  /** What the extensions menu shows, captured when it opens */
  const [extMenu, setExtMenu] = useState<{ running: Set<string>; commands: MenuCommand[] }>({
    running: new Set(),
    commands: [],
  })
  const [experimentalRecaptcha, setExperimentalRecaptcha] = useState(false)

  const controllersRef = useRef(new Map<string, AbortController>())
  const blobUrlsRef = useRef(new Map<string, string>())
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const addressBarRef = useRef<HTMLInputElement>(null)
  const activeTabIdRef = useRef<string | undefined>(undefined)
  const tabsRef = useRef<Tab[]>([])
  const extHostRef = useRef<ExtensionHost | null>(null)
  const devtoolsOnRef = useRef(false)
  /** Resolves once Eruda's source is cached (when dev tools are on), so it can start at document_start */
  const devtoolsReadyRef = useRef<Promise<unknown>>(Promise.resolve())
  /** Resolves once installed extensions are loaded, so the first pages get them too */
  const extReadyRef = useRef<Promise<void>>(Promise.resolve())
  const refreshExtensionsRef = useRef<(message?: string) => Promise<void>>(async () => {})

  const activeTab = tabs.find((tab) => tab.isActive)

  useEffect(() => {
    activeTabIdRef.current = activeTab?.id
    tabsRef.current = tabs
  }, [activeTab?.id, tabs])

  // Load session on mount
  useEffect(() => {
    const session = SessionManager.loadSession()
    setTabs(session.tabs)
    setBookmarks(session.bookmarks)
    setHistory(session.history)
    setExperimentalRecaptcha(readExperimentalCookie())
    if (readDevtoolsPref()) {
      devtoolsOnRef.current = true
      setDevtoolsOn(true)
      devtoolsReadyRef.current = loadDevtoolsSource()
    }
  }, [])

  // Extensions: the proxied pages call window.__devonExtHost at document_start
  useEffect(() => {
    const host = new ExtensionHost({ openTab: () => {}, notify: () => {} })
    extHostRef.current = host
    const detach = host.attach(window)
    // Dev tools start first at document_start, so they also see what extensions log
    const runExtensions = window.__devonExtHost
    window.__devonExtHost = (win, url, isTop) => {
      if (isTop && devtoolsOnRef.current) injectDevtools(win)
      runExtensions?.(win, url, isTop)
    }
    extReadyRef.current = loadExtensions()
      .then((loaded) => {
        host.setExtensions(loaded)
        setExtensions(loaded.map((l) => l.ext))
      })
      .catch((error) => console.error("Failed to load extensions:", error))
    return detach
  }, [])

  // Save session whenever tabs change
  useEffect(() => {
    if (tabs.length > 0) {
      SessionManager.saveSession({ tabs: persistableTabs(tabs) })
    }
  }, [tabs])

  // Keep the address bar in sync with the active tab (switching tabs, redirects, link clicks)
  useEffect(() => {
    setCurrentUrl(activeTab?.url ?? "")
  }, [activeTab?.id, activeTab?.url])

  // Revoke object URLs on unmount
  useEffect(() => {
    const blobUrls = blobUrlsRef.current
    const controllers = controllersRef.current
    return () => {
      controllers.forEach((c) => c.abort())
      blobUrls.forEach((u) => URL.revokeObjectURL(u))
    }
  }, [])

  const releaseBlob = useCallback((tabId: string) => {
    const url = blobUrlsRef.current.get(tabId)
    if (url) {
      URL.revokeObjectURL(url)
      blobUrlsRef.current.delete(tabId)
    }
  }, [])

  const cancelLoad = useCallback((tabId: string) => {
    controllersRef.current.get(tabId)?.abort()
    controllersRef.current.delete(tabId)
  }, [])

  const navigate = useCallback(
    async (tabId: string, input: string, historyMode: HistoryMode = "push", request: NavRequest = {}) => {
      const trimmed = input.trim()
      if (!trimmed) return

      // Devon's built-in pages: Games (devon://games, devon://games/<id>) and
      // YouTube (devon://youtube, devon://youtube?q=…, devon://youtube/watch?v=…)
      const gameId = parseGamesUrl(trimmed)
      // A real YouTube video link (youtube.com/watch, youtu.be, shorts, embed,
      // youtube-nocookie.com/embed…) opens in Devon's own player instead of
      // being proxied: YouTube's pages refuse proxies and school networks block
      // the direct embed, while Devon's player streams from the server.
      const ytVideoId = gameId === null && !/^devon:/i.test(trimmed) ? videoIdFromUrl(trimmed) : null
      const ytRoute =
        gameId === null ? parseYouTubeUrl(trimmed) ?? (ytVideoId ? { view: "watch" as const, id: ytVideoId } : null) : null
      if (gameId !== null || ytRoute) {
        controllersRef.current.get(tabId)?.abort()
        controllersRef.current.delete(tabId)
        releaseBlob(tabId)
        const game = GAMES.find((g) => g.id === gameId)
        let pageUrl = game ? `${GAMES_URL}/${game.id}` : GAMES_URL
        let title = game ? game.title : "Games"
        let favicon = game ? game.icon : "/icon.svg"
        if (ytRoute) {
          pageUrl = youTubePageUrl(ytRoute)
          title = ytRoute.view === "watch" ? "YouTube video" : ytRoute.q ? `${ytRoute.q} - YouTube` : "YouTube"
          favicon = YOUTUBE_ICON
        }
        setPageErrors((prev) => (prev[tabId]?.length ? { ...prev, [tabId]: [] } : prev))
        setPageActivity((prev) => (prev[tabId]?.length ? { ...prev, [tabId]: [] } : prev))
        setTabs((prev) =>
          prev.map((tab) => {
            if (tab.id !== tabId) return tab
            let history = tab.history
            let historyIndex = tab.historyIndex
            if (historyMode === "push") {
              history = [...tab.history.slice(0, tab.historyIndex + 1), pageUrl]
              historyIndex = history.length - 1
            } else if (typeof historyMode === "object") {
              historyIndex = historyMode.index
            }
            return {
              ...tab,
              url: pageUrl,
              title,
              favicon,
              content: undefined,
              frameSrc: undefined,
              frameType: undefined,
              leftProxy: undefined,
              isLoading: false,
              error: undefined,
              errorDetails: undefined,
              history,
              historyIndex,
              isSecure: true,
            }
          }),
        )
        if (historyMode === "push") {
          SessionManager.addToHistory({ title, url: pageUrl, favicon })
          setHistory(SessionManager.loadSession().history)
        }
        return
      }

      const formattedUrl = formatUrl(trimmed)
      setPageErrors((prev) => (prev[tabId]?.length ? { ...prev, [tabId]: [] } : prev))
      setPageActivity((prev) => (prev[tabId]?.length ? { ...prev, [tabId]: [] } : prev))

      // Userscript links (Greasy Fork "Install" buttons etc.) offer to install instead of opening
      if (historyMode === "push" && request.method !== "POST" && /\.user\.js(\?|#|$)/i.test(formattedUrl.split("#")[0])) {
        if (confirm(`Install the userscript from ${hostnameOf(formattedUrl)}?\n\n${formattedUrl}`)) {
          installFromLink(formattedUrl)
            .then((ext) => refreshExtensionsRef.current(`Installed ${ext.name}`))
            .catch((error) => toast.error(error instanceof Error ? error.message : String(error)))
          return
        }
      }

      // Cancel any load already running in this tab
      controllersRef.current.get(tabId)?.abort()
      const controller = new AbortController()
      controllersRef.current.set(tabId, controller)

      releaseBlob(tabId)
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                url: formattedUrl,
                isLoading: true,
                error: undefined,
                errorDetails: undefined,
                content: undefined,
                frameSrc: undefined,
                frameType: undefined,
                leftProxy: undefined,
              }
            : tab,
        ),
      )

      try {
        const result = await fetchThroughProxy(formattedUrl, { ...request, signal: controller.signal })
        await extReadyRef.current
        await devtoolsReadyRef.current

        // A newer navigation (or a closed tab) superseded this one
        if (controllersRef.current.get(tabId) !== controller) {
          if (result.frameSrc) URL.revokeObjectURL(result.frameSrc)
          return
        }
        controllersRef.current.delete(tabId)
        if (result.frameSrc) blobUrlsRef.current.set(tabId, result.frameSrc)

        const finalUrl = result.finalUrl

        // Updated by tab id, so a slow page can't land in whichever tab is active now
        setTabs((prev) =>
          prev.map((tab) => {
            if (tab.id !== tabId) return tab

            let history = tab.history
            let historyIndex = tab.historyIndex
            if (historyMode === "push") {
              history = [...tab.history.slice(0, tab.historyIndex + 1), finalUrl]
              historyIndex = history.length - 1
            } else if (typeof historyMode === "object") {
              historyIndex = historyMode.index
              history = [...tab.history]
              history[historyIndex] = finalUrl
            } else if (historyIndex >= 0) {
              history = [...tab.history]
              history[historyIndex] = finalUrl
            }

            return {
              ...tab,
              url: finalUrl,
              title: result.title,
              favicon: result.favicon,
              content: result.content,
              loadId: makeId(),
              frameSrc: result.frameSrc,
              frameType: result.contentType,
              isLoading: false,
              error: undefined,
              errorDetails: undefined,
              history,
              historyIndex,
              isSecure: finalUrl.startsWith("https://"),
            }
          }),
        )

        if (historyMode === "push" || historyMode === "replace") {
          SessionManager.addToHistory({ title: result.title, url: finalUrl, favicon: result.favicon })
          setHistory(SessionManager.loadSession().history)
        }
      } catch (error) {
        if (controllersRef.current.get(tabId) !== controller) return
        controllersRef.current.delete(tabId)

        const aborted = error instanceof Error && error.name === "AbortError"
        const errorMessage = aborted ? STOPPED_MESSAGE : error instanceof Error ? error.message : "Failed to load page"
        const errorDetails = !aborted && error instanceof Error && error.stack ? error.stack : ""

        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === tabId
              ? {
                  ...tab,
                  isLoading: false,
                  error: errorMessage,
                  errorDetails,
                  title: aborted ? hostnameOf(formattedUrl) : "Error - " + hostnameOf(formattedUrl),
                  isSecure: false,
                }
              : tab,
          ),
        )
      }
    },
    [releaseBlob],
  )

  /** Inserts a new tab after the active one, makes it active, returns its id */
  const createTab = useCallback(() => {
    const newTab = blankTab()
    setTabs((prev) => {
      const activeIndex = prev.findIndex((tab) => tab.isActive)
      const next = prev.map((tab) => ({ ...tab, isActive: false }))
      next.splice(activeIndex + 1, 0, newTab)
      return next
    })
    return newTab.id
  }, [])

  const addTab = () => {
    createTab()
    setTimeout(() => addressBarRef.current?.focus(), 0)
  }

  const openInNewTab = useCallback(
    (url: string, request: NavRequest = {}) => {
      const id = createTab()
      navigate(id, url, "push", request)
    },
    [createTab, navigate],
  )

  const closeTab = (tabId: string) => {
    if (tabs.length <= 1) return
    cancelLoad(tabId)
    releaseBlob(tabId)

    setTabs((prev) => {
      if (prev.length <= 1) return prev
      const index = prev.findIndex((tab) => tab.id === tabId)
      if (index === -1) return prev
      const wasActive = prev[index].isActive
      const next = prev.filter((tab) => tab.id !== tabId)
      if (!wasActive) return next
      const nextActive = Math.min(index, next.length - 1)
      return next.map((tab, i) => ({ ...tab, isActive: i === nextActive }))
    })
  }

  const switchTab = (tabId: string) => {
    setTabs((prev) => prev.map((tab) => ({ ...tab, isActive: tab.id === tabId })))
  }

  // Restored (or never-loaded) tabs have a URL but no content: load them when shown
  useEffect(() => {
    const tab = tabs.find((t) => t.isActive)
    if (tab && tab.url && tab.content === undefined && !tab.frameSrc && !tab.isLoading && !tab.error && parseGamesUrl(tab.url) === null && !parseYouTubeUrl(tab.url)) {
      navigate(tab.id, tab.url, reloadMode(tab))
    }
  }, [tabs, navigate])

  // Extension callbacks use current state, so they're refreshed after every render
  useEffect(() => {
    extHostRef.current?.setCallbacks({
      openTab: (url) => openInNewTab(url),
      notify: (title, text, onClick) =>
        toast(title, { description: text || undefined, action: onClick ? { label: "Open", onClick } : undefined }),
      getTabs: () =>
        tabsRef.current.map((t) => ({
          key: t.id,
          url: t.url,
          title: t.title,
          active: t.isActive,
          favIconUrl: t.favicon,
          win: t.isActive && t.content !== undefined ? (iframeRef.current?.contentWindow ?? null) : null,
        })),
      navigateTab: (key, url) => navigate(key, url, "push"),
      activateTab: (key) => switchTab(key),
      reloadTab: (key) => {
        const tab = tabsRef.current.find((t) => t.id === key)
        if (tab?.url) navigate(tab.id, tab.url, reloadMode(tab))
      },
      closeTab: (key) => closeTab(key),
      openExtensionPage: (extId, kind) => setExtPage({ extId, kind }),
      closePopup: () => setExtPage((p) => (p?.kind === "popup" ? null : p)),
      changed: () => setExtTick((n) => n + 1),
    })
  })

  // tabs.onUpdated / tabs.onActivated for extensions
  useEffect(() => {
    if (activeTab && !activeTab.isLoading && activeTab.content !== undefined) extHostRef.current?.tabUpdated(activeTab.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id, activeTab?.url, activeTab?.isLoading, activeTab?.loadId])
  useEffect(() => {
    if (activeTab?.id) extHostRef.current?.tabActivated(activeTab.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id])

  /** Clicking an extension's toolbar entry: its popup, or action.onClicked */
  const clickExtension = (extId: string) => {
    const host = extHostRef.current
    if (!host) return
    if (host.popupOf(extId)) setExtPage({ extId, kind: "popup" })
    else host.clickAction(extId)
  }

  /** Reloads installed extensions after a change and reapplies them to the current page */
  const refreshExtensions = async (message?: string) => {
    const loaded = await loadExtensions()
    extHostRef.current?.setExtensions(loaded)
    setExtensions(loaded.map((l) => l.ext))
    if (message) toast.success(message)
    const tab = tabsRef.current.find((t) => t.isActive)
    if (tab?.url && tab.content !== undefined) navigate(tab.id, tab.url, reloadMode(tab))
  }
  refreshExtensionsRef.current = refreshExtensions

  const openExtensionsMenu = (open: boolean) => {
    if (!open) return
    const win = iframeRef.current?.contentWindow ?? null
    const host = extHostRef.current
    setExtMenu({ running: host?.ranIn(win) ?? new Set(), commands: host?.menuCommands(win) ?? [] })
  }

  // Script errors reported by the proxied page (see the proxy's injected script)
  useEffect(() => {
    const w = window as Window & { __devonPageError?: (win: Window, info: Omit<PageError, "at">) => void }
    w.__devonPageError = (win, info) => {
      const frameWin = iframeRef.current?.contentWindow
      // Only the active tab's page (or frames inside it) can report
      let belongs = false
      try {
        for (let cur: Window | null = win; cur; cur = cur.parent === cur ? null : cur.parent) {
          if (cur === frameWin) {
            belongs = true
            break
          }
        }
      } catch {
        belongs = false
      }
      const tabId = activeTabIdRef.current
      if (!belongs || !tabId) return
      setPageErrors((prev) => {
        const list = prev[tabId] ?? []
        const dup = list.some((e) => e.message === info.message && e.file === info.file && e.line === info.line)
        if (dup) return prev
        return { ...prev, [tabId]: [...list, { ...info, at: Date.now() }].slice(-50) }
      })
    }
    const wa = window as Window & { __devonPageActivity?: (win: Window, info: Omit<PageActivity, "at">) => void }
    wa.__devonPageActivity = (_win, info) => {
      const tabId = activeTabIdRef.current
      if (!tabId) return
      setPageActivity((prev) => ({ ...prev, [tabId]: [...(prev[tabId] ?? []), { ...info, at: Date.now() }].slice(-60) }))
    }
    return () => {
      delete w.__devonPageError
      delete wa.__devonPageActivity
    }
  }, [])

  // Links, forms and script-driven navigation inside the proxied page ask the app to navigate
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== "object") return
      if (data.type !== "proxy-navigate" && data.type !== "proxy-url-change") return
      if (!iframeRef.current) return
      if (event.source !== iframeRef.current.contentWindow) {
        // Proxied frames inside the page (e.g. a reCAPTCHA widget) may only open new tabs
        let fromNestedProxied = false
        try {
          fromNestedProxied = Boolean((event.source as (Window & { __devonProxied?: boolean }) | null)?.__devonProxied)
        } catch {
          fromNestedProxied = false
        }
        if (!fromNestedProxied || data.type !== "proxy-navigate" || !data.newTab) return
      }
      const tabId = activeTabIdRef.current
      if (!tabId) return

      // location.reload() inside the page
      if (data.type === "proxy-navigate" && data.reload) {
        const tab = tabsRef.current.find((t) => t.id === tabId)
        if (tab?.url) navigate(tab.id, tab.url, reloadMode(tab))
        return
      }

      if (typeof data.url !== "string" || !/^https?:\/\//i.test(data.url)) return
      const url: string = data.url

      // history.pushState/replaceState: the page changed its own URL without reloading
      if (data.type === "proxy-url-change") {
        setTabs((prev) =>
          prev.map((tab) => {
            if (tab.id !== tabId || tab.url === url) return tab
            let history = tab.history
            let historyIndex = tab.historyIndex
            if (data.replace && historyIndex >= 0) {
              history = [...tab.history]
              history[historyIndex] = url
            } else {
              history = [...tab.history.slice(0, historyIndex + 1), url]
              historyIndex = history.length - 1
            }
            return { ...tab, url, history, historyIndex, isSecure: url.startsWith("https://") }
          }),
        )
        return
      }

      const request: NavRequest =
        data.method === "POST" ? { method: "POST", body: typeof data.body === "string" ? data.body : "" } : {}

      if (data.newTab) {
        openInNewTab(url, request)
      } else {
        navigate(tabId, url, data.replace ? "replace" : "push", request)
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [navigate, openInNewTab])

  // Fallback for navigations the in-page script couldn't cancel (older browsers
  // without the Navigation API): if the frame no longer holds a page written by
  // us, it has left the proxy and is loading straight from the site.
  const handleFrameLoad = (tabId: string) => (event: React.SyntheticEvent<HTMLIFrameElement>) => {
    const frame = event.currentTarget
    let ours = false
    try {
      ours = Boolean((frame.contentWindow as (Window & { __devonProxied?: boolean }) | null)?.__devonProxied)
    } catch {
      ours = false // cross-origin: definitely not ours
    }
    const leftProxy = !ours
    setTabs((prev) =>
      prev.map((tab) => (tab.id === tabId && Boolean(tab.leftProxy) !== leftProxy ? { ...tab, leftProxy } : tab)),
    )
  }

  const navigateActive = (url: string) => {
    if (activeTab) navigate(activeTab.id, url, "push")
  }

  const goBack = () => {
    if (!activeTab || activeTab.historyIndex <= 0) return
    const index = activeTab.historyIndex - 1
    navigate(activeTab.id, activeTab.history[index], { index })
  }

  const goForward = () => {
    if (!activeTab || activeTab.historyIndex >= activeTab.history.length - 1) return
    const index = activeTab.historyIndex + 1
    navigate(activeTab.id, activeTab.history[index], { index })
  }

  const refresh = () => {
    if (!activeTab?.url) return
    navigate(activeTab.id, activeTab.url, reloadMode(activeTab))
  }

  const retry = () => {
    if (!activeTab) return
    const url = activeTab.url || currentUrl
    navigate(activeTab.id, url, url === activeTab.url ? reloadMode(activeTab) : "push")
  }

  const stopLoading = () => {
    if (activeTab) controllersRef.current.get(activeTab.id)?.abort()
  }

  const goHome = () => {
    if (!activeTab) return
    cancelLoad(activeTab.id)
    releaseBlob(activeTab.id)
    setTabs((prev) =>
      prev.map((tab) =>
        tab.isActive
          ? {
              ...tab,
              url: "",
              title: "New Tab",
              isLoading: false,
              favicon: undefined,
              content: undefined,
              frameSrc: undefined,
              frameType: undefined,
              error: undefined,
              errorDetails: undefined,
              isSecure: undefined,
            }
          : tab,
      ),
    )
  }

  const clearBrowsingData = () => {
    if (confirm("Are you sure you want to clear all browsing data? This cannot be undone.")) {
      controllersRef.current.forEach((c) => c.abort())
      controllersRef.current.clear()
      blobUrlsRef.current.forEach((u) => URL.revokeObjectURL(u))
      blobUrlsRef.current.clear()
      SessionManager.clearAllData()
      // Site cookies stored by the proxy are HttpOnly, so the server clears them
      fetch("/api/proxy?clearCookies=1").catch(() => {})
      setTabs([blankTab()])
      setBookmarks([])
      setHistory([])
    }
  }

  const toggleExperimentalRecaptcha = () => {
    const next = !experimentalRecaptcha
    writeExperimentalCookie(next)
    setExperimentalRecaptcha(next)
    // The page must be fetched again to pick up the new mode
    if (activeTab?.url) navigate(activeTab.id, activeTab.url, reloadMode(activeTab))
  }

  const isBookmarked = Boolean(activeTab?.url && bookmarks.some((b) => b.url === activeTab.url))

  const toggleBookmark = () => {
    if (!activeTab?.url || activeTab.error) return
    const existing = bookmarks.filter((b) => b.url === activeTab.url)
    if (existing.length) {
      existing.forEach((b) => SessionManager.removeBookmark(b.id))
    } else {
      SessionManager.addBookmark({
        title: activeTab.title || hostnameOf(activeTab.url),
        url: activeTab.url,
        favicon: activeTab.favicon,
      })
    }
    setBookmarks(SessionManager.loadSession().bookmarks)
  }

  const removeBookmark = (id: string) => {
    SessionManager.removeBookmark(id)
    setBookmarks((prev) => prev.filter((b) => b.id !== id))
  }

  const clearHistory = () => {
    SessionManager.clearHistory()
    setHistory([])
  }

  const toggleDevtools = () => {
    const next = !devtoolsOnRef.current
    devtoolsOnRef.current = next
    setDevtoolsOn(next)
    writeDevtoolsPref(next)
    const win = iframeRef.current?.contentWindow
    if (next) {
      devtoolsReadyRef.current = loadDevtoolsSource().then((src) => {
        if (!src) {
          toast.error("Couldn't load the developer tools.")
          return
        }
        if (activeTabIdRef.current && tabsRef.current.find((t) => t.isActive)?.content !== undefined) {
          toggleDevtoolsPanel(iframeRef.current?.contentWindow)
        }
      })
    } else {
      removeDevtools(win)
    }
  }

  /** Audio/video files in the active tab (the tab's own file, or media found in its page) */
  const scanMedia = (): MediaItem[] => {
    const tab = tabsRef.current.find((t) => t.isActive)
    if (!tab?.url) return []
    if (tab.frameSrc) {
      const item = mediaItemForTab(tab.url, tab.frameType)
      return item ? [item] : []
    }
    const win = iframeRef.current?.contentWindow as (Window & { __devonProxied?: boolean }) | null
    try {
      return win?.__devonProxied ? findMedia(win, tab.url) : []
    } catch {
      return []
    }
  }

  const canSave = Boolean(activeTab && !activeTab.isLoading && !activeTab.error && (activeTab.content !== undefined || activeTab.frameSrc))

  /** The live proxied document of the active tab, if it's still ours */
  const getSaveTarget = (): SaveTarget | null => {
    const tab = tabsRef.current.find((t) => t.isActive)
    const frame = iframeRef.current
    if (!tab || tab.content === undefined || !frame) return null
    try {
      const win = frame.contentWindow as (Window & { __devonProxied?: boolean }) | null
      const doc = frame.contentDocument
      if (!win?.__devonProxied || !doc?.documentElement) return null
      return { doc, url: tab.url, title: tab.title, favicon: tab.favicon }
    } catch {
      return null // navigated off the proxy (cross-origin)
    }
  }

  const savePage = async () => {
    if (!activeTab || !canSave) return
    if (activeTab.frameSrc) {
      // Images, PDFs and other files are saved as-is
      try {
        const blob = await (await fetch(activeTab.frameSrc)).blob()
        const name = activeTab.title && /\.[a-z0-9]{1,8}$/i.test(activeTab.title) ? activeTab.title : hostnameOf(activeTab.url)
        saveBlob(blob, name)
      } catch {
        // blob URL gone; reload and try again
      }
      return
    }
    setShowSave(true)
  }

  const toggleLibrary = (view: LibraryView) => setLibraryView((prev) => (prev === view ? null : view))

  const suggestions = useSuggestions(currentUrl, addressFocused && addressTyped, history, bookmarks)
  const openSuggestion = (s: Suggestion | null) => {
    if (!activeTab) return
    const value = s ? (s.url ?? s.text) : currentUrl
    if (!value.trim()) return
    navigate(activeTab.id, value, "push")
    setAddressTyped(false)
    addressBarRef.current?.blur()
  }
  const suggestionKeys = useSuggestionKeys(suggestions, openSuggestion, () => {
    setCurrentUrl(activeTab?.url ?? "")
    setAddressTyped(false)
    addressBarRef.current?.blur()
  })

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (suggestions.length) {
      suggestionKeys.onKeyDown(e)
      return
    }
    if (e.key === "Enter" && activeTab) {
      navigate(activeTab.id, currentUrl, "push")
      e.currentTarget.blur()
    } else if (e.key === "Escape") {
      setCurrentUrl(activeTab?.url ?? "")
      e.currentTarget.blur()
    }
  }

  // Keyboard shortcuts. The handler lives in a ref so the listener always sees current state.
  const shortcutHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {})
  shortcutHandlerRef.current = (e: KeyboardEvent) => {
    const key = e.key.toLowerCase()
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      switch (key) {
        case "t":
          e.preventDefault()
          addTab()
          break
        case "w":
          e.preventDefault()
          if (activeTab) closeTab(activeTab.id)
          break
        case "r":
          e.preventDefault()
          refresh()
          break
        case "l":
          e.preventDefault()
          addressBarRef.current?.focus()
          addressBarRef.current?.select()
          break
        case "d":
          e.preventDefault()
          toggleBookmark()
          break
        case "b":
          e.preventDefault()
          toggleLibrary("bookmarks")
          break
        case "h":
          e.preventDefault()
          toggleLibrary("history")
          break
        case "e":
          if (!e.shiftKey) break
          e.preventDefault()
          if (devtoolsOnRef.current) toggleDevtoolsPanel(iframeRef.current?.contentWindow)
          else toggleDevtools()
          break
        case "s":
          e.preventDefault()
          savePage()
          break
      }
    }

    // Alt + Arrow keys for navigation
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      if (e.key === "ArrowLeft") {
        e.preventDefault()
        goBack()
      } else if (e.key === "ArrowRight") {
        e.preventDefault()
        goForward()
      }
    }
  }

  useEffect(() => {
    const listener = (e: KeyboardEvent) => shortcutHandlerRef.current(e)
    window.addEventListener("keydown", listener)
    return () => window.removeEventListener("keydown", listener)
  }, [])


  const hasPage = Boolean(activeTab?.url)
  const pageBlocked = Boolean(activeTab?.error)
  const addressValue = addressFocused ? currentUrl : prettyUrl(currentUrl)

  return (
    <div className="flex h-full flex-col bg-chrome text-foreground select-none">
      {/* ── Tab strip ─────────────────────────────────────────── */}
      <div className="flex items-end gap-1 px-2 pt-2">
        <div className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto scrollbar-hide">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              role="tab"
              aria-selected={tab.isActive}
              title={tab.title}
              onClick={() => switchTab(tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1) closeTab(tab.id)
              }}
              className={cn(
                "group relative flex h-9 min-w-[72px] max-w-[220px] flex-1 basis-[220px] cursor-pointer items-center gap-2 pl-3 pr-1.5 text-[13px] transition-colors",
                tab.isActive
                  ? "rounded-t-xl bg-toolbar text-foreground"
                  : "mb-1 h-8 rounded-lg text-muted-foreground hover:bg-white/[0.05] hover:text-foreground",
              )}
            >
              {/* curved feet that blend the active tab into the toolbar */}
              {tab.isActive && (
                <>
                  <span className="pointer-events-none absolute -left-3 bottom-0 size-3 bg-[radial-gradient(circle_at_0_0,transparent_11.5px,var(--toolbar)_12px)]" />
                  <span className="pointer-events-none absolute -right-3 bottom-0 size-3 bg-[radial-gradient(circle_at_100%_0,transparent_11.5px,var(--toolbar)_12px)]" />
                </>
              )}
              <span className="grid size-4 flex-shrink-0 place-items-center">
                {tab.isLoading ? (
                  <Loader2 className="size-3.5 animate-spin text-primary" />
                ) : (
                  <Favicon src={tab.favicon} className="size-4" />
                )}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">{tab.title || "New Tab"}</span>
              {tabs.length > 1 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(tab.id)
                  }}
                  className={cn(
                    "grid size-5 flex-shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-white/[0.12] hover:text-foreground",
                    tab.isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                  )}
                  title="Close tab (Ctrl+W)"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
          ))}
        </div>
        <button
          onClick={addTab}
          title="New tab (Ctrl+T)"
          className="mb-1 grid size-8 flex-shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-white/[0.07] hover:text-foreground"
        >
          <Plus className="size-4" />
        </button>
      </div>

      {/* ── Toolbar ───────────────────────────────────────────── */}
      <div className="relative flex items-center gap-1 bg-toolbar px-2 py-1.5 sm:gap-2">
        <div className="flex items-center">
          <ToolbarButton
            onClick={goBack}
            disabled={!activeTab || activeTab.historyIndex <= 0}
            title="Back (Alt+←)"
          >
            <ArrowLeft className="size-4" />
          </ToolbarButton>
          <ToolbarButton
            onClick={goForward}
            disabled={!activeTab || activeTab.historyIndex >= activeTab.history.length - 1}
            title="Forward (Alt+→)"
          >
            <ArrowRight className="size-4" />
          </ToolbarButton>
          {activeTab?.isLoading ? (
            <ToolbarButton onClick={stopLoading} title="Stop loading">
              <X className="size-4" />
            </ToolbarButton>
          ) : (
            <ToolbarButton onClick={refresh} disabled={!hasPage} title="Reload (Ctrl+R)">
              <RotateCw className="size-4" />
            </ToolbarButton>
          )}
          <ToolbarButton onClick={goHome} title="New tab page" className="hidden sm:grid">
            <Home className="size-4" />
          </ToolbarButton>
        </div>

        {/* Omnibox */}
        <div className="relative flex min-w-0 flex-1">
        <div
          className={cn(
            "group/omni flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full bg-omnibox pl-3 pr-1 ring-1 transition",
            addressFocused ? "ring-2 ring-primary/60 bg-background" : "ring-border hover:ring-white/15",
          )}
        >
          <span className="flex-shrink-0">
            {!hasPage || addressFocused ? (
              <Search className="size-4 text-muted-foreground" />
            ) : pageBlocked ? (
              <AlertTriangle className="size-4 text-destructive" aria-label="Page failed to load" />
            ) : activeTab?.isSecure ? (
              <Lock className="size-3.5 text-muted-foreground" aria-label="Secure connection" />
            ) : (
              <LockOpen className="size-3.5 text-amber-400" aria-label="Not secure" />
            )}
          </span>
          <input
            ref={addressBarRef}
            value={addressValue}
            onChange={(e) => {
              setCurrentUrl(e.target.value)
              setAddressTyped(true)
            }}
            onKeyDown={handleKeyDown}
            onFocus={(e) => {
              setAddressFocused(true)
              setAddressTyped(false)
              const el = e.target
              requestAnimationFrame(() => el.select())
            }}
            onBlur={() => {
              setAddressFocused(false)
              setAddressTyped(false)
            }}
            role="combobox"
            aria-expanded={suggestions.length > 0}
            aria-autocomplete="list"
            spellCheck={false}
            autoComplete="off"
            placeholder="Search or enter address"
            className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none select-text"
          />
          {hasPage && !pageBlocked && (
            <button
              onClick={toggleBookmark}
              title={isBookmarked ? "Remove bookmark (Ctrl+D)" : "Bookmark this page (Ctrl+D)"}
              className="grid size-7 flex-shrink-0 place-items-center rounded-full transition hover:bg-white/[0.08]"
            >
              <Star
                className={cn(
                  "size-4 transition",
                  isBookmarked ? "fill-primary text-primary" : "text-muted-foreground",
                )}
              />
            </button>
          )}
        </div>
          {suggestions.length > 0 && (
            <SuggestionList
              items={suggestions}
              active={suggestionKeys.active}
              query={currentUrl}
              onPick={openSuggestion}
              onHover={suggestionKeys.setActive}
              onFill={(text) => {
                setCurrentUrl(text)
                addressBarRef.current?.focus()
              }}
              className="absolute inset-x-0 top-full z-50 mt-1.5"
            />
          )}
        </div>

        <div className="flex items-center">
          {activeTab && activeTab.content !== undefined && (
            <PageProblems
              errors={pageErrors[activeTab.id] ?? []}
              activity={pageActivity[activeTab.id] ?? []}
              pageUrl={activeTab.url}
              getFrame={() => iframeRef.current?.contentWindow ?? null}
            />
          )}
          {devtoolsOn && (
            <ToolbarButton
              onClick={() => toggleDevtoolsPanel(iframeRef.current?.contentWindow)}
              disabled={activeTab?.content === undefined}
              title="Show / hide developer tools (Ctrl+Shift+E)"
            >
              <SquareTerminal className="size-4" />
            </ToolbarButton>
          )}
          <MediaDownloads
            scan={scanMedia}
            pageUrl={activeTab?.url || undefined}
            onError={(m) => toast.error(m)}
            youTubeId={activeTab?.url ? videoIdFromUrl(activeTab.url) : null}
            onOpenYouTube={(id) => navigateActive(youTubePageUrl({ view: "watch", id }))}
          />
          <DropdownMenu onOpenChange={openExtensionsMenu}>
            <DropdownMenuTrigger asChild>
              <button
                title="Extensions"
                className="relative grid size-8 place-items-center rounded-full text-muted-foreground transition hover:bg-white/[0.08] hover:text-foreground data-[state=open]:bg-white/[0.1] data-[state=open]:text-foreground outline-none"
              >
                <Puzzle className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={8} className="w-72 rounded-xl p-1.5">
              <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {activeTab?.content !== undefined ? "On this page" : "Extensions"}
              </DropdownMenuLabel>
              {extensions.filter((e) => e.enabled).length === 0 ? (
                <p className="px-2 pb-2 text-xs text-muted-foreground">No extensions turned on.</p>
              ) : activeTab?.content === undefined ? (
                <p className="px-2 pb-2 text-xs text-muted-foreground">
                  {extensions.filter((e) => e.enabled).length} turned on. Open a site to see which ones run.
                </p>
              ) : extMenu.running.size === 0 ? (
                <p className="px-2 pb-2 text-xs text-muted-foreground">None of your extensions run on this site.</p>
              ) : (
                extensions
                  .filter((e) => extMenu.running.has(e.id))
                  .map((e) => (
                    <div key={e.id} className="flex items-center gap-2 px-2 py-1.5 text-sm">
                      <span className="grid size-5 flex-shrink-0 place-items-center overflow-hidden rounded">
                        {e.icon ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={e.icon} alt="" className="size-4 object-contain" />
                        ) : (
                          <Puzzle className="size-3.5 text-muted-foreground" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{e.name}</span>
                    </div>
                  ))
              )}
              {(() => {
                const host = extHostRef.current
                const buttons = extensions.filter(
                  (e) => e.enabled && e.type === "chrome" && host && (host.hasAction(e.id) || host.optionsOf(e.id)),
                )
                if (!buttons.length) return null
                return (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Extension buttons
                    </DropdownMenuLabel>
                    {buttons.map((e) => {
                      const badge = host!.badgeOf(e.id)
                      const actionable = host!.hasAction(e.id)
                      return (
                        <DropdownMenuItem
                          key={e.id}
                          onSelect={() => (actionable ? clickExtension(e.id) : setExtPage({ extId: e.id, kind: "options" }))}
                          title={actionable ? `Open ${e.name}` : `${e.name} options`}
                        >
                          <span className="relative grid size-5 flex-shrink-0 place-items-center overflow-hidden rounded">
                            {e.icon ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={e.icon} alt="" className="size-4 object-contain" />
                            ) : (
                              <Puzzle className="size-3.5 text-muted-foreground" />
                            )}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{e.name}</span>
                          {badge?.text ? (
                            <span
                              className="rounded px-1 text-[10px] font-semibold leading-4 text-white"
                              style={{ background: badge.color || "#d93025" }}
                            >
                              {badge.text}
                            </span>
                          ) : null}
                          {host!.optionsOf(e.id) && actionable && (
                            <span
                              role="button"
                              tabIndex={-1}
                              title={`${e.name} options`}
                              onPointerDown={(ev) => ev.stopPropagation()}
                              onClick={(ev) => {
                                ev.preventDefault()
                                ev.stopPropagation()
                                setExtPage({ extId: e.id, kind: "options" })
                              }}
                              className="rounded px-1 text-[11px] text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
                            >
                              Options
                            </span>
                          )}
                        </DropdownMenuItem>
                      )
                    })}
                  </>
                )
              })()}
              {extMenu.commands.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Script commands
                  </DropdownMenuLabel>
                  {extMenu.commands.map((c) => (
                    <DropdownMenuItem key={c.key} onSelect={() => c.run()} title={c.extensionName}>
                      <span className="min-w-0 flex-1 truncate">{c.caption}</span>
                      <span className="max-w-24 truncate text-[11px] text-muted-foreground">{c.extensionName}</span>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setExtensionsOpen(true)}>
                <Puzzle /> Manage extensions
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <ToolbarButton
            onClick={() => toggleLibrary("bookmarks")}
            title="Library (Ctrl+B)"
            active={libraryView !== null}
          >
            <Library className="size-4" />
          </ToolbarButton>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                title="Menu"
                className="grid size-8 place-items-center rounded-full text-muted-foreground transition hover:bg-white/[0.08] hover:text-foreground data-[state=open]:bg-white/[0.1] data-[state=open]:text-foreground outline-none"
              >
                <EllipsisVertical className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={8} className="w-64 rounded-xl p-1.5">
              <DropdownMenuItem onSelect={addTab}>
                <Plus /> New tab <DropdownMenuShortcut>Ctrl T</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setLibraryView("bookmarks")}>
                <Star /> Bookmarks <DropdownMenuShortcut>Ctrl B</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setLibraryView("history")}>
                <Clock /> History <DropdownMenuShortcut>Ctrl H</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setExtensionsOpen(true)}>
                <Puzzle /> Extensions
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => navigateActive(GAMES_URL)}>
                <Gamepad2 /> Games
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => navigateActive(YOUTUBE_URL)}>
                <TvMinimalPlay /> YouTube downloader
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault()
                  toggleDevtools()
                }}
                title="Eruda console, elements, network, resources and sources for the page"
              >
                <SquareTerminal />
                <span className="flex-1">Developer tools</span>
                <Switch checked={devtoolsOn} className="pointer-events-none scale-90" />
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => window.dispatchEvent(new Event(OPEN_REPORT_EVENT))}
                disabled={activeTab?.content === undefined}
              >
                <AlertTriangle /> Page report
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={savePage} disabled={!canSave}>
                <Download /> Save page offline <DropdownMenuShortcut>Ctrl S</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Experimental
              </DropdownMenuLabel>
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault()
                  toggleExperimentalRecaptcha()
                }}
                title="Lets reCAPTCHA widgets work through the proxy. Also stores site cookies."
              >
                <FlaskConical />
                <span className="flex-1">reCAPTCHA support</span>
                <Switch checked={experimentalRecaptcha} className="pointer-events-none scale-90" />
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={clearBrowsingData}>
                <Trash2 /> Clear browsing data
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Loading bar */}
        {activeTab?.isLoading && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden">
            <div className="h-full w-1/3 animate-devon-progress rounded-full bg-gradient-to-r from-transparent via-primary to-transparent" />
          </div>
        )}
      </div>

      {/* ── Content ───────────────────────────────────────────── */}
      <div className="relative flex min-h-0 flex-1 gap-2 bg-toolbar p-0 sm:px-2 sm:pb-2">
        <div
          className={cn(
            "relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background sm:ring-1 sm:ring-border select-text",
            // No rounded clipping over a running game: masking a WebGL frame costs the compositor every frame
            !(activeTab && parseGamesUrl(activeTab.url)) && "sm:rounded-xl",
          )}
        >
          {(() => {
            // On a Chrome Web Store extension page: install it into Devon (the store's own
            // "Add to Chrome" button only works in Chrome)
            const storeId = activeTab?.content !== undefined ? chromeStoreId(activeTab.url) : null
            if (!storeId) return null
            const installed = extensions.some((e) => e.type === "chrome" && (e.id === storeId || e.source?.includes(storeId)))
            return (
              <div className="flex items-center gap-3 border-b border-primary/25 bg-primary/10 px-3 py-2 text-[13px] text-foreground">
                <Puzzle className="size-4 flex-shrink-0 text-primary" />
                <span className="flex-1">
                  {installed
                    ? "This extension is installed in Devon."
                    : "The store's \u201cAdd to Chrome\u201d button only works in Chrome. You can add this extension to Devon instead."}
                </span>
                {installed ? (
                  <Button size="sm" variant="secondary" className="h-7 rounded-full text-xs" onClick={() => setExtensionsOpen(true)}>
                    Manage
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    className="h-7 rounded-full text-xs"
                    disabled={storeInstalling === storeId}
                    onClick={() => {
                      setStoreInstalling(storeId)
                      installFromLink(activeTab!.url)
                        .then((ext) => refreshExtensionsRef.current(`Installed ${ext.name}`))
                        .catch((error) => toast.error(error instanceof Error ? error.message : String(error)))
                        .finally(() => setStoreInstalling(null))
                    }}
                  >
                    {storeInstalling === storeId ? <Loader2 className="animate-spin" /> : <Plus />}
                    {storeInstalling === storeId ? "Adding…" : "Add to Devon"}
                  </Button>
                )}
              </div>
            )
          })()}
          {activeTab &&
            activeTab.content !== undefined &&
            !ytNoticeDismissed[activeTab.id] &&
            youtubePlaybackBlocked(activeTab.url, pageActivity[activeTab.id] ?? []) && (
              <div className="flex items-center gap-3 border-b border-red-400/20 bg-red-500/10 px-3 py-2 text-[13px] text-red-100">
                <ShieldAlert className="size-4 flex-shrink-0 text-red-400" />
                <span className="flex-1">
                  YouTube doesn&apos;t allow video playback through proxies, so this video can&apos;t play in Devon.
                  Browsing and search still work.
                </span>
                <button
                  onClick={() => setYtNoticeDismissed((prev) => ({ ...prev, [activeTab.id]: true }))}
                  className="grid size-6 place-items-center rounded-full text-red-200/80 hover:bg-white/[0.08] hover:text-red-100"
                  title="Dismiss"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            )}
          {activeTab?.leftProxy && activeTab.content !== undefined && (
            <div className="flex items-center gap-3 border-b border-amber-400/20 bg-amber-400/10 px-3 py-2 text-[13px] text-amber-200">
              <ShieldAlert className="size-4 flex-shrink-0 text-amber-400" />
              <span className="flex-1">
                This page navigated in a way Devon couldn&apos;t intercept, so it&apos;s loading directly from the site.
              </span>
              <Button size="sm" variant="secondary" className="h-7 rounded-full text-xs" onClick={refresh}>
                Reload through proxy
              </Button>
            </div>
          )}

          {activeTab?.content !== undefined ? (
            <ProxiedFrame
              key={`${activeTab.id}:${activeTab.loadId}`}
              html={activeTab.content}
              title={activeTab.title}
              frameRef={iframeRef}
              onLoad={handleFrameLoad(activeTab.id)}
            />
          ) : activeTab?.frameSrc ? (
            // Non-HTML responses: PDFs need an unsandboxed frame for the built-in viewer;
            // everything else (images, SVG, text) is shown with scripts disabled
            <iframe
              key={`${activeTab.id}-file`}
              src={activeTab.frameSrc}
              className="min-h-0 w-full flex-1 border-0 bg-white"
              title={activeTab.title}
              {...(activeTab.frameType?.includes("pdf") ? {} : { sandbox: "allow-downloads" })}
            />
          ) : activeTab && parseYouTubeUrl(activeTab.url) ? (
            <div className="min-h-0 flex-1">
              <YouTubePage
                route={parseYouTubeUrl(activeTab.url)!}
                onNavigate={(route) => navigate(activeTab.id, youTubePageUrl(route), "push")}
                onTitle={(title) => {
                  const tabId = activeTab.id
                  setTabs((prev) => prev.map((t) => (t.id === tabId && parseYouTubeUrl(t.url) ? { ...t, title } : t)))
                }}
              />
            </div>
          ) : activeTab && parseGamesUrl(activeTab.url) !== null ? (
            <div className="min-h-0 flex-1">
              <GamesPage
                gameId={parseGamesUrl(activeTab.url) ?? ""}
                onOpen={(id) => navigate(activeTab.id, id ? `${GAMES_URL}/${id}` : GAMES_URL, "push")}
              />
            </div>
          ) : activeTab?.error ? (
            <div className="flex flex-1 items-center justify-center overflow-auto p-6">
              <div className="w-full max-w-md">
                <span
                  className={cn(
                    "mb-5 grid size-12 place-items-center rounded-2xl",
                    activeTab.error === STOPPED_MESSAGE
                      ? "bg-white/[0.06] text-muted-foreground"
                      : "bg-destructive/15 text-destructive",
                  )}
                >
                  {activeTab.error === STOPPED_MESSAGE ? <X className="size-6" /> : <WifiOff className="size-6" />}
                </span>
                <h2 className="text-xl font-semibold tracking-tight">
                  {activeTab.error === STOPPED_MESSAGE ? "Loading stopped" : "This page couldn't load"}
                </h2>
                <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{activeTab.url}</p>
                <p className="mt-4 text-sm text-foreground/80">{activeTab.error}</p>

                {activeTab.error !== STOPPED_MESSAGE && (
                  <ul className="mt-4 space-y-1.5 text-[13px] text-muted-foreground">
                    <li>• The site may block proxies (Cloudflare or bot protection)</li>
                    <li>• The site may be temporarily down</li>
                    <li>• The address may be wrong or the page may not exist</li>
                  </ul>
                )}

                {activeTab.errorDetails && (
                  <details className="mt-4 rounded-lg bg-white/[0.03] ring-1 ring-border">
                    <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground hover:text-foreground">
                      Technical details
                    </summary>
                    <pre className="max-h-48 overflow-auto scrollbar-thin px-3 pb-3 text-[11px] text-muted-foreground">
                      {activeTab.errorDetails}
                    </pre>
                  </details>
                )}

                <div className="mt-6 flex gap-2">
                  <Button onClick={retry} className="rounded-full px-5">
                    <RotateCw /> Try again
                  </Button>
                  <Button onClick={goHome} variant="ghost" className="rounded-full px-5">
                    New tab page
                  </Button>
                </div>
              </div>
            </div>
          ) : activeTab?.url ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
              <span className="relative grid size-14 place-items-center rounded-2xl bg-white/[0.05] ring-1 ring-border">
                <Favicon src={activeTab.favicon} className="size-6" />
                <Loader2 className="absolute -right-1.5 -bottom-1.5 size-5 animate-spin rounded-full bg-background p-0.5 text-primary" />
              </span>
              <div>
                <p className="text-sm font-medium">Loading {hostnameOf(activeTab.url)}</p>
                <p className="mt-1 max-w-sm truncate font-mono text-xs text-muted-foreground">{activeTab.url}</p>
              </div>
            </div>
          ) : (
            <NewTabPage
              key={activeTab?.id}
              onNavigate={(input) => activeTab && navigate(activeTab.id, input, "push")}
              bookmarks={bookmarks}
              history={history}
            />
          )}
        </div>

        {libraryView && (
          <div className="absolute inset-0 z-30 sm:static sm:z-auto sm:w-80 sm:flex-shrink-0">
            <LibraryPanel
              view={libraryView}
              onViewChange={setLibraryView}
              onClose={() => setLibraryView(null)}
              onNavigate={(url) => {
                navigateActive(url)
                if (window.matchMedia("(max-width: 639px)").matches) setLibraryView(null)
              }}
              bookmarks={bookmarks}
              history={history}
              onRemoveBookmark={removeBookmark}
              onClearHistory={clearHistory}
            />
          </div>
        )}
      </div>
      <SavePageDialog open={showSave} onOpenChange={setShowSave} getTarget={getSaveTarget} />
      {extPage &&
        (() => {
          const ext = extensions.find((e) => e.id === extPage.extId)
          if (!ext) return null
          const Page = extPage.kind === "popup" ? ExtensionPopup : ExtensionOptions
          return (
            <Page
              key={`${extPage.kind}:${ext.id}`}
              host={extHostRef.current}
              extId={ext.id}
              name={ext.name}
              icon={ext.icon}
              onClose={() => setExtPage(null)}
            />
          )
        })()}
      <ExtensionsDialog
        open={extensionsOpen}
        onOpenChange={setExtensionsOpen}
        extensions={extensions}
        onChanged={refreshExtensions}
        onOpenPage={(extId, kind) => setExtPage({ extId, kind })}
      />
      <Toaster position="bottom-right" />
    </div>
  )
}

/** Extension id from a Chrome Web Store detail page URL (old and new store) */
function chromeStoreId(pageUrl: string): string | null {
  try {
    const u = new URL(pageUrl)
    if (!/^(chromewebstore\.google\.com|chrome\.google\.com)$/i.test(u.hostname)) return null
    if (!/\/detail\//.test(u.pathname)) return null
    return /\b([a-p]{32})\b/.exec(u.pathname)?.[1] ?? null
  } catch {
    return null
  }
}

/**
 * True on a YouTube watch/shorts page once YouTube has refused playback: its
 * player request was rejected (400) or its video downloads were refused (403).
 */
function youtubePlaybackBlocked(pageUrl: string, activity: PageActivity[]): boolean {
  let u: URL
  try {
    u = new URL(pageUrl)
  } catch {
    return false
  }
  if (!/(^|\.)youtube\.com$/i.test(u.hostname)) return false
  if (!(u.pathname === "/watch" || u.pathname.startsWith("/shorts/") || u.pathname.startsWith("/live/"))) return false
  const playerRefused = activity.some((a) => /\/youtubei\/v1\/player/.test(a.url) && Number(a.status) === 400)
  const videoRefused = activity.filter((a) => /videoplayback/.test(a.url) && Number(a.status) === 403).length >= 2
  return playerRefused || videoRefused
}

function prettyUrl(url: string) {
  return url.replace(/^https:\/\//i, "").replace(/^www\./i, "")
}

function ToolbarButton({
  children,
  className,
  active,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      {...props}
      className={cn(
        "grid size-8 place-items-center rounded-full text-muted-foreground transition outline-none",
        "hover:bg-white/[0.08] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/60",
        "disabled:pointer-events-none disabled:opacity-35",
        active && "bg-white/[0.1] text-foreground",
        className,
      )}
    >
      {children}
    </button>
  )
}
