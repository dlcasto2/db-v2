# Devon Browser — Windows desktop app

A [Tauri](https://v2.tauri.app/) shell around Devon itself. There's no
separate "desktop frontend": on launch, the app starts Devon's actual
Next.js server as a bundled Node sidecar, waits for it to come up on a local
port, and points its window at `http://127.0.0.1:<port>/`. Devon runs
exactly as it does on EdgeOne or Vercel — proxy, tabs, bookmarks, games,
YouTube — just served from the machine it's installed on instead of a
server you deploy to.

## Why Tauri + a bundled Node sidecar, specifically

Devon needs a real Node server (see the root `README.md`'s "Deploying"
section — the proxy, YouTube and page-safety routes aren't static), and
requires Node.js 20+. Tauri's own window is just a thin, OS-native wrapper
around that — it doesn't reimplement anything.

This build targets **Windows 10/11**, not Windows 7: Next.js 16 requires
Node 20.9+, and nothing currently gets Node past ~18.17 on real Windows 7
even with unofficial patches, so a genuinely-Windows-7-compatible build of
*this* app isn't achievable right now regardless of which shell wraps it.
If that changes (Devon moves back to an older Next.js, or Node grows a real
Windows 7 story again), the Tauri side of this doesn't need to change — only
`desktop/scripts/prepare-standalone.mjs`'s Node version would.

## The other build: static, no server at all

There's a second, separate installer — **Devon Browser (Static)** — built
from the same checkout via `pnpm build:static` (or the second half of the
`desktop-windows` CI run, see below). It has no Node sidecar and no server
of any kind: `scripts/prepare-static.mjs` builds Devon with `next build
--output export` instead, producing a plain folder of static HTML/CSS/JS,
and Tauri's window loads that directly — nothing to spawn, nothing to wait
for, nothing that can get "stuck starting."

The trade-off is real, not cosmetic: Devon's proxy, YouTube downloads,
page-safety checks, Devon AI chat, and sign-in all run on the server, and
there isn't one in this build, so none of them work. Concretely,
`prepare-static.mjs` physically removes `app/api/**` and every
`app/<name>/route.ts` directory (auth, Devon AI, account sync) from the tree
before this one build, because Next's static export refuses to build with
them present at all — then puts them straight back, whether the build
succeeded or not. What's left and still works: the browser UI shell itself,
`/games`, and `/youtube` (the page, not downloading — that's the part that
needs a server).

Pick this one if you want the lightest possible installer and don't need
those features; pick the regular one (the rest of this file) if you do. Both
builds share the same Rust crate, split by the `static-build` Cargo feature
— see `src-tauri/src/lib.rs`'s two `run()` functions and
`src-tauri/tauri.static.conf.json` (merged onto the base `tauri.conf.json`
via `tauri build --config`, same mechanism `pnpm build:static` uses).

## Building it

You need [Rust](https://rustup.rs/) and Node 20+ installed. From the repo
root:

```bash
pnpm install              # Devon's own deps
pnpm --dir desktop install  # the Tauri CLI
```

Then, from `desktop/`:

```bash
pnpm dev          # cargo tauri dev   — runs Devon locally and opens a dev window
pnpm build        # cargo tauri build — produces the server-backed installer
pnpm build:static # produces the static, no-server installer (see above)
```

Either command first runs `scripts/prepare-standalone.mjs`, which builds
Devon with `next build` (gated to `output: "standalone"` via the
`DEVON_DESKTOP_BUILD` env var — see `next.config.mjs` — so this doesn't
affect the EdgeOne/Vercel deploys) and stages the result, plus `.next/static`
and `public/` (which `output: "standalone"` deliberately leaves out — see
[Next's docs](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)),
at `src-tauri/resources/app/`. `tauri build` then bundles that folder into
the installer as a resource directory.

**The Node sidecar itself isn't in this repo.** Tauri calls it a "sidecar":
an external binary your app bundles so people don't need to install Node
themselves. It has to be the real `node.exe` for whatever OS/architecture
you're building for, named
`src-tauri/binaries/node-<target-triple>.exe` — e.g. for 64-bit Windows,
`src-tauri/binaries/node-x86_64-pc-windows-msvc.exe`. `.github/workflows/desktop-windows.yml`
does this by just copying the Windows runner's own `node` binary into place
before `tauri build`; if you're building locally on Windows, copy your own
`node.exe` there the same way (`Copy-Item (Get-Command node).Source
src-tauri\binaries\node-x86_64-pc-windows-msvc.exe`). Without it, `tauri
build` fails with a missing-sidecar error, and `tauri dev` fails at
startup with "Could not find Devon's standalone build" — same fix either
way.

### Building the real installer

The `desktop-windows` GitHub Actions workflow (`workflow_dispatch`, and on
pushes to `main` that touch Devon or `desktop/`) builds this on a
`windows-latest` runner, producing *both* installers (server-backed and
static) and uploading each `.exe` (NSIS) as its own workflow artifact —
that's the easiest way to get an actual, working Windows build without
owning a Windows machine yourself. It also publishes both to the
`desktop-app-preview` GitHub Release, which is the easier of the two to
actually download (workflow artifacts need you to be signed into GitHub and
go through Azure Blob Storage; the Release doesn't).

## Devon AI, Auth0 sign-in, and other things that need secrets

None of Devon's API keys or service credentials are baked into this build.
Per the root README, Devon degrades gracefully without them — Devon AI
reports it "isn't deployed," sign-in simply isn't offered, YouTube still
works without cookies in most cases — so the installed app is fully usable
out of the box; those features are just off.

To turn them on for your own build, create a file at (replace
`net.lovedub.devon-browser` if you changed `identifier` in
`tauri.conf.json`):

- Windows: `%APPDATA%\net.lovedub.devon-browser\devon.env`

with the same `KEY=value` pairs as the root `.env.example` (one per line,
`#` for comments) — whichever of Devon AI's model keys, `UPSTASH_REDIS_REST_URL`
/ `UPSTASH_REDIS_REST_TOKEN` for persistence, or Auth0 settings you want.
The app reads this file on every launch and passes those variables to
Devon's server; no rebuild needed. This is a plain-text file on the
person's own machine, same trust level as any desktop app's local config —
don't ship a build with real secrets in it.

One thing that *can't* be turned on this way: the Claude-CLI-backed
`/ai-chat` route (see root README → "Devon AI") spawns the Claude Agent
SDK's own CLI binary, which `next.config.mjs` only includes in the trace
for real Vercel builds — same as EdgeOne, this build's `output:
"standalone"` trace excludes it, so that specific provider isn't present
in the bundle at all. Devon AI's other providers (Eve Agent, AirLLM, OpenAI
Agents) aren't affected; they're plain HTTP calls, not a subprocess.

## If it gets stuck on "Starting Devon…"

This section is about the server-backed build only — the static build (see
above) has no sidecar to start and no splash page; its window shows the real
thing immediately.

The splash screen now replaces itself with whatever actually went wrong
(the sidecar failed to launch, Devon's server crashed on startup, or it
just never answered within 30 seconds) instead of sitting there forever —
if you're on an older build that doesn't do this, update first. Either
way, more detail is always written to a log file, regardless of build
type: on Windows, `%LOCALAPPDATA%\net.lovedub.devon-browser\logs\devon-desktop.log`
(substitute your own `identifier` if you changed it in `tauri.conf.json`).
That file's last few lines are the first thing to check or share when
reporting a stuck launch.

## Known rough edges

- Closing the window kills the sidecar; there's no "minimize to tray and
  keep running" yet. (Doesn't apply to the static build — no sidecar.)
- The app always needs to actually boot Devon's Next.js server first (a
  second or two), unlike a plain static desktop app — the splash screen in
  `frontend-dist/index.html` covers that gap. (The static build doesn't have
  this gap at all; that's the whole point of it.)
- `bundle.resources` / sidecar path resolution in `src-tauri/src/lib.rs`
  tries a few plausible locations before giving up, since exactly where
  Tauri lands bundled resources has shifted across versions — if you
  upgrade `@tauri-apps/cli`/`tauri` and the app can't find `server.js` at
  startup, that's the first place to look. (Static build: n/a, no resources
  to resolve.)
- The static build's missing proxy/YouTube/AI/sign-in features (see "The
  other build" above) are deliberate, not a bug — if a new server route
  gets added to `app/` later, `scripts/prepare-static.mjs` fails loudly
  (rather than silently exporting a site that's missing it) until it's
  either added to that script's `EXCLUDED` list or it's genuinely static
  itself.
