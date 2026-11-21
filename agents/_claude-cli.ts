/**
 * The Claude CLI binary for hosts whose deploy doesn't include it (private
 * module, not a route).
 *
 * The Claude Agent SDK runs the Claude CLI as a subprocess. Since SDK 0.3 that
 * CLI is a native binary (~250 MB) in a per-platform optional package
 * (@anthropic-ai/claude-agent-sdk-linux-x64 and friends), which the SDK looks
 * up at runtime. Serverless deploys leave it out: Next's file trace can't see a
 * runtime lookup, and on Netlify it couldn't be added anyway, since the binary
 * alone is about the size limit of a whole function (Netlify runs the entire
 * Next server as one AWS Lambda function, 250 MB unzipped). Devon AI then failed
 * on the first message with "Native CLI binary for linux-x64 not found".
 *
 * So when the SDK can't find it, Devon fetches that same package from the npm
 * registry once per server instance, checks it against the integrity hash in
 * pnpm-lock.yaml (baked in at build time by next.config.mjs; npm's own hash for
 * that version otherwise), and unpacks the binary into the temp folder. Later
 * messages on the same instance reuse it. Hosts that ship the binary (EdgeOne,
 * local dev) never get here.
 */

import { createHash } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import { access, chmod, mkdir, open, readdir, readFile, rename, rm, statfs } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createGunzip } from "node:zlib"

const SCOPE = "@anthropic-ai"
const BASE = "claude-agent-sdk"
const REGISTRY = "https://registry.npmjs.org"
/** Whole download + unpack; a function has 60 s on Netlify, and the reply needs some */
const DOWNLOAD_TIMEOUT_MS = 45_000
/** The unpacked binary plus headroom */
const NEEDED_BYTES = 300 * 1024 * 1024

interface Logger {
  log(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** The SDK's own error when its platform package isn't installed */
export function isMissingCliError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /Native CLI binary for .* not found/i.test(message)
}

/** linux-x64, linux-x64-musl, linux-arm64… the package suffix for this machine */
function platformVariant(): string | null {
  if (process.platform !== "linux") return null
  if (process.arch !== "x64" && process.arch !== "arm64") return null
  let musl = false
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined
    musl = !report?.header?.glibcVersionRuntime
  } catch {
    // assume glibc, like the SDK does
  }
  return `linux-${process.arch}${musl ? "-musl" : ""}`
}

interface CliLock {
  version: string
  integrity: Record<string, string>
}

/** Version and integrity of the platform packages, from the build (see next.config.mjs) */
function bakedLock(): CliLock | null {
  try {
    const raw = process.env.CLAUDE_CLI_LOCK
    if (!raw) return null
    const lock = JSON.parse(raw) as CliLock
    return lock?.version ? lock : null
  } catch {
    return null
  }
}

/** The SDK version installed next to the running server, when it wasn't baked in */
async function installedVersion(): Promise<string | null> {
  try {
    const file = path.join(process.cwd(), "node_modules", SCOPE, BASE, "package.json")
    const pkg = JSON.parse(await readFile(file, "utf8")) as { version?: string; optionalDependencies?: Record<string, string> }
    return pkg.optionalDependencies?.[`${SCOPE}/${BASE}-linux-x64`] || pkg.version || null
  } catch {
    return null
  }
}

/** npm's own integrity hash for that version: what `npm install` without a lockfile trusts */
async function registryIntegrity(name: string, version: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(`${REGISTRY}/${name}/${encodeURIComponent(version)}`, { signal, headers: { accept: "application/json" } })
  if (!res.ok) throw new Error(`npm registry answered ${res.status} for ${name}@${version}`)
  const meta = (await res.json()) as { dist?: { integrity?: string } }
  if (!meta.dist?.integrity?.startsWith("sha512-")) throw new Error(`npm registry gave no sha512 hash for ${name}@${version}`)
  return meta.dist.integrity
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Size field of a tar header: octal text, or base-256 when the high bit is set */
function tarSize(field: Buffer): number {
  if (field[0] & 0x80) {
    let n = 0
    for (let i = 1; i < field.length; i++) n = n * 256 + field[i]
    return n
  }
  const text = tarString(field).trim()
  return text ? parseInt(text, 8) : 0
}

function tarString(field: Buffer): string {
  const end = field.indexOf(0)
  return field.toString("utf8", 0, end === -1 ? field.length : end)
}

/** pax extended header records: "<len> key=value\n" */
function parsePax(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let off = 0
  while (off < body.length) {
    const space = body.indexOf(0x20, off)
    if (space === -1) break
    const len = parseInt(body.toString("latin1", off, space), 10)
    if (!len || off + len > body.length) break
    const record = body.toString("utf8", space + 1, off + len - 1)
    const eq = record.indexOf("=")
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1)
    off += len
  }
  return out
}

/**
 * Streams the package tarball: hashes the compressed bytes for the integrity
 * check and writes the one entry package/claude to `dest`. Returns the hash.
 */
async function downloadBinary(url: string, dest: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal })
  if (!res.ok || !res.body) throw new Error(`npm registry answered ${res.status} for ${url}`)

  const hash = createHash("sha512")
  const gunzip = createGunzip()
  const feeding = pipeline(
    Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
    new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk)
        cb(null, chunk)
      },
    }),
    gunzip,
  )
  // Surfaced by the await below; this only stops an unhandled rejection if the loop throws first
  feeding.catch(() => {})

  const file = await open(dest, "w", 0o755)
  let found = false
  try {
    let pending: Buffer = Buffer.alloc(0)
    let skip = 0 // bytes of an entry (and padding) to pass over
    let write = 0 // bytes of the binary still to write
    let pad = 0 // padding after the binary
    let paxLeft = 0 // bytes of a pax header still to collect
    let paxPad = 0
    let paxParts: Buffer[] = []
    let pax: Record<string, string> = {}

    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      const data = pending.length ? Buffer.concat([pending, chunk]) : chunk
      pending = Buffer.alloc(0)
      let off = 0
      while (off < data.length) {
        if (write > 0) {
          const n = Math.min(write, data.length - off)
          await file.write(data, off, n)
          write -= n
          off += n
          if (write === 0) skip = pad
          continue
        }
        if (paxLeft > 0) {
          const n = Math.min(paxLeft, data.length - off)
          paxParts.push(Buffer.from(data.subarray(off, off + n)))
          paxLeft -= n
          off += n
          if (paxLeft === 0) {
            pax = parsePax(Buffer.concat(paxParts))
            paxParts = []
            skip = paxPad
          }
          continue
        }
        if (skip > 0) {
          const n = Math.min(skip, data.length - off)
          skip -= n
          off += n
          continue
        }
        if (data.length - off < 512) {
          pending = Buffer.from(data.subarray(off))
          break
        }
        const header = data.subarray(off, off + 512)
        off += 512
        if (header.every((b) => b === 0)) continue // end-of-archive blocks

        const type = String.fromCharCode(header[156] || 0x30)
        let name = tarString(header.subarray(0, 100))
        const prefix = header.toString("latin1", 257, 262) === "ustar" ? tarString(header.subarray(345, 500)) : ""
        if (prefix) name = `${prefix}/${name}`
        let size = tarSize(header.subarray(124, 136))
        if (pax.path) name = pax.path
        if (pax.size) size = Number(pax.size)
        pax = {}
        const padded = Math.ceil(size / 512) * 512

        if (type === "x") {
          paxLeft = size
          paxPad = padded - size
          if (size === 0) skip = paxPad
        } else if ((type === "0" || type === "\0") && name.split("/").slice(1).join("/") === "claude" && !found) {
          found = true
          write = size
          pad = padded - size
          if (size === 0) skip = pad
        } else {
          skip = padded // other files, directories, global pax headers
        }
      }
    }
    await feeding
  } finally {
    await file.close()
  }
  if (!found) throw new Error(`${url} has no package/claude`)
  return `sha512-${hash.digest("base64")}`
}

/** Clears earlier versions out of the temp folder when it's short on space */
async function makeRoom(root: string, keep: string, logger: Logger) {
  try {
    const { bavail, bsize } = await statfs(tmpdir())
    if (bavail * bsize >= NEEDED_BYTES) return
  } catch {
    return
  }
  for (const entry of await readdir(root).catch(() => [] as string[])) {
    if (entry === keep) continue
    logger.log("[claude-cli] removing old copy to free space:", entry)
    await rm(path.join(root, entry), { recursive: true, force: true }).catch(() => {})
  }
}

let inFlight: Promise<string> | null = null
let ready: string | null = null

/** A binary downloaded earlier on this server instance, without downloading */
export async function cachedClaudeCli(): Promise<string | null> {
  if (ready && (await exists(ready))) return ready
  const variant = platformVariant()
  const version = bakedLock()?.version
  if (!variant || !version) return null
  const file = path.join(tmpdir(), "devon-claude-cli", `${version}-${variant}`, "claude")
  if (await exists(file)) ready = file
  return ready
}

/**
 * Path to a working Claude CLI binary for this machine, downloading it on the
 * first call. Throws a readable error if that isn't possible.
 */
export function ensureClaudeCli(logger: Logger): Promise<string> {
  if (!inFlight) {
    inFlight = (async () => {
      const variant = platformVariant()
      if (!variant) {
        throw new Error(
          `The Claude CLI isn't installed for ${process.platform}-${process.arch}, and Devon can only fetch it for Linux. Reinstall dependencies without --omit=optional.`,
        )
      }
      const lock = bakedLock()
      const version = lock?.version || (await installedVersion())
      if (!version) throw new Error("The Claude CLI isn't installed on this server, and Devon couldn't tell which version the SDK needs.")

      const root = path.join(tmpdir(), "devon-claude-cli")
      const dirName = `${version}-${variant}`
      const dir = path.join(root, dirName)
      const file = path.join(dir, "claude")
      if (await exists(file)) return file

      const name = `${SCOPE}/${BASE}-${variant}`
      const url = `${REGISTRY}/${name}/-/${BASE}-${variant}-${version}.tgz`
      const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
      const expected = lock?.integrity?.[variant] || (await registryIntegrity(name, version, signal))

      await mkdir(dir, { recursive: true })
      await makeRoom(root, dirName, logger)
      const partial = `${file}.${process.pid}.${Date.now()}.part`
      const started = Date.now()
      logger.log("[claude-cli] fetching", `${name}@${version}`)
      try {
        const got = await downloadBinary(url, partial, signal)
        if (got !== expected) throw new Error(`${name}@${version} failed its integrity check (expected ${expected.slice(0, 20)}…, got ${got.slice(0, 20)}…)`)
        await chmod(partial, 0o755)
        await rename(partial, file)
      } catch (error) {
        await rm(partial, { force: true }).catch(() => {})
        const reason = error instanceof Error ? error.message : String(error)
        if (/ENOSPC/.test(reason)) throw new Error("Not enough room in the server's temp folder for the Claude CLI (it needs about 250 MB).")
        if ((error as Error)?.name === "TimeoutError") throw new Error(`Downloading the Claude CLI took longer than ${DOWNLOAD_TIMEOUT_MS / 1000} s. Try again.`)
        throw new Error(`Couldn't set up the Claude CLI on this server: ${reason}`)
      }
      logger.log("[claude-cli] ready in", `${((Date.now() - started) / 1000).toFixed(1)} s:`, file)
      return file
    })()
      .then((file) => {
        ready = file
        return file
      })
      .finally(() => {
        // A failure isn't cached: the next message tries again
        inFlight = null
      })
  }
  return inFlight
}
