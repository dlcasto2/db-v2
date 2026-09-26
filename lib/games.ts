/** Games bundled with Devon (served from /public/games) */
export interface Game {
  id: string
  title: string
  author: string
  description: string
  /** Page that runs the game */
  src: string
  cover: string
  icon: string
  size: string
  /** The game page posts {devonGame: "ready" | "error"} itself; otherwise the frame's load event counts as ready */
  readySignal?: boolean
  /** Scale the cover up without smoothing (pixel art) */
  pixelated?: boolean
}

export const GAMES_URL = "devon://games"

export const GAMES: Game[] = [
  {
    id: "game-inside-a-game",
    title: "Game Inside a Game",
    author: "Sam Hogan",
    description: "A Unity puzzle game where the game you're playing is itself inside another game.",
    src: "/games/game-inside-a-game/index.html",
    cover: "/games/game-inside-a-game/img/display.png",
    icon: "/games/game-inside-a-game/img/icon.png",
    size: "15 MB",
    readySignal: true,
    pixelated: true,
  },
  {
    id: "eaglercraft",
    title: "EaglercraftX 1.8",
    author: "lax1dude · EaglerForge",
    description:
      "Minecraft 1.8.8 in the browser, with EaglerForge mods, Tidewake Shaders, Auto Jump and singleplayer worlds saved in your browser.",
    src: "/games/eaglercraft/index.html",
    cover: "/games/eaglercraft/icon.png",
    icon: "/games/eaglercraft/icon.png",
    size: "13 MB",
    readySignal: true,
    pixelated: true,
  },
  {
    id: "silk",
    title: "Silk",
    author: "Yuri Vishnevsky",
    description: "Interactive generative art — draw with flowing, symmetrical strands of silk.",
    src: "/games/silk/index.html",
    cover: "/games/silk/img/silk_thumb.png",
    icon: "/games/silk/img/silk_thumb.png",
    size: "1 MB",
  },
]

/** devon://games or devon://games/<id> → the game id ("" for the list), else null */
export function parseGamesUrl(input: string): string | null {
  const m = /^devon:\/\/games\/?([\w-]*)\/?$/i.exec(input.trim())
  return m ? m[1].toLowerCase() : null
}
