"use client"

import { useEffect } from "react"

/**
 * Sites allowed to embed Devon full-page and hear from it: Devon's GitHub Pages
 * address (github-pages/index.html), plus any listed in
 * NEXT_PUBLIC_DEVON_SHELL_ORIGINS (comma-separated, read at build time).
 * Messages go out with these as the target origin, so a page that embeds Devon
 * from anywhere else never receives them.
 */
const SHELL_ORIGINS = [
  "https://dlcasto2.github.io",
  ...(process.env.NEXT_PUBLIC_DEVON_SHELL_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
]

/**
 * When Devon runs inside its GitHub Pages address, tells that page Devon has
 * loaded (so it can drop its loading screen, or offer a direct link if Devon
 * never loads) and keeps its tab title in step with Devon's.
 */
export function EmbedBridge() {
  useEffect(() => {
    if (window.parent === window) return
    const post = (message: Record<string, unknown>) => {
      for (const origin of SHELL_ORIGINS) {
        try {
          window.parent.postMessage({ source: "devon", ...message }, origin)
        } catch {
          // not a valid origin
        }
      }
    }
    post({ type: "devon-ready" })
    let last = ""
    const sendTitle = () => {
      if (document.title === last) return
      last = document.title
      post({ type: "devon-title", title: last })
    }
    sendTitle()
    const observer = new MutationObserver(sendTitle)
    observer.observe(document.head, { subtree: true, childList: true, characterData: true })
    return () => observer.disconnect()
  }, [])
  return null
}
