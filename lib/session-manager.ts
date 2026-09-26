export interface BookmarkItem {
  id: string
  title: string
  url: string
  favicon?: string
  createdAt: number
}

export interface HistoryItem {
  id: string
  title: string
  url: string
  favicon?: string
  visitedAt: number
}

export interface BrowserSession {
  tabs: Array<{
    id: string
    title: string
    url: string
    isActive: boolean
    favicon?: string
    history: string[]
    historyIndex: number
    isSecure?: boolean
  }>
  bookmarks: BookmarkItem[]
  history: HistoryItem[]
  settings: {
    homepage: string
    searchEngine: string
    clearDataOnClose: boolean
  }
}

const STORAGE_KEYS = {
  SESSION: "proxy-browser-session",
  BOOKMARKS: "proxy-browser-bookmarks",
  HISTORY: "proxy-browser-history",
  SETTINGS: "proxy-browser-settings",
}

export class SessionManager {
  static saveSession(session: Partial<BrowserSession>): void {
    try {
      if (session.tabs) {
        localStorage.setItem(STORAGE_KEYS.SESSION, JSON.stringify(session.tabs))
      }
      if (session.bookmarks) {
        localStorage.setItem(STORAGE_KEYS.BOOKMARKS, JSON.stringify(session.bookmarks))
      }
      if (session.history) {
        localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(session.history))
      }
      if (session.settings) {
        localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(session.settings))
      }
    } catch (error) {
      console.error("Failed to save session:", error)
    }
  }

  static loadSession(): BrowserSession {
    try {
      const defaultSession: BrowserSession = {
        tabs: [
          {
            id: "1",
            title: "New Tab",
            url: "",
            isActive: true,
            history: [],
            historyIndex: -1,
          },
        ],
        bookmarks: [],
        history: [],
        settings: {
          homepage: "",
          searchEngine: "https://duckduckgo.com/?ia=web&q=",
          clearDataOnClose: false,
        },
      }

      const tabs = localStorage.getItem(STORAGE_KEYS.SESSION)
      const bookmarks = localStorage.getItem(STORAGE_KEYS.BOOKMARKS)
      const history = localStorage.getItem(STORAGE_KEYS.HISTORY)
      const settings = localStorage.getItem(STORAGE_KEYS.SETTINGS)

      // Restored tabs never carry page content or in-flight state, and exactly one is active
      let restoredTabs: BrowserSession["tabs"] = tabs ? JSON.parse(tabs) : []
      if (!Array.isArray(restoredTabs) || restoredTabs.length === 0) restoredTabs = defaultSession.tabs
      const activeIndex = Math.max(0, restoredTabs.findIndex((t) => t.isActive))
      restoredTabs = restoredTabs.map((t, i) => ({
        id: String(t.id),
        title: t.title || "New Tab",
        url: t.url || "",
        isActive: i === activeIndex,
        favicon: t.favicon,
        history: Array.isArray(t.history) ? t.history : [],
        historyIndex: typeof t.historyIndex === "number" ? t.historyIndex : -1,
        isSecure: t.isSecure,
      }))

      return {
        tabs: restoredTabs,
        bookmarks: bookmarks ? JSON.parse(bookmarks) : defaultSession.bookmarks,
        history: history ? JSON.parse(history) : defaultSession.history,
        settings: settings ? JSON.parse(settings) : defaultSession.settings,
      }
    } catch (error) {
      console.error("Failed to load session:", error)
      return {
        tabs: [
          {
            id: "1",
            title: "New Tab",
            url: "",
            isActive: true,
            history: [],
            historyIndex: -1,
          },
        ],
        bookmarks: [],
        history: [],
        settings: {
          homepage: "",
          searchEngine: "https://duckduckgo.com/?ia=web&q=",
          clearDataOnClose: false,
        },
      }
    }
  }

  static addToHistory(item: Omit<HistoryItem, "id" | "visitedAt">): void {
    try {
      const history = this.loadSession().history
      const newItem: HistoryItem = {
        ...item,
        id: Date.now().toString(),
        visitedAt: Date.now(),
      }

      // Remove duplicate URLs and add to beginning
      const filteredHistory = history.filter((h) => h.url !== item.url)
      const updatedHistory = [newItem, ...filteredHistory].slice(0, 1000) // Keep last 1000 items

      this.saveSession({ history: updatedHistory })
    } catch (error) {
      console.error("Failed to add to history:", error)
    }
  }

  static addBookmark(item: Omit<BookmarkItem, "id" | "createdAt">): BookmarkItem {
    try {
      const bookmarks = this.loadSession().bookmarks
      const newBookmark: BookmarkItem = {
        ...item,
        id: Date.now().toString(),
        createdAt: Date.now(),
      }

      const updatedBookmarks = [newBookmark, ...bookmarks]
      this.saveSession({ bookmarks: updatedBookmarks })

      return newBookmark
    } catch (error) {
      console.error("Failed to add bookmark:", error)
      throw error
    }
  }

  static removeBookmark(id: string): void {
    try {
      const bookmarks = this.loadSession().bookmarks
      const updatedBookmarks = bookmarks.filter((b) => b.id !== id)
      this.saveSession({ bookmarks: updatedBookmarks })
    } catch (error) {
      console.error("Failed to remove bookmark:", error)
    }
  }

  static isBookmarked(url: string): boolean {
    try {
      const bookmarks = this.loadSession().bookmarks
      return bookmarks.some((b) => b.url === url)
    } catch (error) {
      return false
    }
  }

  static clearAllData(): void {
    try {
      Object.values(STORAGE_KEYS).forEach((key) => {
        localStorage.removeItem(key)
      })
    } catch (error) {
      console.error("Failed to clear data:", error)
    }
  }

  static clearHistory(): void {
    try {
      localStorage.removeItem(STORAGE_KEYS.HISTORY)
    } catch (error) {
      console.error("Failed to clear history:", error)
    }
  }

  static exportSession(): string {
    try {
      const session = this.loadSession()
      return JSON.stringify(session, null, 2)
    } catch (error) {
      console.error("Failed to export session:", error)
      return "{}"
    }
  }

  static importSession(sessionData: string): void {
    try {
      const session = JSON.parse(sessionData) as BrowserSession
      this.saveSession(session)
    } catch (error) {
      console.error("Failed to import session:", error)
      throw new Error("Invalid session data")
    }
  }
}
