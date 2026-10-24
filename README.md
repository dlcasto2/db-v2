# Devon Browser

A web proxy browser that runs in a browser tab. Devon has tabs, an address bar, bookmarks, history, Chrome extensions, developer tools, built-in Games and an Apps page (YouTube, Devon AI and Prompt Gen). Pages load through Devon's own proxy.

**Official links**
- https://db-v5.edgeone.dev

Built with Next.js 16 (App Router), TypeScript, Tailwind CSS v4 and shadcn/ui.

## Features

- **Browsing:** tabs, back and forward, reload, bookmarks, history and a new tab page with shortcut tiles.
- **Search:** DuckDuckGo is the preferred search engine, with Mojeek, Ecosia, Brave and Bing behind it.
  - Devon uses the first of those that actually answers from where it's deployed — see [Search](#search).
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
- **Apps:** open `devon://apps`, the Apps button on the new tab page, or ⋮ → Apps. See [Apps](#apps).
  - **YouTube** (`devon://apps/youtube`): search, watch and download. See [YouTube](#youtube).
  - **Devon AI** (`devon://apps/ai`, or the ✦ toolbar button to open it next to a page): a chat assistant that can read and use the page you have open (click, type, choose, scroll, open tabs, with your permission per site), keeps a session state for multi-step tasks, and runs code in a sandbox. See [Devon AI](#devon-ai).
  - **Prompt Gen** (`devon://apps/prompt-gen`): turns a rough idea into ready-to-use prompts, offline.
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

Devon runs anywhere Next.js runs, and it is currently deployed on both **EdgeOne Pages** and **Vercel**. Devon AI's chat has two independent backends: EdgeOne Makers agents (the `agents/` and `cloud-functions/` folders, configured in `edgeone.json`) on EdgeOne, and the `app/ai-*/route.ts` routes (backed by Redis, see "Devon AI" below) everywhere else, including Vercel. On a host with neither set up, Devon AI says it isn't deployed; everything else works regardless.

- `app/api/proxy` is a serverless function with `maxDuration = 60`.
- EdgeOne caps a response at about 4 MB. The proxy works around this by compressing responses and splitting big scripts into slices.
- Static files under `public/` are served by the CDN, not the function.
- **Devon is not a static site.** Don't set `output: "export"` in `next.config.mjs`: the proxy, the YouTube routes and the page-safety route run on the server, and the export fails on the first of them (and the EdgeOne CLI then reports "No server-handler detected, generating routes.json for pure project"). For a github.io address, publish a small page that shows Devon running on the server instead.

## Project layout

| Path | What it is |
| --- | --- |
| `app/page.tsx` | The browser |
| `app/games/page.tsx` | Standalone Games page (`/games`) |
| `app/youtube/page.tsx` | Standalone YouTube page (`/youtube`) |
| `app/api/youtube/` | YouTube search, video info, chunked streaming and a settings check (`search`, `info`, `stream`, `status`); `cookie` only clears cookies from older builds |
| `components/youtube-page.tsx`, `lib/youtube.ts`, `lib/youtube-server.ts` | YouTube page UI, downloader, and the server side (youtubei.js) |
| `app/api/proxy/[[...path]]/route.tsx` | The proxy: fetching, HTML/CSS/JS rewriting and the script injected into every page. JavaScript modules load from `/api/proxy/m/<scheme>/<host>/<path>`, which keeps the real folder layout so `import.meta.url` (and the asset paths bundlers build from it) resolve correctly |
| `components/proxy-browser.tsx` | Browser UI: tabs, toolbar, menus, banners, extension host wiring |
| `components/new-tab-page.tsx` | New tab page |
| `components/games-page.tsx` | Games grid and player |
| `components/extensions-dialog.tsx`, `extension-page.tsx` | Extension manager, popups and options pages |
| `components/library-panel.tsx` | Bookmarks and history side panel |
| `components/save-page-dialog.tsx`, `media-downloads.tsx`, `page-problems.tsx` | Save offline, media downloads, page report |
| `lib/proxy-utils.ts` | URL formatting, search engine, proxy fetch helpers |
| `lib/search-engines.ts` | The search engines Devon tries, and how it spots a block page |
| `lib/suggestions.ts` | Address bar suggestions |
| `lib/extensions/` | Extension store, manifest handling, runtime (`chrome.*` APIs), page builder, URL matching, zip reader |
| `lib/page-archiver.ts` | Offline ZIP snapshots |
| `lib/devtools.ts`, `lib/diagnostics.ts`, `lib/media.ts` | Eruda, page report data, media detection |
| `lib/session-manager.ts` | Tabs, bookmarks and history in local storage |
| `lib/account.ts`, `cloud-functions/_auth/` | Account client, and the OIDC/session logic shared by both backends below (`authConfig`, cookie signing, `readSyncRaw`/`writeSyncRaw`) — written against `process.env` and Web `Request`/`Headers`, not EdgeOne itself, so both backends use it unchanged |
| `cloud-functions/auth-*`, `cloud-functions/account-sync/` | Auth0 (OIDC) sign-in and cross-device sync, **on EdgeOne** (`/auth-login`, `/auth-callback`, `/auth-me`, `/auth-logout`, `/account-sync`) |
| `app/auth-*/route.ts`, `app/account-sync/route.ts` | Same routes, **on Vercel** — against `lib/devon-ai/server/store.ts` (Redis) instead of EdgeOne's `context.agent.store` |
| `lib/games.ts` | The list of games |
| `components/apps-page.tsx`, `lib/apps.ts` | The Apps page and the list of apps |
| `components/devon-ai-page.tsx`, `lib/devon-ai/` | Devon AI's chat UI, its backend calls, chat state and browser storage |
| `agents/ai-chat/`, `agents/ai-stop/`, `agents/_quota.ts`, `agents/_model.ts` | Devon AI's EdgeOne agent routes (`/ai-chat`, `/ai-stop`), daily limit and model settings |
| `agents/ai-chat/_devon-tools.ts`, `agents/_mailbox.ts`, `agents/_session.ts`, `agents/_feedback.ts` | Page and tab tools, how their results come back, the session state, and the feedback log. Written against `Pick<AgentMemory, ...>` shapes, not EdgeOne itself, so `app/ai-chat/route.ts` (and `app/ai-feedback/route.ts`) reuse them unchanged against a Redis store on Vercel. `cloud-functions/_feedback.ts` is a byte-for-byte copy of `agents/_feedback.ts` — EdgeOne bundles cloud functions and agent routes as separate deployment units, so `cloud-functions/ai-feedback` can't import across that boundary (the same reason `_logger.ts`/`_redact.ts` exist in both folders) |
| `cloud-functions/ai-*` | Devon AI's EdgeOne chat history, chat list, delete, page results and session (`/ai-history`, `/ai-conversations`, `/ai-delete-conversation`, `/ai-page-result`, `/ai-session`) |
| `app/ai-chat/`, `app/ai-stop/`, `app/ai-history/`, `app/ai-conversations/`, `app/ai-delete-conversation/`, `app/ai-page-result/`, `app/ai-session/` | Devon AI's Vercel-native routes — same paths and request/response shapes as the EdgeOne ones above, so `lib/devon-ai/` doesn't change; each has a comment pointing at its EdgeOne counterpart |
| `lib/devon-ai/server/store.ts`, `lib/devon-ai/server/kv.ts` | The Redis-backed store the Vercel routes use in place of EdgeOne's `context.store` |
| `lib/devon-ai/server/sandbox-tools.ts` | Vercel's shell/files/code-interpreter tools — an E2B sandbox standing in for EdgeOne's built-in ones |
| `lib/devon-ai/page-actions.ts`, `lib/devon-ai/page-executor.ts` | Reading and acting on pages in the browser, and running the page tools against Devon's tabs |
| `.claude/skills/` | Skills Devon AI's agent can load |
| `components/prompt-gen-page.tsx`, `lib/prompt-gen.ts` | Prompt Gen |
| `public/games/` | Game files |
| `public/devon-frame.html` | Blank same-origin page used for extension frames |

## Search

Typing something that isn't an address searches the web. Which engine answers
that search is decided per deployment, not in the code, because search engines
refuse requests from datacenter addresses and they don't all refuse the same
ones — DuckDuckGo answers from some hosts and returns its "Unexpected error.
Please try again." page from others (Vercel among them), while Bing answers
from both.

So the first search on a server instance asks `/api/search`, which tries the
engines in [`lib/search-engines.ts`](lib/search-engines.ts) in order with a
stand-in query and keeps the first that answers for half an hour. Every search
after that is answered from memory, and the address bar shows that engine's
own results URL.

An engine counts as answering when its page links out to at least six other
sites. That's the one difference between a results page and a block page that
holds across every engine and survives their markup changes — a results page
links out to dozens of sites, a CAPTCHA or error page to none. Matching on the
wording of block pages would also misfire on a search *for* those words.

To pin one engine instead, call `/api/search?q=…&engine=<id>` with an id from
that file (`ddg`, `mojeek`, `ecosia`, `brave`, `bing`); that skips the probe.
If `/api/search` can't be reached at all, Devon falls back to DuckDuckGo.

Address-bar *suggestions* are separate, and come from DuckDuckGo's autocomplete
and Instant Answer endpoints through the proxy. Those answer from datacenter
addresses even where the results page doesn't, so they're left alone.

## Apps

`devon://apps` lists Devon's built-in apps, laid out like the Games page. Each opens in a tab like any site.

| App | Address | What it does |
| --- | --- | --- |
| Devon AI | `devon://apps/ai` | Chat assistant with sandbox tools and page questions. Needs setup, see [Devon AI](#devon-ai). |
| YouTube | `devon://apps/youtube` | Search, watch and download YouTube videos. The old `devon://youtube` addresses still open it. |
| Prompt Gen | `devon://apps/prompt-gen` | Write an idea, pick a type (Ask, Write, Code, Image, Study, Plan), tone and detail, and get three prompts. **Remix** rewords them. Runs entirely in the browser. **Send to Devon AI** puts a prompt in Devon AI's message box. |

## Devon AI

Devon AI is the [Claude Agent Starter](https://github.com/TencentEdgeOne/claude-agent-starter-node) (MIT) brought into Devon: the Claude Agent SDK, with Devon's own page tools and the platform's conversation store. It has two backends, picked by where Devon is deployed, not by anything in the request:

- **On EdgeOne** (`agents/`, `cloud-functions/ai-*`): runs as an EdgeOne Makers agent, with EdgeOne's sandbox tools (shell commands, files, a code interpreter and a headless browser) on top of the page tools below, and EdgeOne's own conversation store.
- **Everywhere else, including Vercel** (`app/ai-*/route.ts`): the same Claude Agent SDK call and the same page tools, backed by Redis instead of EdgeOne's store (see "Vercel setup" below). Shell commands, files and a code interpreter are available here too (same tool names as EdgeOne) — but since running them directly in another host's serverless function would reach that function's real environment, not an isolated sandbox, they run in a throwaway [E2B](https://e2b.dev) sandbox instead, one per conversation, with no internet access by default and nothing from the site's own files or secrets in it. Set `E2B_API_KEY` to turn them on; without it, Devon AI here still answers with the page tools alone. **Still not available on this backend:** EdgeOne's headless "browser" sandbox tool and project skills, and Claude CLI session resume between turns (EdgeOne-specific); instead each turn's prompt includes a short plain-text recap of recent messages, which covers ordinary multi-turn chat but not the model's own prior tool-call reasoning.

Devon's version adds, on both backends:

- **Side panel:** the ✦ toolbar button opens Devon AI next to the page, so you can watch it work.
- **Page actions:** Devon AI can use the tabs you have open — list, open and switch tabs; read a page (its text and its links, buttons and fields, numbered); click, type, choose dropdown options, scroll, and go to an address, back or forward. It works on the visible site tab (or the last one you used), outlines each element it touches, and shows a "Devon AI is using this tab" bar with a Stop button.
  - Clicking, typing and choosing ask first: **Allow**, **Allow on this site for this chat**, or **Deny**. Reading, scrolling and opening pages don't ask. Something that looks hard to undo — buying, paying, deleting, sending, canceling (matched against the element's real name, not the model's own wording) — always gets a fresh **Allow**/**Deny** prompt, even on a site you already allowed for ordinary clicks (no "allow on this site" option appears for those).
  - Before touching an element, Devon checks whether something else — a modal, cookie banner or other overlay — is actually on top of it at that point, and refuses with a clear message instead of silently clicking the wrong thing. After clicking, typing, choosing or navigating, Devon AI compares the page before and after (which elements appeared, disappeared or changed state; price- or availability-looking text) and gets a "What changed: …" line, or an explicit "nothing visibly changed" — so it reports an action as done because the page confirms it, not just because the tool call returned.
  - Devon refuses to type into password, verification-code and payment fields, and won't choose files to upload. The agent is told not to buy, send, post, delete or change settings unless you asked for exactly that, and to treat page text as untrusted.
  - How it works: the agent's page tools send a `page_action` event down the chat stream; Devon runs it in your tab and posts the result to `/ai-page-result`, which drops it in the chat's mailbox in the platform store, where the waiting tool picks it up. That works whichever server instances the requests reach.
- **Session state:** each chat keeps a session the agent maintains while it works, separate from the conversation transcript — the task, its steps, settled **notes** (facts worth keeping: prices, names, decisions), **open questions** (things still unresolved, to come back to), and the pages it used, each with a short **page state** snapshot of what was true there last (e.g. "cart: 2 items, $45.98") — saved in the platform's conversation-scoped store. Devon also sends its own side of the session (your open tabs and which one Devon AI acts on) with every message. The **Session** button shows all of it plus the sites you allowed, and **Clear** forgets it.
- **Ask about this page:** ⋮ → Ask Devon AI about this page opens the panel with the page's address, title and visible text attached to your next question (up to 12,000 characters reach the model). Only the question is saved in the chat history.
- **A daily limit per visitor**, counted on the server so refreshing, new chats or new tabs don't reset it. See below.
- **Feedback:** every reply gets a thumbs up/down (hover a reply to see it). Down opens a reason chip (wrong fact · misread the page · bad/unsafe action · other) and an optional short note. It's logged as a small, append-only entry — model, a rough task-type label, the rating, the reason chip and note, a timestamp — never the page or the conversation itself, and reviewed by the site's maintainer as an aggregate digest (`POST /ai-feedback` with `{"action":"digest","admin_key":...}`), not a notification per click. See `agents/_feedback.ts`.
- Chats keep streaming when you switch tabs, and links in replies open in a new Devon tab.

Routes (same on both backends, so the client — `lib/devon-ai/`  — doesn't know or care which one answers): `POST /ai-chat` (SSE stream, needs the `makers-conversation-id` header), `POST /ai-stop`, `POST /ai-history`, `POST /ai-conversations`, `POST /ai-delete-conversation`, `POST /ai-page-result` (page action results), `POST /ai-session` (read or clear a chat's session; chat ID in the header), `POST /ai-feedback` (record a thumbs up/down, or — with the admin key — read the digest). On EdgeOne, agent runs may take up to 600 s (`edgeone.json`), since page tasks can wait on your permission; on Vercel, `app/ai-chat/route.ts` sets `maxDuration = 300`, but your Vercel plan's own function-duration limit may cap that lower.

Without a model key, Devon AI shows "isn't set up on this site yet". A visitor is identified by an ID kept in their browser's local storage; the counts themselves are stored on the server, so they can't be reset from the page. `DEVON_*` variables are never passed to the agent's Claude process.

### EdgeOne setup

Set these in the EdgeOne project's environment variables, then redeploy:

| Variable | Meaning |
| --- | --- |
| `AI_GATEWAY_API_KEY` | Model gateway key: a Makers Models API key (Makers → Models → API Key) or another Anthropic-compatible gateway. Required unless `ANTHROPIC_API_KEY` is set. |
| `AI_GATEWAY_BASE_URL` | Gateway URL, e.g. `https://ai-gateway.edgeone.link/v1` for Makers Models. |
| `AI_GATEWAY_MODEL` | Model to use. Defaults to `@makers/deepseek-v4-flash`, the free built-in Makers model. |
| `ANTHROPIC_API_KEY` | Instead of a gateway, call the Anthropic API directly (defaults to `claude-haiku-5-5`; set `CLAUDE_MODEL` to change it). |
| `DEVON_AI_DAILY_LIMIT` | Messages each visitor can send per day (resets at midnight UTC). Default `30`; `0` turns the limit off. |
| `DEVON_AI_IP_DAILY_LIMIT` | Optional shared cap per network address per day (default `0` = off). It stops people dodging the visitor limit with private windows, but everyone on one school or office network shares it, so set it well above the visitor limit. |
| `DEVON_AI_ADMIN_KEY` | Optional. Set it to read the feedback digest (`POST /ai-feedback` with `{"action":"digest","admin_key":...}`). Unset means the digest is refused for everyone — there's no "open by default" state. |
| `WSA_API_KEY` | Only for the agent's web search tool ([how to get one](https://pages.edgeone.ai/document/sandbox-network-search-tool)). |

Counts live as small hashed entries in EdgeOne's conversation store.

To run the agent locally, use the EdgeOne CLI: `npm i -g edgeone`, `edgeone makers link`, then `edgeone makers dev` (serves the site and the agent routes together). `pnpm dev` runs the site without the agent routes.

### Vercel setup

`app/ai-*/route.ts` need somewhere durable to keep quota counts, chat history, session state and page-action results — Vercel has nothing built in for that, so they use Redis (`lib/devon-ai/server/`). Set these in the Vercel project's environment variables, then redeploy:

| Variable | Meaning |
| --- | --- |
| `ANTHROPIC_API_KEY` | Call the Anthropic API directly (defaults to `claude-haiku-5-5`; set `CLAUDE_MODEL` to change it), or set `AI_GATEWAY_API_KEY` + `AI_GATEWAY_BASE_URL` (and optionally `AI_GATEWAY_MODEL`) to use a gateway instead — same variables as EdgeOne above. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | A Redis database's REST credentials. Add "Upstash for Redis" from Vercel's Storage/Marketplace tab (sets these for you), or create one directly at [upstash.com](https://upstash.com) (there's a free tier) and paste its REST URL and token in. `KV_REST_API_URL`/`KV_REST_API_TOKEN` (the older Vercel KV naming) also work. |
| `DEVON_AI_DAILY_LIMIT`, `DEVON_AI_IP_DAILY_LIMIT`, `DEVON_AI_ADMIN_KEY` | Same as EdgeOne above. |
| `E2B_API_KEY` | Turns on the sandbox tools (shell, files, code interpreter — see the backend comparison above). Get one at [e2b.dev](https://e2b.dev) (there's a free tier). Without it, Devon AI still answers with the page tools alone. |
| `DEVON_AI_SANDBOX_DAILY_LIMIT` | How many *new* sandboxes each visitor can start per day (default `5`; `0` = no limit). Reconnecting to a conversation's existing sandbox doesn't count — this only limits how often someone can start fresh ones, since each one costs E2B credits. |
| `DEVON_AI_SANDBOX_ALLOW_NETWORK` | Set to `1` to give the sandbox outbound internet access (`pip install`, fetching a URL, …). Off by default — math, data work and charts don't need it. |

Without Redis, Devon AI still answers each message — quota, chat history, session state and the conversation list just don't persist between requests (`lib/devon-ai/server/kv.ts` returns `null` and every caller degrades the same way the EdgeOne agents already do when their own store hiccups). **Not available on Vercel** (see the backend comparison above): EdgeOne's headless "browser" sandbox tool, project skills, and Claude CLI session resume (recent turns are recapped in the prompt as plain text instead — see `app/ai-chat/route.ts`).

`next.config.mjs`'s `outputFileTracingIncludes` bundles the Claude CLI's native binary (`@anthropic-ai/claude-agent-sdk-linux-x64*`) with the `ai-chat` function — Vercel's build-time file trace misses it otherwise, since the SDK resolves it at runtime rather than importing it.

## Accounts

Sign in to Devon to sync your **bookmarks, history and settings** across devices. Sign-in goes through **Auth0** (an OpenID Connect provider), which can front Google and other logins. Like Devon AI, this has two backends, picked by where Devon is deployed, not by anything in the request: **EdgeOne** (`cloud-functions/auth-*`, `cloud-functions/account-sync/`), against the Makers store, and **everywhere else, including Vercel** (`app/auth-*/route.ts`, `app/account-sync/route.ts`), against Redis — see "Vercel setup" below. The OIDC/session logic itself (`cloud-functions/_auth/`) is shared unchanged by both; only the per-user data store differs. Where neither is set up, the sign-in control simply doesn't appear and Devon keeps everything in the browser as before.

This signs you in to **Devon**, on Auth0's own login screen — it does **not** log you in to Google (or anything else) on sites you open through the proxy. A proxy can only keep you "signed in" to a site by passing your password and session through Devon's server, which on a shared deployment would collect every visitor's login; providers block it too. So the account is Devon's own. No provider token ever reaches the browser, and the only thing the browser carries is a signed session cookie.

To offer "Sign in with Google", add Google as a **social connection** in Auth0 and enable it for the application — Auth0 handles the Google side, and Devon only ever talks to Auth0.

### How it works

- **Sign-in** is OpenID Connect with PKCE. `/auth-login` creates the CSRF state, nonce and PKCE verifier, keeps them in a short-lived signed `HttpOnly` cookie, and sends you to Auth0's `/authorize`. `/auth-callback` checks the state, swaps the code for tokens **server-to-server** at Auth0's `/oauth/token` (the client secret and verifier never touch the browser), reads your identity from the ID token (checking issuer, audience, expiry and nonce), and sets Devon's own signed session cookie.
- **Sync** (`/account-sync`) stores your bookmarks/history/settings — in the Makers store on EdgeOne, in Redis on Vercel — under a namespace derived from a SHA-256 of your subject (`sub`) — taken from the session cookie, never from anything the browser sends — so an account can only ever read or write its own data. On sign-in the browser's copy and the server's are merged (union by id, newest wins; history also de-duplicated by URL); later changes are pushed up, debounced.
- The session cookie is signed with HMAC-SHA256; a tampered or expired cookie is rejected.

### Setup

1. In the [Auth0 dashboard](https://manage.auth0.com/), create an **Application** of type **Regular Web Application**.
2. In its settings, add an **Allowed Callback URL** for each host Devon runs on: `https://<your-host>/auth-callback` (for example `https://db-v5.edgeone.dev/auth-callback`). Add the host's root to **Allowed Logout URLs** too.
3. (Optional) Under **Authentication → Social**, add a **Google** connection and enable it for this application, so the login screen offers "Continue with Google".
4. Set these variables on whichever host(s) Devon runs on, then redeploy. The three `DEVON_AUTH0_*` values are the same everywhere a given Auth0 application is used; set them once per host.

**On EdgeOne**, in the project's environment variables:

| Variable | What it is |
| --- | --- |
| `DEVON_AUTH0_DOMAIN` | The tenant domain, e.g. `your-tenant.us.auth0.com` (scheme and path are ignored). |
| `DEVON_AUTH0_CLIENT_ID` | The application's client ID (public). |
| `DEVON_AUTH0_CLIENT_SECRET` | The application's client secret (server-only; never sent to the browser). |
| `DEVON_AUTH_SECRET` | A random string used to sign the session cookie. Optional — falls back to the client secret — but setting your own means rotating the client secret doesn't sign everyone out. |
| `DEVON_PUBLIC_ORIGIN` | Optional. The address browsers use, e.g. `https://db-v5.edgeone.dev`. Only the OAuth redirect URI needs an absolute address, and the Devon page states its own origin when it sends you to `/auth-login`, so this normally isn't needed. Set it to pin the value regardless of what the browser says. |

**On Vercel**, in the project's environment variables: the same four `DEVON_AUTH0_*`/`DEVON_AUTH_SECRET` variables above, plus Redis for `/account-sync` to actually persist anything — the same `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` (or `KV_REST_API_URL`/`KV_REST_API_TOKEN`) credentials Devon AI's chat history already uses on Vercel (see "Vercel setup" above); if Devon AI is already set up there, sign-in and sync share that same database with no extra setup. `DEVON_PUBLIC_ORIGIN` is rarely needed here: Vercel reports a request's real public host directly, unlike EdgeOne's internal one (see below), so the automatic detection already gets it right.

`/auth-me` reports `{"enabled":true}` once the three `DEVON_AUTH0_*` values are set, and the sign-in control appears. Without Redis configured on Vercel, sign-in still works, but `/account-sync` reports itself unavailable and bookmarks/history/settings stay local to each browser, same as a deployment with no account backend set up at all.

**On hosts that hide the public address.** EdgeOne runs these functions behind its CDN and reports an internal host (`…pages-scf….qcloudteo.com`) as the request's origin — it sends no `X-Forwarded-Host` either. Building the OAuth redirect URI from that gets the login rejected for a callback mismatch. So Devon's page states its own origin on the way to `/auth-login`, and that value is carried through the signed state cookie to the token exchange. It is used *only* for the redirect URI, which Auth0 checks against the application's Allowed Callback URLs, so a made-up one is refused rather than followed; every redirect Devon sends a visitor is relative, so there's no origin to point elsewhere. The `origin` field in `/auth-me` shows what the server would work out on its own, which is useful for spotting this, and `DEVON_PUBLIC_ORIGIN` pins it if you'd rather not rely on the page. Register callback URLs against your **stable** host, not EdgeOne's per-build `*-xxxx.edgeone.app` preview host, which changes each deploy.

## YouTube

`devon://apps/youtube` searches YouTube, plays videos inside Devon and downloads them.

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

- **YouTube:** videos won't play on youtube.com itself, because YouTube ties video URLs to the IP address that requested them. Use `devon://apps/youtube` to watch and download instead.
- **WebSockets:** WebSockets aren't proxied. Sites that need them for real-time features, such as some multiplayer games, may not work.
- **Anti-bot protection:** sites using it (for example HUMAN/PerimeterX) may block proxied requests.
- **Extensions:** Chrome APIs that need real browser internals aren't backed by anything real. `webRequest`, `declarativeNetRequest` and `debugger` exist on `chrome.*` so extensions that merely check for or call them don't throw, but none of them actually intercepts or blocks a request, and `debugger.attach` rejects outright (there's no DevTools protocol to attach to). An ad blocker built on `declarativeNetRequest` installs cleanly but won't block anything.


## Page safety check

Uses Jev, TypeSafe AI's decision model (no text generation; it returns typed probabilities in ~70–500 ms). The key stays on the server in `app/api/jev`.

| Variable | Meaning |
| --- | --- |
| `DEVON_JEV_API_KEY` | TypeSafe API key (or an OpenRouter key with the setting below). Without it the feature is hidden. |
| `DEVON_JEV_BACKEND` | `typesafe` (default) or `openrouter` (no TypeSafe waitlist needed) |
| `DEVON_JEV_MODEL` | Defaults to `jev-latest` (`typesafe/jev-1.13` on OpenRouter) |
| `DEVON_JEV_BASE_URL` | Optional endpoint override |

Each page check asks five questions in one request: page category (Choice), phishing, scam and domain-matches-brand (Noul), and site trust (Score, 4 levels). `decide()` in `app/api/jev/route.ts` turns those into safe / caution / danger, so thresholds are easy to tune. Results are cached for 15 minutes per URL and limited to 30 checks per visitor per minute.
