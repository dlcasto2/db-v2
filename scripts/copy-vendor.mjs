// Copies browser builds of dependencies that must run inside proxied pages
// into public/vendor, so the app can serve them same-origin.
import { copyFileSync, mkdirSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const out = join(root, "public", "vendor")
mkdirSync(out, { recursive: true })

try {
  copyFileSync(require.resolve("eruda/eruda.js"), join(out, "eruda.js"))
  console.log("copy-vendor: eruda.js -> public/vendor/")
} catch (error) {
  console.warn("copy-vendor: eruda not installed, skipping", error.message)
}

// ffmpeg.wasm's small JS wrapper + worker (the YouTube page uses it to join HD
// video with its audio, and to make MP3s). It must be same-origin because it
// starts a Web Worker from its own URL. The big core (.wasm) loads from a CDN.
try {
  const src = dirname(require.resolve("@ffmpeg/ffmpeg/worker"))
  const dest = join(out, "ffmpeg")
  mkdirSync(dest, { recursive: true })
  for (const file of ["index.js", "classes.js", "const.js", "errors.js", "types.js", "utils.js", "worker.js"]) {
    copyFileSync(join(src, file), join(dest, file))
  }
  console.log("copy-vendor: @ffmpeg/ffmpeg -> public/vendor/ffmpeg/")
} catch (error) {
  console.warn("copy-vendor: @ffmpeg/ffmpeg not installed, skipping", error.message)
}

// ffmpeg.wasm's core (~31 MB), served from Devon itself so HD merging and MP3
// work on networks that block CDNs. The .wasm is gzipped and split into ~3 MB
// parts to stay under static-hosting file limits; lib/youtube.ts joins and
// unzips them in the browser (DecompressionStream).
try {
  const { readFileSync, writeFileSync, rmSync } = await import("node:fs")
  const { gzipSync } = await import("node:zlib")
  const src = join(dirname(require.resolve("@ffmpeg/core")), "..", "esm")
  const dest = join(out, "ffmpeg-core")
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  copyFileSync(join(src, "ffmpeg-core.js"), join(dest, "ffmpeg-core.js"))
  const wasm = readFileSync(join(src, "ffmpeg-core.wasm"))
  const gz = gzipSync(wasm, { level: 9 })
  const PART = 3 * 1024 * 1024
  let parts = 0
  for (let i = 0; i < gz.length; i += PART) {
    writeFileSync(join(dest, `ffmpeg-core.wasm.gz.part${String(parts).padStart(2, "0")}`), gz.subarray(i, i + PART))
    parts++
  }
  writeFileSync(join(dest, "manifest.json"), JSON.stringify({ parts, size: wasm.length, gzipSize: gz.length }))
  console.log(`copy-vendor: @ffmpeg/core -> public/vendor/ffmpeg-core/ (${parts} parts)`)
} catch (error) {
  console.warn("copy-vendor: @ffmpeg/core not installed, skipping", error.message)
}
