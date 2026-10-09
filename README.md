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
- **Page safety check (Jev):** after a page loads, its address and visible text go to [TypeSafe Jev](https://docs.typesafe.ai) in one call, which returns the page category plus phishing, scam, brand-match and trust probabilities. A shield in the toolbar shows the verdict, and a red banner appears on dangerous pages. Toggle it in ⋮ → Experimental → Page safety check. See [Page safety check](#page-safety-check).
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
| `app/api/youtube/` | YouTube search, video info, chunked streaming and a settings check (`search`, `info`, `stream`, `status`); `cookie` only clears cookies from older builds |
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
- **Watch:** the **Through Devon** player (default) never connects the viewer to YouTube. If the download server can stream the video, it plays in Devon's own `<video>` player from `/api/youtube/stream`; otherwise the `youtube-nocookie.com` player is loaded through Devon's proxy (`/api/proxy`). **Direct** loads `youtube-nocookie.com` from the viewer's own connection. The choice is remembered per browser.
- **Download video:** every resolution YouTube offers, up to 4K. 360p already has sound and downloads directly. HD streams come without sound, so Devon downloads the video and audio and joins them in the browser with [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) (no re-encoding).
- **Download audio:** MP3 (converted in the browser, 192 kbps), or the original M4A / Opus.
- **On youtube.com:** on a video page, the download button (⤓) in the toolbar shows **Download this YouTube video**.

How it works:

- Watching runs inside the `youtube-nocookie.com` embed. Downloads are a separate anonymous server request: `lib/youtube-server.ts` uses [youtubei.js](https://github.com/LuanRT/YouTube.js) to get a stream URL, and `/api/youtube/stream` fetches the bytes from the same server IP. The embed does not expose downloadable files.
- `/api/youtube/stream` never sends more than 3 MB per response. That keeps it under EdgeOne's ~4 MB limit. The downloader fetches 3 slices at a time and joins them.
- Devon tries several YouTube clients in turn (`TV_EMBEDDED, WEB_EMBEDDED, TV_SIMPLY, ANDROID_VR, TV, IOS, MWEB, WEB`). It checks that both video and audio bytes stream before showing download options. A bot check or "video unavailable" response from one client does not stop the others. If every client fails, Devon reports a download-server problem without claiming the video itself is unavailable. Set `DEVON_YT_CLIENTS` to change the order when YouTube changes what works.
- ffmpeg.wasm's small wrapper is copied to `public/vendor/ffmpeg/` by `postinstall`. The 31 MB core loads from jsDelivr the first time it's needed. Set `NEXT_PUBLIC_FFMPEG_CORE_URL` to host it elsewhere.

### Bot check ("Sign in to confirm you're not a bot")

YouTube often refuses download requests from cloud and datacenter IPs, including EdgeOne's. When every YouTube client is refused, Devon tries these, in order:

1. **A cookie saved in the browser.** On the YouTube page, click **Add cookie** (or **Add YouTube cookie** on the "Downloads are unavailable" message) and paste the `cookie:` request header from a signed-in youtube.com tab (the box shows the steps). It's stored as HttpOnly cookies that only `/api/youtube` receives, so pages can't read it and it never goes into the repo. It only applies in the browser where it was pasted. Use a spare account.
2. **Invidious relays.** If YouTube still refuses, Devon asks public [Invidious](https://docs.invidious.io/instances/) instances (all at once) for the video with `local=true`, so the instance fetches it from YouTube with its own IP and relays the bytes. Public instances come and go and are often rate-limited or blocked themselves, so this may or may not work on a given day. Set `DEVON_INVIDIOUS` to a comma-separated list of instance URLs (for example your own instance), or to `off`.

Server-wide settings (environment variables). Devon reads them from the running site first and falls back to the values the build saw, so they work on hosts that only give variables to one or the other. Redeploy after changing them:

| Variable | What it does |
| --- | --- |
| `DEVON_YT_COOKIE` | A signed-in YouTube cookie for everyone who uses the server: a `Cookie` header value, a Netscape `cookies.txt`, or a cookie extension's JSON export. Surrounding quotes are ignored. |
| `DEVON_YT_COOKIE_B64` | The same cookie, base64-encoded, for settings forms that mangle `;` or `=`. |
| `DEVON_YT_COOKIE_1`, `_2`, … | The cookie split into pieces (joined in order), for hosts that limit how long a value can be. |
| `DEVON_YT_PROXY` | An HTTP(S) proxy (`http://user:pass@host:port`) for all YouTube traffic. A residential proxy works best. |
| `DEVON_INVIDIOUS` | Invidious instances to relay through, comma-separated, or `off`. |
| `DEVON_YT_CLIENTS` | The order of YouTube clients to try. |

`/api/youtube/status` shows which of these are set (never the values): for the cookie, which variable it came from, whether it was seen by the running site (`"source":"runtime"`) or the build (`"build"`), how many characters arrived and whether the sign-in cookie is there. `envSeen` lists every `DEVON_*` variable name the host passed in, which shows whether a variable reached Devon at all.

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


## Page safety check

Uses Jev, TypeSafe AI's decision model (no text generation; it returns typed probabilities in ~70–500 ms). The key stays on the server in `app/api/jev`.

| Variable | Meaning |
| --- | --- |
| `DEVON_JEV_API_KEY` | TypeSafe API key (or an OpenRouter key with the setting below). Without it the feature is hidden. |
| `DEVON_JEV_BACKEND` | `typesafe` (default) or `openrouter` (no TypeSafe waitlist needed) |
| `DEVON_JEV_MODEL` | Defaults to `jev-latest` (`typesafe/jev-1.13` on OpenRouter) |
| `DEVON_JEV_BASE_URL` | Optional endpoint override |

Each page check asks five questions in one request: page category (Choice), phishing, scam and domain-matches-brand (Noul), and site trust (Score, 4 levels). `decide()` in `app/api/jev/route.ts` turns those into safe / caution / danger, so thresholds are easy to tune. Results are cached for 15 minutes per URL and limited to 30 checks per visitor per minute.
