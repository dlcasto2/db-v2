"use client"

import { GamePlayer } from "@/components/games-page"

/** devon://apps/go-fish — a bundled HTML game, played with the same chrome the Games page uses */
const GO_FISH_GAME = {
  id: "go-fish",
  title: "Go Fish",
  author: "You",
  description: "Collect four of a kind. Every turn ends with a discard, and the discard pile is a second place to fish.",
  src: "/apps/go-fish/index.html",
  cover: "/apps/go-fish.svg",
  icon: "/apps/go-fish.svg",
  size: "<1 MB",
}

export function GoFishPage({ onOpenApps }: { onOpenApps: () => void }) {
  return <GamePlayer game={GO_FISH_GAME} onBack={onOpenApps} />
}
