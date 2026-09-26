"use client"

import type React from "react"
import { useMemo, useState } from "react"
import { Clock, Globe, Search, Star, Trash2, X } from "lucide-react"
import type { BookmarkItem, HistoryItem } from "@/lib/session-manager"
import { Favicon } from "@/components/favicon"
import { cn } from "@/lib/utils"

export type LibraryView = "bookmarks" | "history"

interface LibraryPanelProps {
  view: LibraryView
  onViewChange: (view: LibraryView) => void
  onClose: () => void
  onNavigate: (url: string) => void
  bookmarks: BookmarkItem[]
  history: HistoryItem[]
  onRemoveBookmark: (id: string) => void
  onClearHistory: () => void
}

function dayLabel(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((startOf(today) - startOf(d)) / 86_400_000)
  if (diff === 0) return "Today"
  if (diff === 1) return "Yesterday"
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })
}

function displayUrl(url: string) {
  return url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")
}

/** Docked side panel holding bookmarks and history */
export function LibraryPanel({
  view,
  onViewChange,
  onClose,
  onNavigate,
  bookmarks,
  history,
  onRemoveBookmark,
  onClearHistory,
}: LibraryPanelProps) {
  const [query, setQuery] = useState("")
  const q = query.trim().toLowerCase()

  const matches = (item: { title: string; url: string }) =>
    !q || item.title.toLowerCase().includes(q) || item.url.toLowerCase().includes(q)

  const filteredBookmarks = bookmarks.filter(matches)

  const historyGroups = useMemo(() => {
    const groups: { label: string; items: HistoryItem[] }[] = []
    for (const item of history.slice(0, 300)) {
      if (!matches(item)) continue
      const label = dayLabel(item.visitedAt)
      const last = groups[groups.length - 1]
      if (last && last.label === label) last.items.push(item)
      else groups.push({ label, items: [item] })
    }
    return groups
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, q])

  const row = (item: { url: string; title: string; favicon?: string }, trailing: React.ReactNode, key: string) => (
    <div
      key={key}
      role="button"
      tabIndex={0}
      onClick={() => onNavigate(item.url)}
      onKeyDown={(e) => e.key === "Enter" && onNavigate(item.url)}
      className="group flex items-center gap-3 rounded-lg px-2.5 py-2 cursor-pointer hover:bg-white/[0.06] focus-visible:bg-white/[0.06] outline-none transition-colors"
    >
      <span className="grid place-items-center size-7 rounded-md bg-white/[0.06] flex-shrink-0">
        <Favicon src={item.favicon} className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-foreground">{item.title || displayUrl(item.url)}</p>
        <p className="truncate text-xs text-muted-foreground">{displayUrl(item.url)}</p>
      </div>
      {trailing}
    </div>
  )

  return (
    <aside className="flex h-full w-full flex-col bg-toolbar sm:rounded-xl sm:border sm:border-border overflow-hidden">
      <div className="flex items-center gap-2 px-3 pt-3">
        <div className="flex flex-1 rounded-lg bg-white/[0.05] p-0.5 text-[13px]">
          {(["bookmarks", "history"] as const).map((v) => (
            <button
              key={v}
              onClick={() => onViewChange(v)}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 font-medium capitalize transition-colors",
                view === v ? "bg-white/[0.1] text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {v === "bookmarks" ? <Star className="size-3.5" /> : <Clock className="size-3.5" />}
              {v}
            </button>
          ))}
        </div>
        <button
          onClick={onClose}
          className="grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
          title="Close panel"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="px-3 py-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${view}`}
            className="h-9 w-full rounded-lg bg-omnibox pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground outline-none ring-1 ring-border focus:ring-2 focus:ring-primary/60"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-1.5 pb-3">
        {view === "bookmarks" ? (
          filteredBookmarks.length === 0 ? (
            <Empty
              icon={<Star className="size-5" />}
              title={q ? "No matching bookmarks" : "No bookmarks yet"}
              hint={q ? undefined : "Tap the star in the address bar to save a page."}
            />
          ) : (
            filteredBookmarks.map((b) =>
              row(
                b,
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemoveBookmark(b.id)
                  }}
                  className="grid size-7 place-items-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-destructive/15 hover:text-destructive transition"
                  title="Remove bookmark"
                >
                  <Trash2 className="size-3.5" />
                </button>,
                b.id,
              ),
            )
          )
        ) : historyGroups.length === 0 ? (
          <Empty
            icon={<Clock className="size-5" />}
            title={q ? "No matching pages" : "No history yet"}
            hint={q ? undefined : "Pages you visit will show up here."}
          />
        ) : (
          historyGroups.map((g) => (
            <div key={g.label} className="mb-2">
              <p className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
                {g.label}
              </p>
              {g.items.map((h) =>
                row(
                  h,
                  <span className="text-[11px] tabular-nums text-muted-foreground/70">
                    {new Date(h.visitedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                  </span>,
                  h.id + h.url,
                ),
              )}
            </div>
          ))
        )}
      </div>

      {view === "history" && history.length > 0 && (
        <div className="border-t border-border p-2">
          <button
            onClick={onClearHistory}
            className="w-full rounded-lg py-2 text-[13px] font-medium text-destructive hover:bg-destructive/10 transition-colors"
          >
            Clear history
          </button>
        </div>
      )}
    </aside>
  )
}

function Empty({ icon, title, hint }: { icon: React.ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <span className="mb-3 grid size-11 place-items-center rounded-full bg-white/[0.06] text-muted-foreground">
        {icon ?? <Globe className="size-5" />}
      </span>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
