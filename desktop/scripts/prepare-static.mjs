#!/usr/bin/env node
// Builds Devon as a fully static export (plain HTML/CSS/JS, no server at all)
// and stages it where the Tauri bundler expects the frontend for the
// *static* Windows desktop build — see tauri.static.conf.json's
// build.frontendDist, which points at ../static-dist (this script's output).
//
// This is a different app from the one scripts/prepare-standalone.mjs feeds:
// that one bundles a real Node server as a sidecar so Devon's proxy, YouTube
// downloads, page-safety checks and Devon AI chat all keep working. This one
// has none of that — just whatever can be pre-rendered at build time — in
// exchange for an installer with no bundled Node runtime and nothing that can
// get "stuck starting" the way the server-backed build once did.
//
// Devon's app/ tree has real server routes that `next build` with
// `output: "export"` refuses to build at all: app/api/** (the proxy, search,
// jev and every YouTube endpoint) plus a handful of single-purpose
// app/<name>/route.ts directories for auth, Devon AI and account sync. Rather
// than touch next.config.mjs's route code, this script moves exactly those
// directories *out* of app/ before the build and puts every one of them back
// afterwards — on success, on a failed build, or on Ctrl-C.
//
// IMPORTANT: every exit from the guarded section below must be a `throw`, not
// a direct `process.exit()` — `process.exit()` tears the process down
// immediately and skips pending `finally` blocks (confirmed: a `finally`
// right next to a `process.exit()` in the same `try` simply never runs), so
// calling it from inside the moved-files section would leave app/ missing
// real source files with no restore and no warning. This bit a local test
// run while writing this script (two failed builds in a row left app/route
// directories stuck in .desktop-static-excluded-routes/, silently destroyed
// moments later when the next run's cleanup step blew that directory away —
// recovered only because the files were still in git's index). The exit-code
// variable + single `process.exit()` call at the very end, after `finally`
// has already run, is why that can't happen again.
//
// Run from anywhere; paths are resolved relative to this file, not cwd.
import { spawnSync } from "node:child_process"
import { existsSync, cpSync, rmSync, mkdirSync, renameSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "..", "..") // desktop/scripts -> desktop -> repo root
const appDir = path.join(repoRoot, "app")
const stagingDir = path.resolve(here, "..", "static-dist")
const holdingDir = path.join(repoRoot, ".desktop-static-excluded-routes")

// Keep this in sync with `find app -name 'route.*'` (see desktop/README.md).
// Each entry is a directory name directly under app/. "api" covers the whole
// app/api/** subtree in one move; the rest are single-file
// app/<name>/route.ts directories with nothing else in them.
const EXCLUDED = [
  "api",
  "account-sync",
  "auth-callback",
  "auth-login",
  "auth-logout",
  "auth-me",
  "ai-chat",
  "ai-conversations",
  "ai-delete-conversation",
  "ai-feedback",
  "ai-filesystem",
  "ai-history",
  "ai-page-result",
  "ai-session",
  "ai-stop",
]

function moveOut() {
  if (existsSync(holdingDir) && readdirSync(holdingDir).length > 0) {
    // A previous run's restore didn't finish — do NOT blindly wipe this, it
    // may be the only copy of real route files right now. Stop and let a
    // human look (`git status` will show the matching app/<name> dirs as
    // deleted if so — recoverable with `git checkout -- <path>`).
    throw new Error(
      `${holdingDir} already exists and isn't empty — a previous run may not have finished ` +
        "restoring. Not touching it automatically; check it (and `git status` for app/) before " +
        "deleting it yourself.",
    )
  }
  rmSync(holdingDir, { recursive: true, force: true })
  mkdirSync(holdingDir, { recursive: true })
  for (const name of EXCLUDED) {
    const from = path.join(appDir, name)
    if (!existsSync(from)) continue // nothing there — fine, just means less to put back
    renameSync(from, path.join(holdingDir, name))
  }
}

function moveBack() {
  if (!existsSync(holdingDir)) return
  for (const name of EXCLUDED) {
    const from = path.join(holdingDir, name)
    if (!existsSync(from)) continue
    renameSync(from, path.join(appDir, name))
  }
  // Only remove the holding dir once every entry we know about is gone from
  // it — if something unexpected is still in there, leave it rather than
  // deleting an unknown file silently.
  if (readdirSync(holdingDir).length === 0) {
    rmSync(holdingDir, { recursive: true, force: true })
  } else {
    console.error(
      `[prepare-static] ${holdingDir} still has unexpected contents after restoring the known ` +
        "route directories — left it in place; check it by hand.",
    )
  }
}

// Fail loudly here instead of letting `next build` fail on it with a
// confusing error (or, worse, silently exporting a site that's missing a
// route nobody remembered to add to EXCLUDED above).
function checkForUnknownRouteHandlers() {
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/^route\.(ts|tsx|js)$/.test(entry.name)) found.push(full)
    }
  }
  walk(appDir)
  if (found.length) {
    throw new Error(
      "route handler(s) still present after excluding the known list — `next build` with " +
        "output:'export' will fail on these. If they're meant to be dropped from the static " +
        "build too, add them to EXCLUDED in this script:\n" +
        found.map((f) => `  ${path.relative(repoRoot, f)}`).join("\n"),
    )
  }
}

let restored = false
function restoreOnce() {
  if (restored) return
  restored = true
  moveBack()
}
// Belt and suspenders: a Ctrl-C mid-build should still leave app/ intact.
// (Unlike process.exit() inside the try below, this is fine: it's not
// nested inside that try/finally at all, and it calls restoreOnce() itself
// before exiting.)
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    restoreOnce()
    process.exit(1)
  })
}

let exitCode = 0
try {
  console.log(
    `[prepare-static] temporarily moving ${EXCLUDED.length} route directories out of app/`,
  )
  moveOut()
  checkForUnknownRouteHandlers()

  console.log(`[prepare-static] building Devon (static export) from ${repoRoot}`)
  // `shell: true` matters here: on Windows, pnpm is a .cmd (a batch script),
  // and spawnSync can't exec one directly without going through a shell — it
  // fails to even start the process (instantly, with nothing on stdio/stderr
  // to inherit, which otherwise silently looks just like `next build` itself
  // failing). This is harmless on POSIX too, and there's no untrusted input
  // in the command here.
  const build = spawnSync("pnpm", ["exec", "next", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, DEVON_DESKTOP_STATIC_BUILD: "1" },
  })
  if (build.error) {
    throw new Error(`failed to start \`pnpm exec next build\`: ${build.error.message}`)
  }
  if (build.status !== 0) {
    throw new Error("`next build` failed, aborting")
  }

  const exportDir = path.join(repoRoot, "out")
  if (!existsSync(path.join(exportDir, "index.html"))) {
    throw new Error(
      `expected ${exportDir}/index.html — did next.config.mjs's DEVON_DESKTOP_STATIC_BUILD -> ` +
        "output:'export' branch run? (check next.config.mjs)",
    )
  }

  console.log(`[prepare-static] staging into ${stagingDir}`)
  rmSync(stagingDir, { recursive: true, force: true })
  // Unlike the standalone build, a static export already has everything it
  // needs under out/ (next build copies public/ in itself) — no separate
  // .next/static or public/ copy step.
  cpSync(exportDir, stagingDir, { recursive: true })

  console.log("[prepare-static] done")
} catch (err) {
  console.error(`[prepare-static] ${err.message}`)
  exitCode = 1
} finally {
  restoreOnce()
}
process.exit(exitCode)
