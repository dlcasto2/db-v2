"use client"

import { useEffect, useState } from "react"
import { GamesPage } from "@/components/games-page"

/** Standalone Games page (/games, /games#<id>) — the same page Devon opens at devon://games */
export default function Games() {
  const [id, setId] = useState("")
  useEffect(() => {
    const read = () => setId(decodeURIComponent(location.hash.slice(1)))
    read()
    window.addEventListener("hashchange", read)
    return () => window.removeEventListener("hashchange", read)
  }, [])
  return (
    <main className="h-dvh w-full">
      <GamesPage gameId={id} onOpen={(next) => (location.hash = next)} />
    </main>
  )
}
