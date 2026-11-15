#!/usr/bin/env node
// Builds Devon as a standalone Next.js server and stages it where the Tauri
// bundler expects resources (see tauri.conf.json -> bundle.resources), so the
// desktop app has a real `server.js` + pruned `node_modules` to run as its
// Node sidecar. Safe to re-run: wipes and rewrites the staging directory.
//
// Run from anywhere; paths are resolved relative to this file, not cwd.
import { spawnSync } from "node:child_process"
import { existsSync, cpSync, rmSync, mkdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "..", "..") // desktop/scripts -> desktop -> repo root
const stagingDir = path.resolve(here, "..", "src-tauri", "resources", "app")

console.log(`[prepare-standalone] building Devon (standalone) from ${repoRoot}`)
const build = spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["exec", "next", "build"], {
  cwd: repoRoot,
  stdio: "inherit",
  env: { ...process.env, DEVON_DESKTOP_BUILD: "1" },
})
if (build.status !== 0) {
  console.error("[prepare-standalone] `next build` failed, aborting")
  process.exit(build.status ?? 1)
}

const standaloneDir = path.join(repoRoot, ".next", "standalone")
if (!existsSync(standaloneDir)) {
  console.error(
    `[prepare-standalone] ${standaloneDir} is missing — did next.config.mjs's ` +
      "DEVON_DESKTOP_BUILD -> output:'standalone' branch run? (check next.config.mjs)",
  )
  process.exit(1)
}

console.log(`[prepare-standalone] staging into ${stagingDir}`)
rmSync(stagingDir, { recursive: true, force: true })
mkdirSync(stagingDir, { recursive: true })

// The standalone output is already a self-contained server + pruned
// node_modules, but it deliberately excludes .next/static and public/ (Next
// expects you to copy those in yourself — see
// https://nextjs.org/docs/app/api-reference/config/next-config-js/output).
cpSync(standaloneDir, stagingDir, { recursive: true })
cpSync(path.join(repoRoot, ".next", "static"), path.join(stagingDir, ".next", "static"), {
  recursive: true,
})
cpSync(path.join(repoRoot, "public"), path.join(stagingDir, "public"), { recursive: true })

if (!existsSync(path.join(stagingDir, "server.js"))) {
  console.error(
    `[prepare-standalone] expected ${stagingDir}/server.js — Devon's standalone output layout ` +
      "may have changed (e.g. if this ever becomes a monorepo, server.js nests under a workspace " +
      "path instead of sitting at the standalone root). Check .next/standalone's actual layout.",
  )
  process.exit(1)
}

console.log("[prepare-standalone] done")
