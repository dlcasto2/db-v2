# Devon Browser

A web proxy browser that runs in a browser tab. Devon has tabs, an address bar, bookmarks, history, Chrome extensions, developer tools and a built-in Games page. Pages load through Devon's own proxy.

**Official links**
- https://arcasto.911411.xyz/

Built with Next.js 16 (App Router), TypeScript, Tailwind CSS v4 and shadcn/ui.

## Features

- **Browsing:** tabs, back and forward, reload, bookmarks, history and a new tab page with shortcut tiles.
- **Search:** DuckDuckGo is the default search engine.
  - The address bar suggests searches, popular sites, and pages from your history and bookmarks.
- **Proxy:** pages, CSS and scripts are rewritten so links, forms, `fetch`/XHR, workers, iframes and `history.pushState` stay inside Devon.
  - Large scripts are compressed, or fetched in slices, so they fit under the host's response size limit.
- **Extensions:**
  - Install from the Chrome Web Store (an "Add to Devon" bar appears on extension pages).
  - Install from a `.crx`/`.zip` file, or install userscripts (`.user.js`).
  - Content scripts, popups, options pages and background scripts or service workers all run.
- **Save page offline:** saves the current page and its assets as a ZIP.
- **Media downloads:** downloads MP3, MP4, WAV and FLAC files found on the page to any device.
- **Developer tools:** built-in [Eruda](https://github.com/liriliri/eruda) console, elements, network and sources panels.
- **Page report:** the ⚠ button, or ⋮ → Page report. It lists script errors, failed requests and media on the page, and can be copied for debugging.
- **Experimental reCAPTCHA support:** a toggle in the ⋮ menu.
- **YouTube search & downloader:** open `devon://youtube`, the YouTube button on the new tab page, or ⋮ → YouTube downloader. See [YouTube](#youtube).
- **Games:** open `devon://games`, the Games button on the new tab page, or ⋮ → Games. See [Games](#games).

### Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Ctrl T | New tab |
| Ctrl L | Focus the address bar |
| Ctrl D | Bookmark page |
| Ctrl B / Ctrl H | Bookmarks / History |
| Ctrl S | Save page offline |
| Alt ← / Alt → | Back / Forward |

## Getting started

Requires Node.js 20+.

```bash
pnpm install     # or npm install
pnpm dev         # http://localhost:3000
pnpm build       # production build
pnpm start       # serve the production build
```

`postinstall` runs `scripts/copy-vendor.mjs`, which copies Eruda into `public/vendor/`.

## Deploying

Devon runs anywhere Next.js runs, and it is currently deployed on **EdgeOne Pages**.

- `app/api/proxy` is a serverless function with `maxDuration = 60`.
- EdgeOne caps a response at about 4 MB. The proxy works around this by compressing responses and splitting big scripts into slices.
- Static files under `public/` are served by the CDN, not the function.

## Project layout

| Path | What it is |
| --- | --- |
| `app/page.tsx` | The browser |
| `app/games/page.tsx` | Standalone Games page (`/games`) |
| `app/youtube/page.tsx` | Standalone YouTube page (`/youtube`) |
| `app/api/youtube/` | YouTube search, video info and chunked streaming (`search`, `info`, `stream`) |
| `components/youtube-page.tsx`, `lib/youtube.ts`, `lib/youtube-server.ts` | YouTube page UI, downloader, and the server side (youtubei.js) |
| `app/api/proxy/route.tsx` | The proxy: fetching, HTML/CSS/JS rewriting and the script injected into every page |
| `components/proxy-browser.tsx` | Browser UI: tabs, toolbar, menus, banners, extension host wiring |
| `components/new-tab-page.tsx` | New tab page |
| `components/games-page.tsx` | Games grid and player |
| `components/extensions-dialog.tsx`, `extension-page.tsx` | Extension manager, popups and options pages |
| `components/library-panel.tsx` | Bookmarks and history side panel |
| `components/save-page-dialog.tsx`, `media-downloads.tsx`, `page-problems.tsx` | Save offline, media downloads, page report |
| `lib/proxy-utils.ts` | URL formatting, search engine, proxy fetch helpers |
| `lib/suggestions.ts` | Address bar suggestions |
| `lib/extensions/` | Extension store, manifest handling, runtime (`chrome.*` APIs), page builder, URL matching, zip reader |
| `lib/page-archiver.ts` | Offline ZIP snapshots |
| `lib/devtools.ts`, `lib/diagnostics.ts`, `lib/media.ts` | Eruda, page report data, media detection |
| `lib/session-manager.ts` | Tabs, bookmarks and history in local storage |
| `lib/games.ts` | The list of games |
| `public/games/` | Game files |
| `public/devon-frame.html` | Blank same-origin page used for extension frames |

## YouTube

`devon://youtube` searches YouTube, plays videos inside Devon and downloads them.

- **Search:** type a search or paste any YouTube link (watch, youtu.be, Shorts, embed). Results load more as you scroll.
- **Watch:** plays the 360p stream in Devon's own player.
- **Download video:** every resolution YouTube offers, up to 4K. 360p already has sound and downloads directly. HD streams come without sound, so Devon downloads the video and audio and joins them in the browser with [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) (no re-encoding).
- **Download audio:** MP3 (converted in the browser, 192 kbps), or the original M4A / Opus.
- **On youtube.com:** on a video page, the download button (⤓) in the toolbar shows **Download this YouTube video**.

How it works:

- YouTube ties stream URLs to the IP that requested them. So `lib/youtube-server.ts` uses [youtubei.js](https://github.com/LuanRT/YouTube.js) to get and unlock the stream URL, and `/api/youtube/stream` fetches the bytes from the same server.
- `/api/youtube/stream` never sends more than 3 MB per response. That keeps it under EdgeOne's ~4 MB limit. It supports `Range` requests, so `<video>` can seek. The downloader fetches 3 slices at a time and joins them.
- Devon tries several YouTube clients in turn (`ANDROID_VR, TV, IOS, WEB_EMBEDDED, MWEB, WEB`). It checks that one can actually stream before using it. Set `DEVON_YT_CLIENTS` to change the order when YouTube changes what works.
- ffmpeg.wasm's small wrapper is copied to `public/vendor/ffmpeg/` by `postinstall`. The 31 MB core loads from jsDelivr the first time it's needed. Set `NEXT_PUBLIC_FFMPEG_CORE_URL` to host it elsewhere.

### Bot check ("Sign in to confirm you're not a bot")

YouTube shows this to requests from cloud and datacenter IPs, which includes EdgeOne, Vercel and most other hosts. It's about the server's IP, not Devon's code. When it happens, search still works and the page falls back to YouTube's own embedded player for watching. Downloads need one of these environment variables on the server:

| Variable | What to put in it |
| --- | --- |
| `DEVON_YT_COOKIE` | Cookies from a signed-in YouTube account. Paste either a `Cookie` header value (`SID=…; HSID=…; …`) or a whole Netscape `cookies.txt` file. Use a spare account, not your main one. |
| `DEVON_YT_PROXY` | An HTTP(S) proxy, e.g. `http://user:pass@host:port`. All YouTube traffic uses it: the API calls and the video bytes. A residential proxy works best. Datacenter proxies are usually blocked too. |

To get cookies that last: open a private/incognito window, sign in to YouTube, open `youtube.com/robots.txt` in that same tab, export the youtube.com cookies with a "cookies.txt" extension, then close the window without signing out. Signing out, or keeping on using that session, makes YouTube rotate the cookies and they stop working. After changing a variable, redeploy.

Limits: live streams, members-only, private and age-restricted videos can't be downloaded. A very long HD video can use more memory than a phone has, so pick a smaller size if one fails.

## Games

Games are served straight from `public/games/` and don't go through the proxy.

| Game | Folder | Notes |
| --- | --- | --- |
| Game Inside a Game (Unity WebGL) | `public/games/game-inside-a-game/` | Build files are gzipped and split into 3 MB parts |
| EaglercraftX 1.8 + EaglerForge | `public/games/eaglercraft/` | Built with `scripts/games/eaglercraft-build-devon.mjs` |
| Silk | `public/games/silk/` | Vite build with `--base /games/silk/` |

Large build files are gzipped, then split into parts of about 3 MB each (`*.gz.partNN`). This keeps every file well under static-hosting size limits. The game's page downloads the parts, joins them, and unzips them in the browser with `DecompressionStream`. This needs Safari 16.4+ or Chrome 80+.

### FPS

The player's **Render quality** menu sets how many pixels games draw on high-DPI (Retina) screens. The setting is passed to the game as `?renderScale=`.

| Setting | Render scale |
| --- | --- |
| Performance (default) | 1x, the highest FPS |
| Balanced | 1.5x |
| Sharp | Native resolution |

Each game handles it differently:

- **Game Inside a Game:** caps Unity's `devicePixelRatio` and asks for the high-performance GPU.
- **Silk:** caps the canvas scale. It runs on `requestAnimationFrame` with a fixed 60 steps per second.
- **Eaglercraft:** its built-in perf tweaks cap the render scale and apply fast video settings on first launch.

While a game is open, Devon also turns off the rounded clipping around the page, so the browser doesn't have to mask every frame. Fullscreen gives the best FPS.

### Adding a game

1. Put the built game in `public/games/<id>/` with an `index.html` that works from that path.
2. Add an entry to `GAMES` in `lib/games.ts` with its title, author, description, `src`, `cover`, `icon` and `size`.
3. Optionally, set `readySignal: true` if the game's page posts `{ devonGame: "ready" }` or `{ devonGame: "error", message }` to its parent. Otherwise, the frame's load event counts as ready.

### Rebuilding Eaglercraft

Copy `scripts/games/eaglercraft-build-devon.mjs` into the eaglercraft-ts project, then run:

```bash
OUT_DIR=<path to Devon>/public/games/eaglercraft node build-devon.mjs
```

## Known limitations

- **YouTube:** videos won't play on youtube.com itself, because YouTube ties video URLs to the IP address that requested them. Use `devon://youtube` to watch and download instead.
- **WebSockets:** WebSockets aren't proxied. Sites that need them for real-time features, such as some multiplayer games, may not work.
- **Anti-bot protection:** sites using it (for example HUMAN/PerimeterX) may block proxied requests.
- **Extensions:** Chrome APIs that need browser internals, such as `webRequest`, `declarativeNetRequest` and `debugger`, aren't available to extensions.
