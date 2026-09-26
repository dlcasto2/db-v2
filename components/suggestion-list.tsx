"use client"

import { ArrowUpLeft, Clock, Gamepad2, Globe, Search, Star } from "lucide-react"
import type { Suggestion } from "@/lib/suggestions"
import { Favicon } from "@/components/favicon"
import { cn } from "@/lib/utils"

/** Site icon, loaded through the proxy like tab icons */
function siteIcon(url: string) {
  let host = url
  try {
    host = new URL(url).hostname
  } catch {
    // keep
  }
  return `/api/proxy?url=${encodeURIComponent(`https://www.google.com/s2/favicons?domain=${host}&sz=32`)}&raw=1`
}

function displayUrl(url: string) {
  return url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")
}

/** Dropdown of address-bar / search-box suggestions */
export function SuggestionList({
  items,
  active,
  query,
  onPick,
  onHover,
  onFill,
  className,
}: {
  items: Suggestion[]
  active: number
  query: string
  onPick: (s: Suggestion) => void
  onHover: (index: number) => void
  /** Puts a search suggestion into the box without searching (the ↖ button) */
  onFill?: (text: string) => void
  className?: string
}) {
  if (!items.length) return null
  const q = query.trim().toLowerCase()

  // Bold the part after what was typed, like most browsers
  const highlight = (text: string) => {
    if (q && text.toLowerCase().startsWith(q) && text.length > q.length) {
      return (
        <>
          <span className="text-muted-foreground">{text.slice(0, q.length)}</span>
          <span className="font-semibold">{text.slice(q.length)}</span>
        </>
      )
    }
    return text
  }

  return (
    <ul
      role="listbox"
      className={cn(
        "overflow-hidden rounded-2xl bg-popover py-1.5 text-popover-foreground shadow-2xl ring-1 ring-border",
        className,
      )}
      // Keep focus in the input while clicking
      onMouseDown={(e) => e.preventDefault()}
    >
      {items.map((s, i) => (
        <li
          key={`${s.kind}:${s.url ?? s.text}:${i}`}
          role="option"
          aria-selected={i === active}
          onMouseEnter={() => onHover(i)}
          onClick={() => onPick(s)}
          className={cn(
            "group flex cursor-pointer items-center gap-3 px-3.5 py-2 text-sm",
            i === active ? "bg-white/[0.08]" : "hover:bg-white/[0.05]",
          )}
        >
          <span className="grid size-5 flex-shrink-0 place-items-center text-muted-foreground">
            {s.kind === "search" ? (
              <Search className="size-4" />
            ) : s.kind === "history" ? (
              s.favicon ? <Favicon src={s.favicon} className="size-4" /> : <Clock className="size-4" />
            ) : s.kind === "bookmark" ? (
              <Star className="size-4 fill-primary/30 text-primary" />
            ) : s.url?.startsWith("devon://") ? (
              <Gamepad2 className="size-4 text-primary" />
            ) : s.kind === "site" && s.url ? (
              <Favicon src={siteIcon(s.url)} className="size-4" />
            ) : (
              <Globe className="size-4" />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate">
            {s.kind === "search" ? (
              highlight(s.text)
            ) : s.kind === "site" ? (
              <>
                {s.text}
                <span className="text-muted-foreground"> — {displayUrl(s.url ?? "")}</span>
              </>
            ) : s.kind === "url" ? (
              <>
                {s.text}
                <span className="text-muted-foreground"> — Open</span>
              </>
            ) : (
              <>
                {s.text}
                {s.url && <span className="text-muted-foreground"> — {displayUrl(s.url)}</span>}
              </>
            )}
          </span>
          {s.kind === "history" && <Clock className="size-3.5 flex-shrink-0 text-muted-foreground/60" />}
          {s.kind === "search" && onFill && i > 0 && (
            <button
              type="button"
              title="Use this search"
              onClick={(e) => {
                e.stopPropagation()
                onFill(s.text)
              }}
              className="grid size-6 flex-shrink-0 place-items-center rounded-full text-muted-foreground opacity-0 transition hover:bg-white/[0.1] hover:text-foreground group-hover:opacity-100"
            >
              <ArrowUpLeft className="size-3.5" />
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}
