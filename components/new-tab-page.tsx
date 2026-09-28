"use client"

import type React from "react"
import { useMemo, useState } from "react"
import { ArrowRight, Gamepad2, Search, TvMinimalPlay } from "lucide-react"
import { GAMES_URL } from "@/lib/games"
import { YOUTUBE_URL } from "@/lib/youtube"
import type { BookmarkItem, HistoryItem } from "@/lib/session-manager"
import { Favicon } from "@/components/favicon"
import { DevonMark } from "@/components/devon-logo"
import { SuggestionList } from "@/components/suggestion-list"
import { type Suggestion, useSuggestionKeys, useSuggestions } from "@/lib/suggestions"
import { cn } from "@/lib/utils"

function hostLabel(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

interface NewTabPageProps {
  onNavigate: (input: string) => void
  bookmarks: BookmarkItem[]
  history: HistoryItem[]
}

const SHORTCUTS: [string, string][] = [
  ["Ctrl T", "New tab"],
  ["Ctrl L", "Address bar"],
  ["Ctrl D", "Bookmark page"],
  ["Ctrl B", "Library"],
  ["Alt ←/→", "Back / forward"],
]

export function NewTabPage({ onNavigate, bookmarks, history }: NewTabPageProps) {
  const [query, setQuery] = useState("")

  // Bookmarks first, then recently visited sites (one per host) to fill the grid
  const tiles = useMemo(() => {
    const seen = new Set<string>()
    const out: { url: string; title: string; favicon?: string }[] = []
    for (const item of [...bookmarks, ...history]) {
      const host = hostLabel(item.url)
      if (seen.has(host)) continue
      seen.add(host)
      out.push(item)
      if (out.length === 8) break
    }
    return out
  }, [bookmarks, history])

  const [focused, setFocused] = useState(true)
  const suggestions = useSuggestions(query, focused, history, bookmarks)
  const open = (s: Suggestion | null) => {
    const value = s ? (s.url ?? s.text) : query
    if (value.trim()) onNavigate(value)
  }
  const keys = useSuggestionKeys(suggestions, open, () => setQuery(""))

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    open(keys.active >= 0 ? suggestions[keys.active] : null)
  }

  return (
    <div className="relative flex h-full w-full flex-col items-center overflow-y-auto scrollbar-thin bg-background px-4">
      {/* soft glow */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(ellipse_60%_60%_at_50%_0%,oklch(0.7_0.15_272/0.16),transparent)]" />

      <div className="relative flex w-full max-w-xl flex-1 flex-col items-center justify-center py-16">
        <div className="mb-8 flex items-center gap-3">
          <DevonMark className="size-12 drop-shadow-[0_8px_28px_rgba(255,122,47,0.35)]" />
          <h1 className="text-4xl font-semibold tracking-tight text-foreground">Devon</h1>
        </div>

        <form onSubmit={submit} className="group relative w-full">
          <Search className="pointer-events-none absolute left-5 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") keys.onKeyDown(e)
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            role="combobox"
            aria-expanded={suggestions.length > 0}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            placeholder="Search the web or enter a URL"
            className="h-14 w-full rounded-2xl bg-toolbar pl-14 pr-14 text-[15px] text-foreground placeholder:text-muted-foreground shadow-[0_8px_30px_rgba(0,0,0,0.35)] outline-none ring-1 ring-border transition focus:ring-2 focus:ring-primary/60"
          />
          <button
            type="submit"
            disabled={!query.trim()}
            className="absolute right-2.5 top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-xl bg-primary text-primary-foreground transition disabled:opacity-0"
            title="Go"
          >
            <ArrowRight className="size-4" />
          </button>
          {suggestions.length > 0 && (
            <SuggestionList
              items={suggestions}
              active={keys.active}
              query={query}
              onPick={open}
              onHover={keys.setActive}
              onFill={(text) => setQuery(text)}
              className="absolute inset-x-0 top-full z-20 mt-2"
            />
          )}
        </form>

        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => onNavigate(GAMES_URL)}
            className="flex items-center gap-2 rounded-full bg-white/[0.04] px-4 py-2 text-sm text-muted-foreground ring-1 ring-border transition hover:bg-white/[0.08] hover:text-foreground hover:ring-primary/40"
          >
            <Gamepad2 className="size-4 text-primary" /> Games
          </button>
          <button
            onClick={() => onNavigate(YOUTUBE_URL)}
            className="flex items-center gap-2 rounded-full bg-white/[0.04] px-4 py-2 text-sm text-muted-foreground ring-1 ring-border transition hover:bg-white/[0.08] hover:text-foreground hover:ring-primary/40"
          >
            <TvMinimalPlay className="size-4 text-primary" /> YouTube
          </button>
        </div>

        {tiles.length > 0 && (
          <div className="mt-8 grid w-full grid-cols-4 gap-2 sm:gap-3">
            {tiles.map((t) => (
              <button
                key={t.url}
                onClick={() => onNavigate(t.url)}
                title={t.title}
                className={cn(
                  "group flex flex-col items-center gap-2 rounded-xl px-1 py-3 transition-colors",
                  "hover:bg-white/[0.05] focus-visible:bg-white/[0.05] outline-none",
                )}
              >
                <span className="grid size-12 place-items-center rounded-2xl bg-toolbar ring-1 ring-border transition group-hover:ring-primary/40 group-hover:-translate-y-0.5">
                  <Favicon src={t.favicon} className="size-6" />
                </span>
                <span className="w-full truncate text-center text-xs text-muted-foreground group-hover:text-foreground">
                  {hostLabel(t.url)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="relative hidden flex-wrap justify-center gap-x-5 gap-y-2 pb-6 text-[11px] text-muted-foreground/70 sm:flex">
        {SHORTCUTS.map(([k, label]) => (
          <span key={k} className="flex items-center gap-1.5">
            <kbd className="rounded-md border border-border bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {k}
            </kbd>
            {label}
          </span>
        ))}
      </div>
    </div>
  )
}
