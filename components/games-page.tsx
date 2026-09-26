"use client"

import { useEffect, useRef, useState } from "react"
import { ArrowLeft, ExternalLink, Gamepad2, Loader2, Maximize, Play, RotateCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { GAMES, type Game } from "@/lib/games"
import { cn } from "@/lib/utils"

/** The Games page: a grid of bundled games, and the player for the one picked */
export function GamesPage({ gameId, onOpen }: { gameId: string; onOpen: (id: string) => void }) {
  const game = GAMES.find((g) => g.id === gameId)
  return game ? <GamePlayer key={game.id} game={game} onBack={() => onOpen("")} /> : <GameGrid onOpen={onOpen} />
}

function GameGrid({ onOpen }: { onOpen: (id: string) => void }) {
  return (
    <div className="relative h-full w-full overflow-y-auto scrollbar-thin bg-background px-4">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[360px] bg-[radial-gradient(ellipse_60%_60%_at_50%_0%,oklch(0.7_0.15_272/0.16),transparent)]" />
      <div className="relative mx-auto w-full max-w-4xl py-12">
        <div className="mb-8 flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-2xl bg-primary/15 text-primary ring-1 ring-primary/30">
            <Gamepad2 className="size-6" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Games</h1>
            <p className="text-sm text-muted-foreground">Played right in Devon — no proxy needed.</p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {GAMES.map((g) => (
            <button
              key={g.id}
              onClick={() => onOpen(g.id)}
              className="group overflow-hidden rounded-2xl bg-toolbar text-left ring-1 ring-border outline-none transition hover:-translate-y-0.5 hover:ring-primary/50 focus-visible:ring-2 focus-visible:ring-primary"
            >
              <div className="relative aspect-video overflow-hidden bg-[#1b2728]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={g.cover}
                  alt=""
                  className="absolute inset-0 size-full scale-110 object-cover opacity-40 blur-md"
                />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={g.cover}
                  alt=""
                  className={cn("relative mx-auto h-full object-contain", g.pixelated && "[image-rendering:pixelated]")}
                />
                <span className="absolute inset-0 grid place-items-center bg-black/0 transition group-hover:bg-black/35">
                  <span className="grid size-12 scale-90 place-items-center rounded-full bg-primary text-primary-foreground opacity-0 shadow-lg transition group-hover:scale-100 group-hover:opacity-100">
                    <Play className="size-5 fill-current" />
                  </span>
                </span>
              </div>
              <div className="p-4">
                <p className="font-medium">{g.title}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {g.author} · {g.size}
                </p>
                <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{g.description}</p>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function GamePlayer({ game, onBack }: { game: Game; onBack: () => void }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const [state, setState] = useState<"loading" | "ready" | "error">("loading")
  const [error, setError] = useState("")
  const [run, setRun] = useState(0)

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow || !e.data?.devonGame) return
      if (e.data.devonGame === "ready") setState("ready")
      if (e.data.devonGame === "error") {
        setState("error")
        setError(String(e.data.message || "The game failed to start"))
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [])

  const fullscreen = () => {
    const el = frameRef.current as (HTMLIFrameElement & { webkitRequestFullscreen?: () => void }) | null
    if (!el) return
    if (el.requestFullscreen) el.requestFullscreen().catch(() => el.webkitRequestFullscreen?.())
    else el.webkitRequestFullscreen?.()
    el.focus()
  }

  const restart = () => {
    setState("loading")
    setError("")
    setRun((n) => n + 1)
  }

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div className="flex h-11 flex-shrink-0 items-center gap-2 border-b border-border px-3">
        <Button size="sm" variant="ghost" className="h-8 rounded-full px-3" onClick={onBack}>
          <ArrowLeft /> Games
        </Button>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={game.icon} alt="" className={cn("ml-1 size-5 rounded", game.pixelated && "[image-rendering:pixelated]")} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{game.title}</span>
        {state === "loading" && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        <Button size="sm" variant="ghost" className="h-8 rounded-full" onClick={restart} title="Restart game">
          <RotateCw />
        </Button>
        <Button size="sm" variant="ghost" className="h-8 rounded-full" asChild title="Open in its own browser tab">
          <a href={game.src} target="_blank" rel="noreferrer">
            <ExternalLink />
          </a>
        </Button>
        <Button size="sm" variant="secondary" className="h-8 rounded-full px-3" onClick={fullscreen}>
          <Maximize /> <span className="hidden sm:inline">Fullscreen</span>
        </Button>
      </div>
      <div className="relative min-h-0 flex-1 bg-[#1b2728]">
        <iframe
          key={run}
          ref={frameRef}
          src={game.src}
          title={game.title}
          allow="fullscreen; autoplay; gamepad"
          allowFullScreen
          className={cn("size-full border-0", state === "error" && "opacity-40")}
          onLoad={() => {
            frameRef.current?.focus()
            if (!game.readySignal) setState("ready")
          }}
        />
        {state === "error" && (
          <div className="absolute inset-x-0 bottom-6 mx-auto w-fit max-w-md rounded-xl bg-popover px-4 py-3 text-sm ring-1 ring-border">
            <p className="text-destructive">{error}</p>
            <Button size="sm" className="mt-2 rounded-full" onClick={restart}>
              <RotateCw /> Try again
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
