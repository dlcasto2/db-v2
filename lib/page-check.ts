/**
 * Page check: after a page loads, Devon sends a small text snapshot of it to
 * /api/jev, where Jev (TypeSafe AI's decision model) classifies the page and
 * estimates whether it's phishing or a scam. Safe to import from client code.
 */

export const PAGE_CATEGORIES = {
  search: "Search engine or web directory",
  news: "News, magazine, blog or article",
  social: "Social network, forum, chat or community",
  video: "Video, music or streaming",
  shopping: "Online store, marketplace or product page",
  games: "Games or gaming",
  education: "School, learning, reference or encyclopedia",
  developer: "Software, programming, documentation or code hosting",
  finance: "Bank, payments, crypto or investing",
  account: "Sign-in, account or email page",
  government: "Government or public service",
  adult: "Sexual or adult-only content",
  gambling: "Gambling or betting",
  other: "Anything else",
} as const

export type PageCategory = keyof typeof PAGE_CATEGORIES

export const CATEGORY_LABELS: Record<PageCategory, string> = {
  search: "Search",
  news: "News & articles",
  social: "Social & forums",
  video: "Video & music",
  shopping: "Shopping",
  games: "Games",
  education: "Learning & reference",
  developer: "Software & code",
  finance: "Banking & payments",
  account: "Sign-in & accounts",
  government: "Government",
  adult: "Adult",
  gambling: "Gambling",
  other: "Other",
}

export interface PageSnapshot {
  url: string
  title: string
  description: string
  /** Visible text, trimmed to a few thousand characters */
  text: string
  hasPasswordField: boolean
  hasCardField: boolean
}

export type Verdict = "safe" | "caution" | "danger"

export interface PageCheck {
  verdict: Verdict
  reasons: string[]
  category: PageCategory
  categoryConfidence: number
  /** 0..1 */
  phishing: number
  scam: number
  /** Probability the domain really belongs to the brand the page presents */
  brandMatch: number
  /** 0 (untrustworthy) .. 3 (well-known, reputable) */
  trust: number
  model: string
  cached?: boolean
}

const TEXT_LIMIT = 3500

/** Builds a snapshot from the page's (rewritten) HTML without running any of it */
export function snapshotFromHtml(html: string, url: string, title: string): PageSnapshot {
  const doc = new DOMParser().parseFromString(html, "text/html")
  doc.querySelectorAll("script, style, noscript, template, svg, iframe").forEach((el) => el.remove())

  const description =
    doc.querySelector('meta[name="description"]')?.getAttribute("content") ||
    doc.querySelector('meta[property="og:description"]')?.getAttribute("content") ||
    ""

  const text = (doc.body?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, TEXT_LIMIT)

  const inputs = Array.from(doc.querySelectorAll("input"))
  const hasPasswordField = inputs.some((i) => i.type.toLowerCase() === "password")
  const hasCardField = inputs.some((i) => {
    const hint = `${i.name} ${i.id} ${i.getAttribute("autocomplete") ?? ""} ${i.placeholder}`.toLowerCase()
    return /cc-number|card.?num|cardnumber|\bcvv\b|\bcvc\b|security code/.test(hint)
  })

  return {
    url,
    title: (title || doc.title || "").slice(0, 300),
    description: description.slice(0, 500),
    text,
    hasPasswordField,
    hasCardField,
  }
}

// ---------- Client calls ----------

const PREF_KEY = "devon_page_check"

export function readPageCheckPref(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== "0"
  } catch {
    return true
  }
}

export function writePageCheckPref(on: boolean) {
  try {
    localStorage.setItem(PREF_KEY, on ? "1" : "0")
  } catch {
    // storage blocked: the toggle still works for this visit
  }
}

let enabledPromise: Promise<boolean> | null = null

/** Whether the server has a Jev key (asked once per visit) */
export function pageCheckAvailable(): Promise<boolean> {
  enabledPromise ??= fetch("/api/jev", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : { enabled: false }))
    .then((j: { enabled?: boolean }) => Boolean(j.enabled))
    .catch(() => false)
  return enabledPromise
}

const cache = new Map<string, PageCheck>()

/** Pages that are not worth checking (Devon's own pages, local files, bare search results) */
export function shouldCheck(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false
  try {
    const host = new URL(url).hostname
    return !/^(localhost|127\.|10\.|192\.168\.)/.test(host)
  } catch {
    return false
  }
}

export async function checkPage(snapshot: PageSnapshot, signal?: AbortSignal): Promise<PageCheck> {
  const key = snapshot.url.split("#")[0]
  const hit = cache.get(key)
  if (hit) return { ...hit, cached: true }

  const res = await fetch("/api/jev", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(snapshot),
    signal,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { error?: string }).error || `Page check failed (${res.status})`)
  }
  const result = (await res.json()) as PageCheck
  cache.set(key, result)
  if (cache.size > 200) cache.delete(cache.keys().next().value as string)
  return result
}
