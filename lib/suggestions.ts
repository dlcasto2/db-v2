"use client"

import type React from "react"
import { GAMES_URL } from "@/lib/games"
import { YOUTUBE_URL } from "@/lib/youtube"
import { useEffect, useMemo, useRef, useState } from "react"
import type { BookmarkItem, HistoryItem } from "@/lib/session-manager"

export type SuggestionKind = "url" | "site" | "search" | "history" | "bookmark"

export interface Suggestion {
  kind: SuggestionKind
  /** What's shown (and what's navigated to for "search") */
  text: string
  /** Address to open (url / history / bookmark) */
  url?: string
  favicon?: string
}

/** Looks like an address rather than a search: has a dot and no spaces, or a scheme */
export function looksLikeUrl(input: string): boolean {
  const s = input.trim()
  if (!s || /\s/.test(s)) return false
  if (/^https?:\/\//i.test(s)) return true
  return /^[^\s/]+\.[a-z]{2,}(?::\d+)?(\/.*)?$/i.test(s) || /^localhost(:\d+)?(\/.*)?$/i.test(s)
}

function displayUrl(url: string) {
  return url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")
}

/** Search suggestions from DuckDuckGo (Devon's search engine), fetched through the proxy */
export async function fetchSearchSuggestions(query: string, signal?: AbortSignal): Promise<string[]> {
  const q = query.trim()
  if (!q) return []
  const target = `https://duckduckgo.com/ac/?q=${encodeURIComponent(q)}&type=list`
  const res = await fetch(`/api/proxy?url=${encodeURIComponent(target)}&raw=1`, { signal })
  if (!res.ok) return []
  const data: unknown = await res.json().catch(() => null)
  // type=list: ["query", ["suggestion", ...]]; default format: [{ phrase }, ...]
  if (Array.isArray(data) && Array.isArray(data[1])) return (data[1] as unknown[]).map(String)
  if (Array.isArray(data)) return data.map((d) => (d && typeof d === "object" ? String((d as { phrase?: string }).phrase ?? "") : "")).filter(Boolean)
  return []
}

/** Well-known sites, for instant website suggestions while typing: [domain, name, extra keywords] */
const POPULAR_SITES: [string, string, string?][] = [
  ["google.com", "Google"], ["youtube.com", "YouTube", "yt videos"], ["wikipedia.org", "Wikipedia", "wiki"],
  ["github.com", "GitHub", "git code"], ["reddit.com", "Reddit"], ["amazon.com", "Amazon", "shopping"],
  ["netflix.com", "Netflix"], ["twitch.tv", "Twitch", "stream"], ["discord.com", "Discord"],
  ["roblox.com", "Roblox"], ["minecraft.net", "Minecraft"], ["spotify.com", "Spotify", "music"],
  ["soundcloud.com", "SoundCloud", "music"], ["x.com", "X (Twitter)", "twitter"], ["instagram.com", "Instagram", "insta ig"],
  ["tiktok.com", "TikTok"], ["facebook.com", "Facebook", "fb"], ["pinterest.com", "Pinterest"],
  ["linkedin.com", "LinkedIn"], ["stackoverflow.com", "Stack Overflow", "so"], ["chatgpt.com", "ChatGPT", "openai gpt"],
  ["claude.ai", "Claude", "anthropic"], ["mail.google.com", "Gmail", "gmail email"], ["outlook.live.com", "Outlook", "hotmail email"],
  ["docs.google.com", "Google Docs", "docs"], ["drive.google.com", "Google Drive", "drive"], ["maps.google.com", "Google Maps", "maps"],
  ["translate.google.com", "Google Translate", "translate"], ["classroom.google.com", "Google Classroom", "classroom"],
  ["apple.com", "Apple"], ["microsoft.com", "Microsoft"], ["yahoo.com", "Yahoo"], ["bing.com", "Bing"],
  ["duckduckgo.com", "DuckDuckGo", "ddg"], ["espn.com", "ESPN", "sports"], ["nytimes.com", "The New York Times", "nyt news"],
  ["bbc.com", "BBC", "news"], ["cnn.com", "CNN", "news"], ["weather.com", "The Weather Channel", "weather"],
  ["imdb.com", "IMDb", "movies"], ["ebay.com", "eBay"], ["walmart.com", "Walmart"], ["target.com", "Target"],
  ["bestbuy.com", "Best Buy"], ["khanacademy.org", "Khan Academy", "khan"], ["quizlet.com", "Quizlet"],
  ["instructure.com", "Canvas", "canvas lms"], ["desmos.com", "Desmos", "graphing calculator"], ["coolmathgames.com", "Coolmath Games", "games"],
  ["poki.com", "Poki", "games"], ["crazygames.com", "CrazyGames", "games"], ["krunker.io", "Krunker", "games"],
  ["scratch.mit.edu", "Scratch", "scratch"], ["duolingo.com", "Duolingo", "language"], ["speedtest.net", "Speedtest", "internet speed"],
  ["archive.org", "Internet Archive", "wayback"], ["npmjs.com", "npm"], ["pypi.org", "PyPI", "python packages"],
  ["codepen.io", "CodePen"], ["replit.com", "Replit"], ["figma.com", "Figma"], ["canva.com", "Canva"],
  ["notion.so", "Notion"], ["trello.com", "Trello"], ["zoom.us", "Zoom"], ["web.whatsapp.com", "WhatsApp Web", "whatsapp"],
  ["web.telegram.org", "Telegram", "telegram"], ["store.steampowered.com", "Steam", "steam games"], ["epicgames.com", "Epic Games", "fortnite"],
  ["chess.com", "Chess.com", "chess"], ["lichess.org", "Lichess", "chess"], ["genius.com", "Genius", "lyrics"],
  ["itch.io", "itch.io", "games indie"], ["newgrounds.com", "Newgrounds"], ["fandom.com", "Fandom", "wiki"],
  ["paypal.com", "PayPal"], ["craigslist.org", "Craigslist"], ["tumblr.com", "Tumblr"], ["twitter.com", "Twitter", "x"],
  ["w3schools.com", "W3Schools", "html css tutorials"], ["developer.mozilla.org", "MDN Web Docs", "mdn javascript"],
  ["chromewebstore.google.com", "Chrome Web Store", "extensions"], ["greasyfork.org", "Greasy Fork", "userscripts"],
]

function siteMatches(query: string): Suggestion[] {
  const q = query.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "")
  if (q.length < 2 || /\s/.test(q)) return []
  const out: { s: Suggestion; score: number }[] = []
  for (const [domain, name, keywords] of POPULAR_SITES) {
    const bare = domain.replace(/^(www|web|store|mail|docs|drive|maps|translate|classroom|developer|chromewebstore|outlook)\./, "")
    const n = name.toLowerCase()
    let score = 0
    if (domain.startsWith(q) || bare.startsWith(q)) score = 3
    else if (n.startsWith(q) || n.replace(/[^a-z0-9]/g, "").startsWith(q)) score = 2
    else if (keywords?.split(" ").some((k) => k.startsWith(q))) score = 1
    if (score) out.push({ s: { kind: "site", text: name, url: `https://${domain}/` }, score })
  }
  // Devon's own Games page
  if ("games".startsWith(q) || "devon games".startsWith(q) || GAMES_URL.startsWith(q) || q.startsWith("game")) {
    out.push({ s: { kind: "site", text: "Devon Games", url: GAMES_URL }, score: 4 })
  }
  // Devon's YouTube search + downloader
  if (q.length >= 2 && ("youtube downloader".startsWith(q) || "devon youtube".startsWith(q) || YOUTUBE_URL.startsWith(q) || /^(yt|youtube) ?(dl|down)/.test(q) || q.startsWith("download youtube"))) {
    out.push({ s: { kind: "site", text: "Devon YouTube downloader", url: YOUTUBE_URL }, score: 2.5 })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3).map((o) => o.s)
}

/** The official website for a query, from DuckDuckGo's Instant Answer data (e.g. "nasa" -> nasa.gov) */
export async function fetchOfficialSite(query: string, signal?: AbortSignal): Promise<Suggestion | null> {
  const q = query.trim()
  if (q.length < 3) return null
  const target = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`
  const res = await fetch(`/api/proxy?url=${encodeURIComponent(target)}&raw=1`, { signal })
  if (!res.ok) return null
  const data = (await res.json().catch(() => null)) as {
    Heading?: string
    Results?: { FirstURL?: string; Text?: string }[]
    Infobox?: { content?: { label?: string; value?: unknown; data_type?: string }[] }
  } | null
  const official =
    data?.Results?.find((r) => /official/i.test(r.Text ?? "") && r.FirstURL)?.FirstURL ??
    (data?.Infobox?.content?.find((c) => c.data_type === "official_website" || /official website/i.test(c.label ?? ""))?.value as
      | string
      | undefined)
  if (!official || typeof official !== "string") return null
  const url = /^https?:\/\//i.test(official) ? official : `https://${official}`
  return { kind: "site", text: data?.Heading || displayUrl(url), url }
}

function localMatches(query: string, history: HistoryItem[], bookmarks: BookmarkItem[]): Suggestion[] {
  const q = query.trim().toLowerCase()
  if (q.length < 2) return []
  const seen = new Set<string>()
  const score = (title: string, url: string) => {
    const t = title.toLowerCase()
    const u = displayUrl(url).toLowerCase()
    if (u.startsWith(q)) return 3
    if (t.startsWith(q) || u.includes(`.${q}`) || u.includes(`/${q}`)) return 2
    if (t.includes(q) || u.includes(q)) return 1
    return 0
  }
  const out: (Suggestion & { s: number })[] = []
  for (const b of bookmarks) {
    const s = score(b.title, b.url)
    if (s && !seen.has(b.url)) {
      seen.add(b.url)
      out.push({ kind: "bookmark", text: b.title || displayUrl(b.url), url: b.url, favicon: b.favicon, s: s + 0.5 })
    }
  }
  for (const h of history) {
    const s = score(h.title, h.url)
    if (s && !seen.has(h.url)) {
      seen.add(h.url)
      out.push({ kind: "history", text: h.title || displayUrl(h.url), url: h.url, favicon: h.favicon, s })
    }
  }
  return out
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .map(({ s: _s, ...rest }) => rest)
}

/**
 * Suggestions for what's typed: the address itself (if it looks like one),
 * matching bookmarks/history, then search suggestions. Debounced; stale
 * requests are cancelled.
 */
export function useSuggestions(
  query: string,
  enabled: boolean,
  history: HistoryItem[],
  bookmarks: BookmarkItem[],
): Suggestion[] {
  const [remote, setRemote] = useState<{ q: string; items: string[]; site: Suggestion | null }>({ q: "", items: [], site: null })
  const cache = useRef(new Map<string, { items: string[]; site: Suggestion | null }>())

  useEffect(() => {
    const q = query.trim()
    if (!enabled || !q || looksLikeUrl(q)) return
    const hit = cache.current.get(q.toLowerCase())
    if (hit) {
      setRemote({ q, ...hit })
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      Promise.all([
        fetchSearchSuggestions(q, controller.signal).catch(() => [] as string[]),
        fetchOfficialSite(q, controller.signal).catch(() => null),
      ])
        .then(([items, site]) => {
          if (controller.signal.aborted) return
          cache.current.set(q.toLowerCase(), { items, site })
          if (cache.current.size > 200) cache.current.delete(cache.current.keys().next().value as string)
          setRemote({ q, items, site })
        })
        .catch(() => {})
    }, 120)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query, enabled])

  return useMemo(() => {
    const q = query.trim()
    if (!enabled || !q) return []
    const items: Suggestion[] = []
    if (looksLikeUrl(q)) {
      const url = /^https?:\/\//i.test(q) ? q : `https://${q}`
      items.push({ kind: "url", text: displayUrl(url), url })
    } else {
      items.push({ kind: "search", text: q })
    }
    const local = localMatches(q, history, bookmarks)
    // Websites: well-known ones matching what's typed, plus the official site DuckDuckGo knows for it
    const fresh = remote.q.toLowerCase() === q.toLowerCase()
    const sites = [...(fresh && remote.site ? [remote.site] : []), ...siteMatches(q)]
    const seenHosts = new Set(local.map((l) => (l.url ? displayUrl(l.url).split("/")[0] : "")))
    for (const site of sites) {
      if (items.filter((i) => i.kind === "site").length >= 3) break
      const host = displayUrl(site.url ?? "").split("/")[0]
      if (seenHosts.has(host) || (items[0]?.kind === "url" && displayUrl(items[0].url ?? "").split("/")[0] === host)) continue
      seenHosts.add(host)
      items.push(site)
    }
    items.push(...local)
    // Remote suggestions for this query (or the previous one while the new one loads)
    const remoteItems = remote.q && q.toLowerCase().startsWith(remote.q.toLowerCase().slice(0, Math.max(1, remote.q.length - 1)))
      ? remote.items
      : []
    for (const text of remoteItems) {
      if (items.length >= 8) break
      if (text.toLowerCase() === q.toLowerCase()) continue
      if (items.some((i) => i.kind === "search" && i.text.toLowerCase() === text.toLowerCase())) continue
      items.push({ kind: "search", text })
    }
    return items
  }, [query, enabled, remote, history, bookmarks])
}

/**
 * Keyboard handling for a suggestion list: ↑/↓ to move, Enter to open the
 * highlighted one (or what's typed), Escape to close.
 */
export function useSuggestionKeys(items: Suggestion[], onPick: (s: Suggestion | null) => void, onEscape: () => void) {
  const [active, setActive] = useState(-1)
  const itemsKey = items.map((i) => i.kind + i.text).join("|")
  useEffect(() => setActive(-1), [itemsKey])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && items.length) {
      e.preventDefault()
      setActive((a) => (a + 1) % items.length)
    } else if (e.key === "ArrowUp" && items.length) {
      e.preventDefault()
      setActive((a) => (a <= 0 ? items.length - 1 : a - 1))
    } else if (e.key === "Enter") {
      e.preventDefault()
      onPick(active >= 0 ? items[active] : null)
    } else if (e.key === "Escape") {
      onEscape()
    }
  }
  return { active, setActive, onKeyDown }
}
