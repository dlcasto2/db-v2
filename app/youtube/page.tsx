"use client"

import { useEffect, useState } from "react"
import { YouTubePage } from "@/components/youtube-page"
import { type YouTubeRoute, parseYouTubeUrl, youTubePageUrl } from "@/lib/youtube"

/** Standalone YouTube page (/youtube, /youtube?q=…, /youtube?v=…) — the same page Devon opens at devon://youtube */
export default function YouTube() {
  const [route, setRoute] = useState<YouTubeRoute | null>(null)
  useEffect(() => {
    const read = () => {
      const params = new URLSearchParams(location.search)
      const v = params.get("v")
      setRoute(parseYouTubeUrl(v ? `devon://youtube/watch?v=${v}` : `devon://youtube?q=${encodeURIComponent(params.get("q") || "")}`))
    }
    read()
    window.addEventListener("popstate", read)
    return () => window.removeEventListener("popstate", read)
  }, [])
  const go = (next: YouTubeRoute) => {
    const qs = youTubePageUrl(next).replace(/^devon:\/\/youtube(\/watch)?/, "")
    history.pushState(null, "", `/youtube${qs}`)
    setRoute(next)
  }
  return <main className="h-dvh w-full">{route && <YouTubePage route={route} onNavigate={go} onTitle={(t) => (document.title = t)} />}</main>
}
