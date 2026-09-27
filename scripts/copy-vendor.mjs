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
