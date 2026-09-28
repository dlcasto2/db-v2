"use client"

import type React from "react"
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import {
  AlertTriangle,
  ArrowLeft,
  AudioLines,
  Check,
  Download,
  ExternalLink,
  Film,
  KeyRound,
  Loader2,
  RotateCw,
  Search,
  TvMinimalPlay,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { formatBytes } from "@/lib/media"
import { saveBlob } from "@/lib/page-archiver"
import {
  type CookieStatus,
  type DownloadOption,
  type Progress,
  type YTSearchItem,
  type YTVideo,
  type YouTubeRoute,
  downloadOptions,
  formatDuration,
  getCookieStatus,
  getVideo,
  previewFormat,
  removeCookie,
  runDownload,
  safeFileName,
  saveCookie,
  searchYouTube,
  searchYouTubeMore,
  streamUrl,
  thumbnailUrl,
  videoIdFromUrl,
  youTubeSuggestions,
} from "@/lib/youtube"
import { cn } from "@/lib/utils"

interface YouTubePageProps {
  route: YouTubeRoute
  onNavigate: (route: YouTubeRoute) => void
  /** Lets the browser show the video's title on the tab */
  onTitle?: (title: string) => void
}

/** Devon's YouTube page: search YouTube, watch in Devon and download video or audio */
export function YouTubePage({ route, onNavigate, onTitle }: YouTubePageProps) {
  return route.view === "watch" ? (
    <WatchView key={route.id} id={route.id} onNavigate={onNavigate} onTitle={onTitle} />
  ) : (
    <SearchView key={route.q} query={route.q} onNavigate={onNavigate} />
  )
}

// ---------------------------------------------------------------------------
// Downloads (kept outside React so they survive moving between pages)
// ---------------------------------------------------------------------------

interface Job {
  id: string
  videoId: string
  title: string
  label: string
  fileName: string
  progress: Progress
  status: "running" | "done" | "error" | "cancelled"
  error?: string
  blob?: Blob
  controller: AbortController
}

let jobs: Job[] = []
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const setJob = (id: string, patch: Partial<Job>) => {
  jobs = jobs.map((j) => (j.id === id ? { ...j, ...patch } : j))
  emit()
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
const useJobs = () => useSyncExternalStore(subscribe, () => jobs, () => jobs)

const jobLabel = (o: DownloadOption) =>
  o.label.toUpperCase() === o.ext.toUpperCase() ? o.label : `${o.label} ${o.ext.toUpperCase()}`

/** Thumbnails can be blocked; hide the broken-image icon instead of showing it */
const hideBroken = (e: React.SyntheticEvent<HTMLImageElement>) => {
  e.currentTarget.style.visibility = "hidden"
}

function startJob(video: YTVideo, option: DownloadOption) {
  const id = `${video.id}:${option.key}:${Date.now()}`
  const fileName = `${safeFileName(video.title)}${option.kind === "video" ? ` (${option.label})` : ""}.${option.ext}`
  const controller = new AbortController()
  jobs = [
    {
      id,
      videoId: video.id,
      title: video.title,
      label: jobLabel(option),
      fileName,
      progress: { stage: "download", loaded: 0, total: option.size, ratio: 0 },
      status: "running",
      controller,
    },
    ...jobs,
  ]
  emit()
  let last = 0
  runDownload(
    video,
    option,
    (progress) => {
      // Re-render at most ~10 times a second
      const now = performance.now()
      if (progress.stage === "download" && now - last < 100 && progress.ratio !== 1) return
      last = now
      setJob(id, { progress })
    },
    controller.signal,
  )
    .then((blob) => {
      setJob(id, { status: "done", blob })
      saveBlob(blob, fileName)
    })
    .catch((error) => {
      if (controller.signal.aborted) setJob(id, { status: "cancelled" })
      else setJob(id, { status: "error", error: error instanceof Error ? error.message : String(error) })
    })
}

function dismissJob(id: string) {
  const job = jobs.find((j) => j.id === id)
  if (job?.status === "running") job.controller.abort()
  jobs = jobs.filter((j) => j.id !== id)
  emit()
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** The last search, so going back from a video shows the same results instantly */
let lastSearch: { q: string; items: YTSearchItem[]; next: string | null; scroll: number } | null = null

function SearchView({ query, onNavigate }: { query: string; onNavigate: (route: YouTubeRoute) => void }) {
  const cached = lastSearch && lastSearch.q === query ? lastSearch : null
  const [items, setItems] = useState<YTSearchItem[]>(cached?.items ?? [])
  const [next, setNext] = useState<string | null>(cached?.next ?? null)
  const [loading, setLoading] = useState(Boolean(query) && !cached)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState("")
  const [attempt, setAttempt] = useState(0)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const sentinel = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!query || (cached && attempt === 0)) return
    const controller = new AbortController()
    setLoading(true)
    setError("")
    searchYouTube(query, controller.signal)
      .then((page) => {
        setItems(page.items)
        setNext(page.next)
        lastSearch = { q: query, items: page.items, next: page.next, scroll: 0 }
      })
      .catch((e) => !controller.signal.aborted && setError(e.message))
      .finally(() => !controller.signal.aborted && setLoading(false))
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, attempt])

  // Restore the scroll position when coming back
  useEffect(() => {
    if (cached && scrollRef.current) scrollRef.current.scrollTop = cached.scroll
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadMore = async () => {
    if (!next || loadingMore) return
    setLoadingMore(true)
    try {
      const page = await searchYouTubeMore(next)
      const seen = new Set(items.map((i) => i.id))
      const merged = [...items, ...page.items.filter((i) => !seen.has(i.id))]
      setItems(merged)
      setNext(page.items.length ? page.next : null)
      lastSearch = { q: query, items: merged, next: page.next, scroll: scrollRef.current?.scrollTop ?? 0 }
    } catch {
      setNext(null)
    } finally {
      setLoadingMore(false)
    }
  }

  // Infinite scroll
  useEffect(() => {
    const el = sentinel.current
    if (!el || !next) return
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && loadMore(), {
      root: scrollRef.current,
      rootMargin: "600px",
    })
    io.observe(el)
    return () => io.disconnect()
  })

  const open = (id: string) => {
    if (lastSearch) lastSearch.scroll = scrollRef.current?.scrollTop ?? 0
    onNavigate({ view: "watch", id })
  }

  return (
    <div ref={scrollRef} className="relative h-full w-full overflow-y-auto scrollbar-thin bg-background px-4">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[360px] bg-[radial-gradient(ellipse_60%_60%_at_50%_0%,oklch(0.65_0.2_25/0.14),transparent)]" />
      <div className={cn("relative mx-auto w-full max-w-5xl", query ? "py-6" : "py-16")}>
        <div className={cn("flex items-center gap-3", query ? "mb-5" : "mb-8 justify-center")}>
          <span className="grid size-11 place-items-center rounded-2xl bg-primary/15 text-primary ring-1 ring-primary/30">
            <TvMinimalPlay className="size-6" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">YouTube</h1>
            <p className="text-sm text-muted-foreground">Search, watch and download videos or audio.</p>
          </div>
          {query && <CookieButton className="ml-auto" />}
        </div>
        {!query && (
          <div className="-mt-5 mb-6 flex justify-center">
            <CookieButton />
          </div>
        )}

        <SearchBox initial={query} onNavigate={onNavigate} big={!query} />

        {!query && <Downloads />}

        {query && (
          <div className="mt-6">
            {loading ? (
              <ResultsSkeleton />
            ) : error ? (
              <ErrorCard message={error} onRetry={() => setAttempt((n) => n + 1)} />
            ) : items.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">No videos found for “{query}”.</p>
            ) : (
              <>
                <Downloads />
                <div className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
                  {items.map((item) => (
                    <ResultCard key={item.id} item={item} onOpen={() => open(item.id)} />
                  ))}
                </div>
                <div ref={sentinel} className="h-px" />
                {next && (
                  <div className="flex justify-center py-8">
                    <Button variant="secondary" className="rounded-full" onClick={loadMore} disabled={loadingMore}>
                      {loadingMore ? <Loader2 className="animate-spin" /> : null} More results
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function SearchBox({
  initial,
  onNavigate,
  big,
}: {
  initial: string
  onNavigate: (route: YouTubeRoute) => void
  big?: boolean
}) {
  const [value, setValue] = useState(initial)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [active, setActive] = useState(-1)
  const [focused, setFocused] = useState(false)
  const typed = useRef(false)

  useEffect(() => {
    const q = value.trim()
    if (!typed.current || !q || videoIdFromUrl(q)) {
      setSuggestions([])
      return
    }
    const controller = new AbortController()
    const t = setTimeout(() => {
      youTubeSuggestions(q, controller.signal)
        .then((s) => setSuggestions(s.slice(0, 8)))
        .catch(() => {})
    }, 150)
    return () => {
      clearTimeout(t)
      controller.abort()
    }
  }, [value])

  const go = (text: string) => {
    const q = text.trim()
    if (!q) return
    setSuggestions([])
    typed.current = false
    const id = videoIdFromUrl(q)
    onNavigate(id ? { view: "watch", id } : { view: "search", q })
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!suggestions.length) return
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      const n = suggestions.length
      const i = e.key === "ArrowDown" ? (active + 1) % n : (active - 1 + n) % n
      setActive(i)
      setValue(suggestions[i])
    } else if (e.key === "Escape") {
      setSuggestions([])
    }
  }

  const show = focused && suggestions.length > 0

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        go(value)
      }}
      className={cn("relative mx-auto w-full", big ? "max-w-2xl" : "max-w-3xl")}
    >
      <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        value={value}
        autoFocus={big}
        onChange={(e) => {
          typed.current = true
          setActive(-1)
          setValue(e.target.value)
        }}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        placeholder="Search YouTube or paste a video link"
        spellCheck={false}
        enterKeyHint="search"
        className={cn(
          "w-full rounded-full bg-omnibox pl-11 pr-24 text-foreground outline-none ring-1 ring-border placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/60",
          big ? "h-12 text-base" : "h-11 text-sm",
        )}
      />
      {value && (
        <button
          type="button"
          onClick={() => {
            setValue("")
            setSuggestions([])
          }}
          className="absolute right-14 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-full text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
          title="Clear"
        >
          <X className="size-4" />
        </button>
      )}
      <button
        type="submit"
        title="Search"
        className="absolute right-1.5 top-1/2 grid h-[calc(100%-12px)] w-11 -translate-y-1/2 place-items-center rounded-full bg-primary text-primary-foreground transition hover:opacity-90"
      >
        <Search className="size-4" />
      </button>
      {show && (
        <ul className="absolute inset-x-0 top-full z-20 mt-2 overflow-hidden rounded-2xl bg-popover p-1.5 shadow-xl ring-1 ring-border">
          {suggestions.map((s, i) => (
            <li key={s}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => go(s)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm hover:bg-white/[0.06]",
                  i === active && "bg-white/[0.08]",
                )}
              >
                <Search className="size-3.5 flex-shrink-0 text-muted-foreground" />
                <span className="truncate">{s}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  )
}

function ResultCard({ item, onOpen }: { item: YTSearchItem; onOpen: () => void }) {
  const meta = [item.views, item.published].filter(Boolean).join(" · ")
  return (
    <button onClick={onOpen} className="group text-left outline-none">
      <div className="relative aspect-video overflow-hidden rounded-xl bg-white/[0.04] ring-1 ring-border transition group-hover:ring-primary/50 group-focus-visible:ring-2 group-focus-visible:ring-primary">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={thumbnailUrl(item.id)}
          alt=""
          loading="lazy"
          onError={hideBroken}
          className="size-full object-cover transition duration-300 group-hover:scale-[1.03]"
        />
        {(item.duration || item.live) && (
          <span
            className={cn(
              "absolute bottom-1.5 right-1.5 rounded-md px-1.5 py-0.5 text-[11px] font-semibold",
              item.live ? "bg-red-600 text-white" : "bg-black/80 text-white",
            )}
          >
            {item.live ? "LIVE" : item.duration}
          </span>
        )}
      </div>
      <p className="mt-2.5 line-clamp-2 text-sm font-medium leading-snug">{item.title}</p>
      {item.channel && <p className="mt-1 truncate text-xs text-muted-foreground">{item.channel}</p>}
      {meta && <p className="truncate text-xs text-muted-foreground">{meta}</p>}
    </button>
  )
}

function ResultsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 9 }, (_, i) => (
        <div key={i} className="animate-pulse">
          <div className="aspect-video rounded-xl bg-white/[0.06]" />
          <div className="mt-3 h-3.5 w-4/5 rounded bg-white/[0.06]" />
          <div className="mt-2 h-3 w-1/2 rounded bg-white/[0.04]" />
        </div>
      ))}
    </div>
  )
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mx-auto my-8 max-w-md rounded-2xl bg-toolbar p-5 text-sm ring-1 ring-border">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-5 flex-shrink-0 text-destructive" />
        <div className="min-w-0">
          <p className="font-medium">Something went wrong</p>
          <p className="mt-1 break-words text-muted-foreground">{message}</p>
          <Button size="sm" className="mt-3 rounded-full" onClick={onRetry}>
            <RotateCw /> Try again
          </Button>
        </div>
      </div>
    </div>
  )
}

function DownloadUnavailableCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-4 rounded-2xl bg-toolbar p-5 text-sm ring-1 ring-border">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-5 flex-shrink-0 text-amber-400" />
        <div className="min-w-0">
          <p className="font-medium">Downloads are unavailable from this server</p>
          <p className="mt-1 break-words text-muted-foreground">{message}</p>
          <p className="mt-2 text-muted-foreground">
            You can still try watching above: “Through Devon” loads the youtube-nocookie.com player through Devon&apos;s
            proxy, and “Direct” loads it from your own connection. Neither gives Devon a file to download.
          </p>
          <p className="mt-2 text-muted-foreground">
            To download, add the cookie from a signed-in YouTube account (ideally a spare one). It&apos;s saved only in
            this browser.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" className="rounded-full" onClick={() => setOpen(true)}>
              <KeyRound /> Add YouTube cookie
            </Button>
            <Button size="sm" variant="secondary" className="rounded-full" onClick={onRetry}>
              <RotateCw /> Try again
            </Button>
          </div>
          <CookieDialog open={open} onOpenChange={setOpen} onChange={onRetry} />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Cookie box
// ---------------------------------------------------------------------------

/** Shared so every button shows the same state after a save */
let cookieState: CookieStatus | null = null
const cookieListeners = new Set<() => void>()
const setCookieState = (s: CookieStatus) => {
  cookieState = s
  cookieListeners.forEach((l) => l())
}
function useCookieState() {
  const state = useSyncExternalStore(
    (l) => {
      cookieListeners.add(l)
      return () => cookieListeners.delete(l)
    },
    () => cookieState,
    () => null,
  )
  useEffect(() => {
    if (cookieState === null) getCookieStatus().then(setCookieState).catch(() => {})
  }, [])
  return state
}

function CookieButton({ className, onChange }: { className?: string; onChange?: () => void }) {
  const [open, setOpen] = useState(false)
  const state = useCookieState()
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className={cn("h-8 rounded-full px-3 text-muted-foreground", className)}
        onClick={() => setOpen(true)}
        title="YouTube cookie for downloads"
      >
        <KeyRound className={state?.set ? "text-emerald-400" : undefined} />
        <span className="hidden sm:inline">{state?.set ? "Cookie saved" : "Add cookie"}</span>
      </Button>
      <CookieDialog open={open} onOpenChange={setOpen} onChange={onChange} />
    </>
  )
}

function CookieDialog({
  open,
  onOpenChange,
  onChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onChange?: () => void
}) {
  const state = useCookieState()
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (open) {
      setValue("")
      setError("")
    }
  }, [open])

  const save = async () => {
    setBusy(true)
    setError("")
    try {
      setCookieState(await saveCookie(value))
      setValue("")
      onOpenChange(false)
      onChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    await removeCookie().catch(() => {})
    setCookieState({ set: false })
    setBusy(false)
    onChange?.()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-5 text-primary" /> YouTube cookie
          </DialogTitle>
          <DialogDescription>
            YouTube blocks downloads from cloud servers unless they come from a signed-in account. Paste that account&apos;s
            cookie here. It&apos;s stored only in this browser, can&apos;t be read by web pages, and is sent only to this
            Devon server&apos;s YouTube downloader.
          </DialogDescription>
        </DialogHeader>

        {state?.set && (
          <div className="flex items-center gap-3 rounded-xl bg-emerald-500/10 px-3 py-2.5 text-sm ring-1 ring-emerald-500/25">
            <Check className="size-4 flex-shrink-0 text-emerald-400" />
            <span className="min-w-0 flex-1">
              Cookie saved ({state.cookies} cookies{state.hasSID ? ", signed in" : ", but no sign-in cookie"}).
            </span>
            <Button size="sm" variant="ghost" className="h-7 rounded-full" onClick={remove} disabled={busy}>
              Remove
            </Button>
          </div>
        )}
        {state?.set && !state.hasSID && (
          <p className="text-xs text-amber-400">
            This cookie has no sign-in part (SID), so YouTube will probably still block it. Copy it again while signed in.
          </p>
        )}

        <ol className="list-decimal space-y-1 pl-5 text-xs leading-relaxed text-muted-foreground">
          <li>Open a private/incognito window and sign in to YouTube, ideally with a spare account.</li>
          <li>
            Go to <span className="font-mono text-foreground">youtube.com/robots.txt</span>, press F12, open{" "}
            <b>Network</b>, and reload.
          </li>
          <li>
            Click <b>robots.txt</b> → <b>Headers</b> → <b>Request Headers</b>, right-click the <b>cookie</b> value →{" "}
            <b>Copy value</b>.
          </li>
          <li>Paste it below, then close the private window without signing out.</li>
        </ol>

        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={state?.set ? "Paste a new cookie to replace the saved one" : "VISITOR_INFO1_LIVE=…; SID=…; HSID=…; …"}
          spellCheck={false}
          autoComplete="off"
          rows={4}
          className="w-full resize-none rounded-xl bg-omnibox p-3 font-mono text-xs text-foreground outline-none ring-1 ring-border placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/60"
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" className="rounded-full" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className="rounded-full" onClick={save} disabled={busy || !value.trim()}>
            {busy ? <Loader2 className="animate-spin" /> : <KeyRound />} Save cookie
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Watch + download
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Devon's player
// ---------------------------------------------------------------------------

type PlayerMode = "devon" | "direct"
const PLAYER_KEY = "devon.youtube.player"

function readPlayerMode(): PlayerMode {
  try {
    return localStorage.getItem(PLAYER_KEY) === "direct" ? "direct" : "devon"
  } catch {
    return "devon"
  }
}

const embedUrl = (id: string) => `https://www.youtube-nocookie.com/embed/${id}?autoplay=0&rel=0&playsinline=1`

/**
 * Devon mode never makes the viewer's browser talk to YouTube:
 *  - if the download server can stream the video, it plays in a <video> fed by
 *    /api/youtube/stream;
 *  - otherwise the youtube-nocookie.com player itself is loaded through Devon's
 *    proxy (/api/proxy), so its page, scripts and video requests all go through
 *    this server.
 * Direct mode loads youtube-nocookie.com straight from the viewer's connection.
 */
function DevonPlayer({ id, video }: { id: string; video: YTVideo | null }) {
  const [mode, setModeState] = useState<PlayerMode>("devon")
  const [nativeFailed, setNativeFailed] = useState(false)
  useEffect(() => setModeState(readPlayerMode()), [])
  useEffect(() => setNativeFailed(false), [id])

  const setMode = (m: PlayerMode) => {
    setModeState(m)
    try {
      localStorage.setItem(PLAYER_KEY, m)
    } catch {
      // storage blocked
    }
  }

  const preview = video ? previewFormat(video) : undefined
  const native = mode === "devon" && video && preview && !nativeFailed
  // YouTube's embed refuses to start without knowing which site embeds it
  // (Error 153 "Video player configuration error"). Through the proxy, the
  // upstream Referer only exists if we pass one as ref=, so name this Devon site.
  const site = typeof window !== "undefined" ? `${window.location.origin}/` : ""
  const proxiedEmbed = `${embedUrl(id)}${site ? `&origin=${encodeURIComponent(site.slice(0, -1))}&widget_referrer=${encodeURIComponent(site)}` : ""}`
  const src =
    mode === "direct"
      ? embedUrl(id)
      : `/api/proxy?url=${encodeURIComponent(proxiedEmbed)}${site ? `&ref=${encodeURIComponent(site)}` : ""}`

  return (
    <div>
      <div className="relative aspect-video overflow-hidden rounded-2xl bg-black ring-1 ring-border">
        {native ? (
          <video
            key={`${id}:${preview!.itag}`}
            src={streamUrl(video!, preview!.itag)}
            poster={thumbnailUrl(id, "hq")}
            controls
            playsInline
            preload="metadata"
            className="size-full"
            onError={() => setNativeFailed(true)}
          />
        ) : (
          <iframe
            key={src}
            src={src}
            title="YouTube player"
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            className="size-full border-0"
          />
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>Player:</span>
        <div className="flex rounded-full bg-white/[0.05] p-0.5 ring-1 ring-border">
          {(
            [
              ["devon", "Through Devon"],
              ["direct", "Direct"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                "rounded-full px-2.5 py-0.5 font-medium transition",
                mode === m ? "bg-primary text-primary-foreground" : "hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="min-w-0 truncate">
          {mode === "direct"
            ? "youtube-nocookie.com from your own connection"
            : native
              ? "Streaming from this Devon server"
              : "youtube-nocookie.com loaded through Devon's proxy"}
        </span>
      </div>
    </div>
  )
}

function WatchView({
  id,
  onNavigate,
  onTitle,
}: {
  id: string
  onNavigate: (route: YouTubeRoute) => void
  onTitle?: (title: string) => void
}) {
  const [video, setVideo] = useState<YTVideo | null>(null)
  const [error, setError] = useState("")
  const [errorCode, setErrorCode] = useState("")
  const [attempt, setAttempt] = useState(0)
  const [tab, setTab] = useState<"video" | "audio">("video")

  useEffect(() => {
    const controller = new AbortController()
    setError("")
    setErrorCode("")
    setVideo(null)
    getVideo(id, controller.signal)
      .then((v) => {
        setVideo(v)
        onTitle?.(v.title)
      })
      .catch((e) => {
        if (controller.signal.aborted) return
        setError(e.message)
        setErrorCode(e.code || "")
      })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, attempt])

  const options = video ? downloadOptions(video) : null
  const back = () => onNavigate({ view: "search", q: lastSearch?.q ?? "" })

  return (
    <div className="h-full w-full overflow-y-auto scrollbar-thin bg-background">
      <div className="sticky top-0 z-10 flex h-11 items-center gap-2 border-b border-border bg-background/90 px-3 backdrop-blur">
        <Button size="sm" variant="ghost" className="h-8 rounded-full px-3" onClick={back}>
          <ArrowLeft /> {lastSearch?.q ? "Results" : "YouTube"}
        </Button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{video?.title}</span>
        <CookieButton onChange={() => setAttempt((n) => n + 1)} />
      </div>

      <div className="mx-auto grid w-full max-w-6xl gap-6 p-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0">
          <DevonPlayer id={id} video={video} />

          {error && (errorCode === "bot-check" || errorCode === "stream-unavailable") ? (
            <DownloadUnavailableCard message={error} onRetry={() => setAttempt((n) => n + 1)} />
          ) : error ? (
            <ErrorCard message={error} onRetry={() => setAttempt((n) => n + 1)} />
          ) : video ? (
            <div className="mt-4">
              <h1 className="text-lg font-semibold leading-snug sm:text-xl">{video.title}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {[
                  video.channel,
                  video.views !== null ? `${video.views.toLocaleString()} views` : "",
                  video.duration ? formatDuration(video.duration) : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {video.description && (
                <p className="mt-3 line-clamp-4 whitespace-pre-line rounded-xl bg-white/[0.03] p-3 text-sm text-muted-foreground ring-1 ring-border">
                  {video.description}
                </p>
              )}
              <a
                href={`https://www.youtube-nocookie.com/embed/${video.id}`}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                <ExternalLink className="size-3.5" /> youtube-nocookie.com/embed/{video.id}
              </a>
            </div>
          ) : (
            <div className="mt-4 animate-pulse">
              <div className="h-5 w-3/4 rounded bg-white/[0.06]" />
              <div className="mt-2 h-3.5 w-1/3 rounded bg-white/[0.04]" />
            </div>
          )}
        </div>

        <aside className="min-w-0">
          <div className="rounded-2xl bg-toolbar p-3 ring-1 ring-border">
            <div className="mb-3 flex items-center justify-between px-1">
              <p className="text-sm font-semibold">Download</p>
              <div className="flex rounded-full bg-white/[0.05] p-0.5 ring-1 ring-border">
                {(["video", "audio"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition",
                      tab === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t === "video" ? <Film className="size-3.5" /> : <AudioLines className="size-3.5" />}
                    {t === "video" ? "Video" : "Audio"}
                  </button>
                ))}
              </div>
            </div>

            {error ? (
              <p className="px-1 py-3 text-sm text-muted-foreground">Downloads aren&apos;t available for this video right now.</p>
            ) : !options ? (
              <div className="space-y-2 p-1">
                {Array.from({ length: 4 }, (_, i) => (
                  <div key={i} className="h-12 animate-pulse rounded-xl bg-white/[0.05]" />
                ))}
              </div>
            ) : (
              <OptionList video={video!} options={tab === "video" ? options.video : options.audio} />
            )}
            <p className="px-1 pt-2 text-[11px] leading-snug text-muted-foreground">
              HD video and MP3 are put together in your browser, which needs a one-time 31 MB download. Very long HD
              videos may be too big for phones; pick a smaller size if one fails.
            </p>
          </div>
          <div className="mt-4">
            <Downloads compact />
          </div>
        </aside>
      </div>
    </div>
  )
}

function OptionList({ video, options }: { video: YTVideo; options: DownloadOption[] }) {
  const all = useJobs()
  if (!options.length) {
    return <p className="px-1 py-3 text-sm text-muted-foreground">Nothing downloadable here.</p>
  }
  return (
    <div className="space-y-1">
      {options.map((o) => {
        const running = all.some((j) => j.videoId === video.id && j.status === "running" && j.label === jobLabel(o))
        const tooBig = (o.size ?? 0) > 1.8 * 1024 ** 3
        return (
          <div key={o.key} className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-white/[0.04]">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-sm font-medium">
                {o.label}
                {o.badge && (
                  <span className="rounded bg-primary/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-primary">
                    {o.badge}
                  </span>
                )}
              </p>
              <p className="truncate text-[11px] text-muted-foreground">
                {o.detail}
                {o.size ? ` · ${o.mode === "mp3" ? "~" : ""}${formatBytes(o.mode === "mp3" && video.duration ? video.duration * 24000 : o.size)}` : ""}
                {tooBig ? " · too big for the browser" : ""}
              </p>
            </div>
            <button
              onClick={() => startJob(video, o)}
              disabled={running || tooBig}
              title={`Download ${o.label}`}
              className="grid size-9 flex-shrink-0 place-items-center rounded-full bg-primary/15 text-primary transition hover:bg-primary hover:text-primary-foreground disabled:opacity-40 disabled:hover:bg-primary/15 disabled:hover:text-primary"
            >
              {running ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            </button>
          </div>
        )
      })}
    </div>
  )
}

const STAGE: Record<Progress["stage"], string> = {
  download: "Downloading",
  "load-ffmpeg": "Loading converter",
  process: "Processing",
  done: "Done",
}

function Downloads({ compact }: { compact?: boolean }) {
  const all = useJobs()
  if (!all.length) return null
  return (
    <div className={cn("rounded-2xl bg-toolbar p-3 ring-1 ring-border", !compact && "mx-auto my-6 max-w-3xl")}>
      <p className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Downloads</p>
      <div className="space-y-1">
        {all.map((j) => {
          const p = j.progress
          const pct = p.ratio !== null ? Math.round(p.ratio * 100) : null
          const line =
            j.status === "done"
              ? `Saved · ${j.blob ? formatBytes(j.blob.size) : ""}`
              : j.status === "error"
                ? j.error
                : j.status === "cancelled"
                  ? "Cancelled"
                  : p.stage === "download"
                    ? `${STAGE.download} · ${formatBytes(p.loaded)}${p.total ? ` of ${formatBytes(p.total)}` : ""}`
                    : `${STAGE[p.stage]}${pct !== null && p.stage === "process" ? ` · ${pct}%` : "…"}`
          return (
            <div key={j.id} className="rounded-xl px-2 py-2 hover:bg-white/[0.03]">
              <div className="flex items-center gap-2.5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={thumbnailUrl(j.videoId)} alt="" onError={hideBroken} className="h-9 w-16 flex-shrink-0 rounded-md object-cover" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium" title={j.fileName}>
                    {j.title}
                  </p>
                  <p
                    className={cn(
                      "truncate text-[11px]",
                      j.status === "error" ? "text-destructive" : "text-muted-foreground",
                    )}
                    title={line}
                  >
                    <span className="font-medium text-foreground/80">{j.label}</span> · {line}
                  </p>
                </div>
                {j.status === "done" && j.blob && (
                  <button
                    onClick={() => saveBlob(j.blob!, j.fileName)}
                    title="Save again"
                    className="grid size-7 place-items-center rounded-full text-emerald-400 hover:bg-white/[0.08]"
                  >
                    <Check className="size-4" />
                  </button>
                )}
                <button
                  onClick={() => dismissJob(j.id)}
                  title={j.status === "running" ? "Cancel" : "Remove"}
                  className="grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
                >
                  <X className="size-4" />
                </button>
              </div>
              {j.status === "running" && (
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.08]">
                  <div
                    className={cn(
                      "h-full rounded-full bg-primary transition-[width] duration-200",
                      pct === null && "w-1/3 animate-pulse",
                    )}
                    style={pct !== null ? { width: `${Math.max(2, pct)}%` } : undefined}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
