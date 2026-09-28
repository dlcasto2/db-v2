"use client"

import type React from "react"
import { useEffect, useRef, useState } from "react"
import { ArrowDownToLine, ChevronRight, Download, Film, Link2, Music, RefreshCw, TvMinimalPlay } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  type MediaItem,
  extOf,
  fetchSize,
  fileNameOf,
  formatBytes,
  isMediaUrl,
  kindOf,
  startDownload,
} from "@/lib/media"
import { cn } from "@/lib/utils"

const SOURCE_LABEL: Record<MediaItem["source"], string> = {
  player: "Player",
  link: "Link",
  network: "Loaded by page",
  page: "Page info",
}

interface MediaDownloadsProps {
  /** Scans the current page; called each time the panel opens */
  scan: () => MediaItem[]
  pageUrl?: string
  onError: (message: string) => void
  /** Set when the page is a YouTube video: offers Devon's YouTube downloader */
  youTubeId?: string | null
  onOpenYouTube?: (id: string) => void
}

export function MediaDownloads({ scan, pageUrl, onError, youTubeId, onOpenYouTube }: MediaDownloadsProps) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<MediaItem[]>([])
  const [sizes, setSizes] = useState<Record<string, number | null>>({})
  const [link, setLink] = useState("")
  const sizeAbort = useRef<AbortController | null>(null)

  const refresh = () => {
    let found: MediaItem[] = []
    try {
      found = scan()
    } catch {
      found = []
    }
    setItems(found)
    sizeAbort.current?.abort()
    const controller = new AbortController()
    sizeAbort.current = controller
    // Sizes for the first few, a couple at a time
    const queue = found.slice(0, 12)
    const next = async () => {
      const item = queue.shift()
      if (!item || controller.signal.aborted) return
      const size = await fetchSize(item.url, pageUrl, controller.signal)
      if (!controller.signal.aborted) setSizes((prev) => ({ ...prev, [item.url]: size }))
      await next()
    }
    next()
    next()
  }

  useEffect(() => {
    if (open) refresh()
    else sizeAbort.current?.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const downloadLink = (e: React.FormEvent) => {
    e.preventDefault()
    let url = link.trim()
    if (!url) return
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`
    try {
      new URL(url)
    } catch {
      onError("That doesn't look like a link.")
      return
    }
    const name = fileNameOf(url, "download")
    startDownload(url, name, pageUrl)
    setLink("")
  }

  const pasted = link.trim()
  const pastedLooksMedia = pasted ? isMediaUrl(/^https?:/i.test(pasted) ? pasted : `https://${pasted}`) : false

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          title="Download media"
          className="grid size-8 place-items-center rounded-full text-muted-foreground outline-none transition hover:bg-white/[0.08] hover:text-foreground data-[state=open]:bg-white/[0.1] data-[state=open]:text-foreground"
        >
          <ArrowDownToLine className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-[min(22rem,calc(100vw-1.5rem))] rounded-xl p-0">
        {youTubeId && onOpenYouTube && (
          <button
            onClick={() => {
              setOpen(false)
              onOpenYouTube(youTubeId)
            }}
            className="flex w-full items-center gap-3 border-b border-border px-3 py-3 text-left transition hover:bg-white/[0.05]"
          >
            <span className="grid size-8 flex-shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
              <TvMinimalPlay className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium">Download this YouTube video</span>
              <span className="block text-[11px] text-muted-foreground">MP4 up to 4K, MP3 or M4A audio</span>
            </span>
            <ChevronRight className="size-4 text-muted-foreground" />
          </button>
        )}
        <div className="flex items-center justify-between px-3 pb-1 pt-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Media on this page</p>
          <button
            onClick={refresh}
            title="Scan again"
            className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
          >
            <RefreshCw className="size-3.5" />
          </button>
        </div>

        <div className="max-h-72 overflow-y-auto scrollbar-thin px-1.5 pb-1.5">
          {items.length === 0 ? (
            <p className="px-2 py-3 text-xs leading-relaxed text-muted-foreground">
              No MP3, MP4, WAV, FLAC or other audio/video files found. Try pressing play first, then scan again.
              Streamed video (like most big video sites) can&apos;t be saved.
            </p>
          ) : (
            items.map((item) => {
              const size = sizes[item.url]
              return (
                <div
                  key={item.url}
                  className="group flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-white/[0.05]"
                  title={item.url}
                >
                  <span
                    className={cn(
                      "grid size-8 flex-shrink-0 place-items-center rounded-lg",
                      item.kind === "audio" ? "bg-orange-400/15 text-orange-300" : "bg-sky-400/15 text-sky-300",
                    )}
                  >
                    {item.kind === "audio" ? <Music className="size-4" /> : <Film className="size-4" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium">{item.name}</p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      <span className="uppercase">{item.ext}</span>
                      {typeof size === "number" && ` · ${formatBytes(size)}`}
                      {` · ${SOURCE_LABEL[item.source]}`}
                    </p>
                  </div>
                  <button
                    onClick={() => startDownload(item.url, item.name, pageUrl)}
                    title={`Download ${item.name}`}
                    className="grid size-8 flex-shrink-0 place-items-center rounded-full bg-primary/15 text-primary transition hover:bg-primary hover:text-primary-foreground"
                  >
                    <Download className="size-4" />
                  </button>
                </div>
              )
            })
          )}
        </div>

        <form onSubmit={downloadLink} className="border-t border-border p-3">
          <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Download from a link
          </label>
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Link2 className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={link}
                onChange={(e) => setLink(e.target.value)}
                placeholder="https://…/song.mp3"
                spellCheck={false}
                className="h-8 w-full rounded-lg bg-omnibox pl-8 pr-2 text-[13px] text-foreground outline-none ring-1 ring-border placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/60"
              />
            </div>
            <button
              type="submit"
              disabled={!pasted}
              className="h-8 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground transition disabled:opacity-40"
            >
              Save
            </button>
          </div>
          {pasted && !pastedLooksMedia && (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Not a recognised media link. It will still be saved as a file.
            </p>
          )}
        </form>
      </PopoverContent>
    </Popover>
  )
}

/** Media item for a tab that is itself showing an audio/video file */
export function mediaItemForTab(url: string, contentType?: string): MediaItem | null {
  const ext = extOf(url)
  const typeKind = contentType?.startsWith("audio/") ? "audio" : contentType?.startsWith("video/") ? "video" : null
  if (!typeKind && !isMediaUrl(url)) return null
  const kind = typeKind ?? kindOf(ext)
  const extension = ext || (contentType?.split("/")[1]?.split(";")[0] ?? (kind === "audio" ? "mp3" : "mp4"))
  let name = fileNameOf(url, kind)
  if (!name.toLowerCase().endsWith(`.${extension}`)) name += `.${extension}`
  return { url, name, kind, ext: extension, source: "page" }
}
