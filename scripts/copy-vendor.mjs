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
