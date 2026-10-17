/**
 * Merge logic for the data a signed-in account syncs: bookmarks, history and
 * settings. Pure and side-effect-free, so both the server (when it reconciles a
 * push against what it already holds) and the client (when it folds the
 * server's copy into the local one) run exactly the same rules, and so it can
 * be unit-tested on its own.
 *
 * Rules:
 *  - Bookmarks and history are unioned by `id`; the newer copy of a clashing id
 *    wins (by createdAt / visitedAt).
 *  - History is also de-duplicated by URL, keeping the most recent visit, and
 *    capped so it can't grow without bound.
 *  - Settings are taken from whichever side was saved more recently.
 */

export interface SyncBookmark {
  id: string
  title: string
  url: string
  favicon?: string
  createdAt: number
}

export interface SyncHistoryItem {
  id: string
  title: string
  url: string
  favicon?: string
  visitedAt: number
}

export interface SyncSettings {
  homepage: string
  searchEngine: string
  clearDataOnClose: boolean
}

export interface SyncData {
  bookmarks: SyncBookmark[]
  history: SyncHistoryItem[]
  settings?: SyncSettings
  /** When the settings in this copy were last changed (for last-write-wins) */
  settingsAt?: number
}

const HISTORY_CAP = 1000
const BOOKMARK_CAP = 5000

function mergeById<T extends { id: string }>(a: T[], b: T[], newer: (x: T, y: T) => T): T[] {
  const byId = new Map<string, T>()
  for (const item of [...a, ...b]) {
    if (!item || typeof item.id !== "string") continue
    const existing = byId.get(item.id)
    byId.set(item.id, existing ? newer(existing, item) : item)
  }
  return [...byId.values()]
}

export function mergeSync(a: SyncData, b: SyncData): SyncData {
  const bookmarks = mergeById<SyncBookmark>(
    normalizeBookmarks(a.bookmarks),
    normalizeBookmarks(b.bookmarks),
    (x, y) => (y.createdAt >= x.createdAt ? y : x),
  )
    .sort((x, y) => y.createdAt - x.createdAt)
    .slice(0, BOOKMARK_CAP)

  const merged = mergeById<SyncHistoryItem>(
    normalizeHistory(a.history),
    normalizeHistory(b.history),
    (x, y) => (y.visitedAt >= x.visitedAt ? y : x),
  )
  // One entry per URL (the most recent visit)
  const byUrl = new Map<string, SyncHistoryItem>()
  for (const item of merged.sort((x, y) => y.visitedAt - x.visitedAt)) {
    if (!byUrl.has(item.url)) byUrl.set(item.url, item)
  }
  const history = [...byUrl.values()].sort((x, y) => y.visitedAt - x.visitedAt).slice(0, HISTORY_CAP)

  const aAt = a.settingsAt ?? 0
  const bAt = b.settingsAt ?? 0
  const settings = bAt > aAt ? b.settings ?? a.settings : a.settings ?? b.settings
  const settingsAt = Math.max(aAt, bAt) || undefined

  return { bookmarks, history, settings, settingsAt }
}

function normalizeBookmarks(list: unknown): SyncBookmark[] {
  if (!Array.isArray(list)) return []
  return list.flatMap((b) => {
    if (!b || typeof b.id !== "string" || typeof b.url !== "string") return []
    return [
      {
        id: b.id,
        title: typeof b.title === "string" ? b.title : b.url,
        url: b.url,
        favicon: typeof b.favicon === "string" ? b.favicon : undefined,
        createdAt: Number(b.createdAt) || 0,
      },
    ]
  })
}

function normalizeHistory(list: unknown): SyncHistoryItem[] {
  if (!Array.isArray(list)) return []
  return list.flatMap((h) => {
    if (!h || typeof h.id !== "string" || typeof h.url !== "string") return []
    return [
      {
        id: h.id,
        title: typeof h.title === "string" ? h.title : h.url,
        url: h.url,
        favicon: typeof h.favicon === "string" ? h.favicon : undefined,
        visitedAt: Number(h.visitedAt) || 0,
      },
    ]
  })
}

/** Coerce arbitrary stored/posted JSON into a clean SyncData (used on the server) */
export function normalizeSyncData(raw: unknown): SyncData {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const settings = obj.settings as SyncSettings | undefined
  return {
    bookmarks: normalizeBookmarks(obj.bookmarks),
    history: normalizeHistory(obj.history),
    settings:
      settings && typeof settings === "object"
        ? {
            homepage: typeof settings.homepage === "string" ? settings.homepage : "",
            searchEngine: typeof settings.searchEngine === "string" ? settings.searchEngine : "",
            clearDataOnClose: Boolean(settings.clearDataOnClose),
          }
        : undefined,
    settingsAt: Number(obj.settingsAt) || undefined,
  }
}
