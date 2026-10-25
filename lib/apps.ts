/**
 * Devon's built-in apps (devon://apps): YouTube, Devon AI and Prompt Gen.
 * YouTube keeps its own routes in lib/youtube.ts (devon://apps/youtube…).
 */

import { YOUTUBE_ICON, YOUTUBE_URL } from "@/lib/youtube"

export const APPS_URL = "devon://apps"
export const AI_URL = "devon://apps/ai"
export const PROMPT_GEN_URL = "devon://apps/prompt-gen"
export const GO_FISH_URL = "devon://apps/go-fish"

export const APPS_ICON = "/apps/apps.svg"
export const AI_ICON = "/apps/devon-ai.svg"
export const PROMPT_GEN_ICON = "/apps/prompt-gen.svg"
export const GO_FISH_ICON = "/apps/go-fish.svg"

export type AppId = "ai" | "youtube" | "prompt-gen" | "go-fish"

export interface DevonApp {
  id: AppId
  title: string
  tagline: string
  description: string
  url: string
  icon: string
}

export const APPS: DevonApp[] = [
  {
    id: "ai",
    title: "Devon AI",
    tagline: "Chat · code · page help",
    description: "Ask anything, run code in a sandbox, or ask about the page you're on.",
    url: AI_URL,
    icon: AI_ICON,
  },
  {
    id: "youtube",
    title: "YouTube",
    tagline: "Search · watch · download",
    description: "Search YouTube, then watch or download videos right in Devon.",
    url: YOUTUBE_URL,
    icon: YOUTUBE_ICON,
  },
  {
    id: "prompt-gen",
    title: "Prompt Gen",
    tagline: "Offline prompt remixer",
    description: "Turn a rough idea into ready-to-use prompts. Works offline.",
    url: PROMPT_GEN_URL,
    icon: PROMPT_GEN_ICON,
  },
  {
    id: "go-fish",
    title: "Go Fish",
    tagline: "Card game · discard pile",
    description: "Collect four of a kind. Every turn ends with a discard, and the discard pile is a second place to fish.",
    url: GO_FISH_URL,
    icon: GO_FISH_ICON,
  },
]

/** "" = the Apps page itself */
export type AppPage = "" | "ai" | "prompt-gen" | "go-fish"

/**
 * devon://apps → "", devon://apps/ai → "ai", devon://apps/prompt-gen → "prompt-gen",
 * devon://apps/go-fish → "go-fish". YouTube addresses return null
 * (lib/youtube.ts handles them); an unknown app name falls back to the Apps page.
 */
export function parseAppsUrl(input: string): AppPage | null {
  const m = /^devon:\/\/apps(?:\/([\w-]*))?\/?(?:[?#].*)?$/i.exec(input.trim())
  if (!m) return null
  const id = (m[1] || "").toLowerCase()
  if (id === "youtube") return null
  if (id === "ai" || id === "devon-ai") return "ai"
  if (id === "prompt-gen" || id === "promptgen") return "prompt-gen"
  if (id === "go-fish" || id === "gofish") return "go-fish"
  return ""
}

/** Address, tab title and icon for an app page */
export function appPageInfo(page: AppPage): { url: string; title: string; favicon: string } {
  if (page === "ai") return { url: AI_URL, title: "Devon AI", favicon: AI_ICON }
  if (page === "prompt-gen") return { url: PROMPT_GEN_URL, title: "Prompt Gen", favicon: PROMPT_GEN_ICON }
  if (page === "go-fish") return { url: GO_FISH_URL, title: "Go Fish", favicon: GO_FISH_ICON }
  return { url: APPS_URL, title: "Apps", favicon: APPS_ICON }
}
