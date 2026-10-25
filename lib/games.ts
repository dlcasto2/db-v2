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
  {
    id: "chrome-dino",
    title: "Chrome Dino",
    author: "Chromium Project",
    description: "The offline T-Rex runner built into Chrome — dodge cacti and pterodactyls in an endless desert run.",
    src: "/games/chrome-dino/index.html",
    cover: "/games/chrome-dino/icons/icon-256.png",
    icon: "/games/chrome-dino/icons/icon-128.png",
    size: "<1 MB",
    pixelated: true,
  },
  {
    id: "minesweeper",
    title: "Minesweeper",
    author: "Classic puzzle",
    description: "Clear the board without hitting a mine — the classic logic puzzle.",
    src: "/games/minesweeper/index.html",
    cover: "/games/minesweeper/img/minesweeper.png",
    icon: "/games/minesweeper/img/minesweeper.png",
    size: "6 MB",
  },
  {
    id: "sort-the-court",
    title: "Sort the Court!",
    author: "Graceful Decay",
    description: "Rule a kingdom one bizarre request at a time in this tiny decision-making game.",
    src: "/games/sort-the-court/index.html",
    cover: "/games/sort-the-court/logo.jpg",
    icon: "/games/sort-the-court/logo.png",
    size: "15 MB",
  },
  {
    id: "cell-machine",
    title: "Cell Machine",
    author: "Sam Hogan",
    description: "A cellular-automaton puzzle game — build machines out of living, interacting cells.",
    src: "/games/cell-machine/index.html",
    cover: "/games/cell-machine/img/icon.png",
    icon: "/games/cell-machine/img/icon.png",
    size: "11 MB",
  },
  {
    id: "line-rider",
    title: "Line Rider",
    author: "Boštjan Čadež",
    description: "Draw a track and watch Bosh sled down it — the physics-based line-drawing classic.",
    src: "/games/line-rider/index.html",
    cover: "/games/line-rider/_v1888.0/test-lines.png",
    icon: "/games/line-rider/_v1888.0/boshicon.png",
    size: "4 MB",
  },
  {
    id: "worlds-hardest-game",
    title: "World's Hardest Game",
    author: "Stephen Critoph",
    description:
      "Guide a red square through mazes of bouncing blue circles without touching one. It's exactly what it sounds like.",
    src: "/games/worlds-hardest-game/index.html",
    cover: "/games/worlds-hardest-game/images/splash.jpg",
    icon: "/games/worlds-hardest-game/logo.png",
    size: "6 MB",
  },
  {
    id: "worlds-hardest-game-2",
    title: "World's Hardest Game 2",
    author: "Stephen Critoph",
    description: "More mazes, more circles — the sequel to the original.",
    src: "/games/worlds-hardest-game-2/index.html",
    cover: "/games/worlds-hardest-game-2/images/main_menu.png",
    icon: "/games/worlds-hardest-game-2/logo.png",
    size: "<1 MB",
  },
  {
    id: "doge-miner",
    title: "DogeMiner",
    author: "DogeMiner Team",
    description: "Mine Dogecoin, buy upgrades, go to the moon — a Doge-themed idle clicker.",
    src: "/games/doge-miner/index.html",
    cover: "/games/doge-miner/logo.png",
    icon: "/games/doge-miner/img/dogecoin-d.png",
    size: "12 MB",
  },
  {
    id: "grindcraft",
    title: "Grindcraft",
    author: "Freeware fan game",
    description: "A Minecraft-themed idle/clicker game — gather, craft and grind your way up the tech tree.",
    src: "/games/grindcraft/index.html",
    cover: "/games/grindcraft/img/splash.png",
    icon: "/games/grindcraft/logo.png",
    size: "5 MB",
  },
  {
    id: "you-are-bezos",
    title: "You Are Jeff Bezos",
    author: "Indie parody",
    description: "A satirical clicker where you run Amazon as Jeff Bezos.",
    src: "/games/you-are-bezos/index.html",
    cover: "/games/you-are-bezos/img/banner.png",
    icon: "/games/you-are-bezos/img/icon.png",
    size: "1 MB",
  },
  {
    id: "draw-the-hill",
    title: "Draw the Hill",
    author: "Indie",
    description: "Sketch a track to roll a ball safely down the hill, physics-puzzle style.",
    src: "/games/draw-the-hill/index.html",
    cover: "/games/draw-the-hill/logo.png",
    icon: "/games/draw-the-hill/logo.png",
    size: "3 MB",
  },
  {
    id: "evil-glitch",
    title: "Evil Glitch",
    author: "Indie",
    description: "A fast, glitchy platformer — dodge, jump and survive corrupted levels.",
    src: "/games/evil-glitch/index.html",
    cover: "/games/evil-glitch/evil.png",
    icon: "/games/evil-glitch/logo.png",
    size: "<1 MB",
  },
  {
    id: "just-one-boss",
    title: "Just One Boss",
    author: "Indie",
    description: "A single, deliberately brutal boss fight — survive it and that's the whole game.",
    src: "/games/just-one-boss/index.html",
    cover: "/games/just-one-boss/pv1Gr5.png",
    icon: "/games/just-one-boss/logo.png",
    size: "1 MB",
  },
  {
    id: "there-is-no-game",
    title: "There Is No Game",
    author: "Draw Me A Pixel",
    description: "A meta point-and-click comedy about a game that insists it isn't one.",
    src: "/games/there-is-no-game/index.html",
    cover: "/games/there-is-no-game/loading-logo.png",
    icon: "/games/there-is-no-game/logo.png",
    size: "8 MB",
  },
  {
    id: "death-run-3d",
    title: "Death Run 3D",
    author: "Published via Y8",
    description: "Run, jump and dodge traps in a fast 3D obstacle course inspired by the classic 'deathrun' game mode.",
    src: "/games/death-run-3d/index.html",
    cover: "/games/death-run-3d/img/death.png",
    icon: "/games/death-run-3d/logo.png",
    size: "6 MB",
  },
  {
    id: "slope",
    title: "Slope",
    author: "Indie",
    description: "An endless downhill ball-rolling run through a neon tunnel — one wrong move ends it.",
    src: "/games/slope/index.html",
    cover: "/games/slope/slope4.jpeg",
    icon: "/games/slope/logo.png",
    size: "14 MB",
  },
]

/** devon://games or devon://games/<id> → the game id ("" for the list), else null */
export function parseGamesUrl(input: string): string | null {
  const m = /^devon:\/\/games\/?([\w-]*)\/?$/i.exec(input.trim())
  return m ? m[1].toLowerCase() : null
}
