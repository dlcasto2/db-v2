/**
 * Installed extensions: Chrome extension packages (content scripts only) and
 * userscripts. Metadata and files live in IndexedDB so large packages fit.
 */
import { unzip } from "./zip"

export type RunAt = "document_start" | "document_end" | "document_idle"

export interface ContentScriptRule {
  matches: string[]
  excludeMatches: string[]
  includeGlobs: string[]
  excludeGlobs: string[]
  js: string[]
  css: string[]
  runAt: RunAt
  allFrames: boolean
}

interface BaseExtension {
  id: string
  name: string
  version: string
  description: string
  enabled: boolean
  installedAt: number
  updatedAt: number
  /** data: URL */
  icon?: string
  /** Where it was installed from (URL or file name) */
  source?: string
}

export type I18nMessages = Record<string, { message: string; placeholders?: Record<string, { content: string }> }>

/** Extension pages Devon can open (popup, options) and run (background) */
export interface ExtensionPages {
  popup?: string
  options?: string
  background?: {
    /** MV2 background page, or MV3 service worker / MV2 scripts (then no page) */
    page?: string
    scripts: string[]
    module: boolean
    serviceWorker: boolean
  }
}

export interface ChromeExtension extends BaseExtension {
  type: "chrome"
  manifestVersion: number
  contentScripts: ContentScriptRule[]
  messages: I18nMessages
  /** Parts of the extension Devon can't run (blocking rules, devtools, ...) */
  unsupported: string[]
  /** Popup / options / background (older installs: derived from manifest.json on load) */
  pages?: ExtensionPages
}

/** Features Devon can run now, even if an older install listed them as unsupported */
export const NOW_SUPPORTED = ["popup", "background script", "options page"]

/** Reads the popup, options page and background from a manifest */
export function pagesFromManifest(manifest: Record<string, unknown>): ExtensionPages {
  const clean = (p: unknown) => (typeof p === "string" && p.trim() ? p.trim().replace(/^\.?\//, "").split(/[?#]/)[0] : undefined)
  const action = (manifest.action || manifest.browser_action || manifest.page_action) as Record<string, unknown> | undefined
  const optionsUi = manifest.options_ui as Record<string, unknown> | undefined
  const bg = manifest.background as Record<string, unknown> | undefined
  const pages: ExtensionPages = {
    popup: clean(action?.default_popup),
    options: clean(optionsUi?.page) ?? clean(manifest.options_page),
  }
  if (bg && typeof bg === "object") {
    const scripts = (Array.isArray(bg.scripts) ? bg.scripts : []).map(clean).filter(Boolean) as string[]
    const worker = clean(bg.service_worker)
    const page = clean(bg.page)
    if (worker || scripts.length || page) {
      pages.background = {
        page,
        scripts: worker ? [worker] : scripts,
        module: bg.type === "module",
        serviceWorker: Boolean(worker),
      }
    }
  }
  return pages
}

export interface UserscriptMeta {
  name: string
  namespace: string
  version: string
  description: string
  author: string
  match: string[]
  include: string[]
  exclude: string[]
  excludeMatch: string[]
  require: string[]
  resource: { name: string; url: string }[]
  grant: string[]
  runAt: RunAt | "document_body"
  noframes: boolean
  icon?: string
  homepage?: string
  downloadURL?: string
  updateURL?: string
}

export interface Userscript extends BaseExtension {
  type: "userscript"
  code: string
  meta: UserscriptMeta
  /** @require'd libraries, fetched at install time */
  requires: { url: string; code: string }[]
}

export type Extension = ChromeExtension | Userscript

/** An installed extension with the files it needs to run already in memory */
export interface LoadedExtension {
  ext: Extension
  /** Text of the js/css files (Chrome) or @resource texts (userscripts, keyed "@resource/<name>") */
  texts: Map<string, string>
  files: Record<string, Blob>
}

const MAX_PACKAGE_BYTES = 60 * 1024 * 1024

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

const DB_NAME = "devon-extensions"
const EXT_STORE = "extensions"
const FILE_STORE = "files"

let dbPromise: Promise<IDBDatabase> | null = null

function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        const d = req.result
        if (!d.objectStoreNames.contains(EXT_STORE)) d.createObjectStore(EXT_STORE, { keyPath: "id" })
        if (!d.objectStoreNames.contains(FILE_STORE)) d.createObjectStore(FILE_STORE)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => {
        dbPromise = null
        reject(req.error)
      }
    })
  }
  return dbPromise
}

function requestResult<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function tx<T>(stores: string[], mode: IDBTransactionMode, run: (t: IDBTransaction) => Promise<T> | T): Promise<T> {
  const d = await db()
  const t = d.transaction(stores, mode)
  const done = new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error || new Error("Transaction aborted"))
  })
  const result = await run(t)
  await done
  return result
}

export async function listExtensions(): Promise<Extension[]> {
  const all = await tx([EXT_STORE], "readonly", (t) => requestResult(t.objectStore(EXT_STORE).getAll()))
  return (all as Extension[]).sort((a, b) => a.installedAt - b.installedAt)
}

async function getFiles(id: string): Promise<Record<string, Blob>> {
  const files = await tx([FILE_STORE], "readonly", (t) => requestResult(t.objectStore(FILE_STORE).get(id)))
  return (files as Record<string, Blob> | undefined) ?? {}
}

async function saveExtension(ext: Extension, files?: Record<string, Blob>) {
  await tx([EXT_STORE, FILE_STORE], "readwrite", (t) => {
    t.objectStore(EXT_STORE).put(ext)
    if (files) t.objectStore(FILE_STORE).put(files, ext.id)
  })
}

export async function setEnabled(id: string, enabled: boolean) {
  await tx([EXT_STORE], "readwrite", async (t) => {
    const store = t.objectStore(EXT_STORE)
    const ext = (await requestResult(store.get(id))) as Extension | undefined
    if (ext) store.put({ ...ext, enabled })
  })
}

export async function removeExtension(id: string) {
  await tx([EXT_STORE, FILE_STORE], "readwrite", (t) => {
    t.objectStore(EXT_STORE).delete(id)
    t.objectStore(FILE_STORE).delete(id)
  })
  try {
    localStorage.removeItem(storageKey(id))
  } catch {
    // ignore
  }
}

/** localStorage key holding an extension's chrome.storage / GM_setValue data */
export function storageKey(id: string) {
  return `devon-ext-data:${id}`
}

/** Loads every installed extension, with file contents for the enabled ones */
export async function loadExtensions(): Promise<LoadedExtension[]> {
  const exts = await listExtensions()
  return Promise.all(
    exts.map(async (ext) => {
      const texts = new Map<string, string>()
      if (!ext.enabled) return { ext, texts, files: {} }
      const files = await getFiles(ext.id)
      if (ext.type === "chrome" && !ext.pages && files["manifest.json"]) {
        try {
          ext.pages = pagesFromManifest(JSON.parse(await files["manifest.json"].text()))
        } catch {
          ext.pages = {}
        }
      }
      if (ext.type === "chrome") {
        const paths = new Set(ext.contentScripts.flatMap((r) => [...r.js, ...r.css]))
        await Promise.all(
          [...paths].map(async (p) => {
            const blob = files[p]
            if (blob) texts.set(p, await blob.text())
          }),
        )
      } else {
        await Promise.all(
          Object.entries(files).map(async ([k, blob]) => {
            if (k.startsWith("@resource/")) texts.set(k, await blob.text())
          }),
        )
      }
      return { ext, texts, files }
    }),
  )
}

// ---------------------------------------------------------------------------
// Fetching through the proxy (install from URL)
// ---------------------------------------------------------------------------

export async function fetchViaProxy(url: string): Promise<Response> {
  const res = await fetch(`/api/proxy?url=${encodeURIComponent(url)}&raw=1`)
  if (!res.headers.get("x-proxy-final-url")) {
    let message = `HTTP ${res.status}`
    try {
      message = (await res.json()).error || message
    } catch {
      // not JSON
    }
    throw new Error(`Couldn't download ${url}: ${message}`)
  }
  if (!res.ok) throw new Error(`Couldn't download ${url}: HTTP ${res.status}`)
  return res
}

/**
 * Downloads a file through the proxy in 2 MB slices (the proxy's
 * ?slice=&sliceSize= mode). Hosts cap how big one response may be (EdgeOne
 * answers with 413/5xx codes when it's exceeded), and extension packages can
 * be bigger than that.
 */
export async function fetchInSlicesViaProxy(url: string, sliceSize = 2 * 1024 * 1024): Promise<ArrayBuffer> {
  const parts: ArrayBuffer[] = []
  for (let i = 0; i < 128; i++) {
    const res = await fetch(`/api/proxy?url=${encodeURIComponent(url)}&raw=1&slice=${i}&sliceSize=${sliceSize}`)
    if (!res.ok) {
      let message = `HTTP ${res.status}`
      try {
        message = (await res.json()).error || message
      } catch {
        // not JSON
      }
      throw new Error(`Couldn't download ${url}: ${message}`)
    }
    parts.push(await res.arrayBuffer())
    if (res.headers.get("x-devon-more") !== "1") break
  }
  const total = parts.reduce((n, p) => n + p.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(new Uint8Array(p), offset)
    offset += p.byteLength
  }
  return out.buffer
}

/** Whole download first; if the host refuses or cuts it off, retry in slices */
export async function downloadViaProxy(url: string): Promise<ArrayBuffer> {
  let firstError: unknown
  try {
    const res = await fetchViaProxy(url)
    return await res.arrayBuffer()
  } catch (error) {
    firstError = error
  }
  try {
    return await fetchInSlicesViaProxy(url)
  } catch (error) {
    const first = firstError instanceof Error ? firstError.message : String(firstError)
    const second = error instanceof Error ? error.message : String(error)
    throw new Error(`${first} (retrying in pieces also failed: ${second.replace(/^Couldn't download \S+: /, "")})`)
  }
}

// ---------------------------------------------------------------------------
// Chrome extensions
// ---------------------------------------------------------------------------

/** Chrome-style id: 32 characters a-p */
function randomExtensionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join("")
}

async function stableId(input: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)))
  return Array.from(hash.slice(0, 16), (b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join(
    "",
  )
}

const MIME: Record<string, string> = {
  js: "text/javascript",
  mjs: "text/javascript",
  css: "text/css",
  html: "text/html",
  htm: "text/html",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  txt: "text/plain",
  wasm: "application/wasm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
}

export function mimeFor(path: string): string {
  return MIME[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream"
}

function stripJsonComments(text: string): string {
  // manifest.json may contain comments; leave strings alone
  return text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? "")
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export function localizeMessage(messages: I18nMessages, name: string, substitutions?: unknown): string {
  const entry = messages[name.toLowerCase()]
  if (!entry) return ""
  const subs = substitutions === undefined ? [] : Array.isArray(substitutions) ? substitutions.map(String) : [String(substitutions)]
  let text = entry.message.replace(/\$([a-z0-9_@]+)\$/gi, (m, key: string) => {
    const ph = entry.placeholders?.[key.toLowerCase()] ?? entry.placeholders?.[key]
    return ph ? ph.content : m
  })
  text = text.replace(/\$(\d)/g, (_m, n: string) => subs[Number(n) - 1] ?? "").replace(/\$\$/g, "$")
  return text
}

function localize(messages: I18nMessages, value: unknown): string {
  const s = typeof value === "string" ? value : ""
  return s.replace(/__MSG_(\w+)__/g, (_m, name: string) => localizeMessage(messages, name))
}

function asList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []
}

function normalizePath(p: string) {
  return p.replace(/^\.?\//, "")
}

function normalizeRunAt(value: unknown): RunAt {
  return value === "document_start" || value === "document_end" ? value : "document_idle"
}

/** Installs a Chrome extension from a .zip or .crx */
export async function installChromePackage(data: ArrayBuffer, source?: string): Promise<ChromeExtension> {
  if (data.byteLength > MAX_PACKAGE_BYTES) throw new Error("Extension package is too large (60 MB max)")
  const entries = await unzip(data)
  const manifestBytes = entries.get("manifest.json")
  if (!manifestBytes) throw new Error("No manifest.json found. Is this a Chrome extension?")

  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(stripJsonComments(new TextDecoder().decode(manifestBytes).replace(/^\uFEFF/, "")))
  } catch {
    throw new Error("manifest.json isn't valid JSON")
  }

  // Locale messages: the browser's language, then the extension's default
  const decoder = new TextDecoder()
  const readMessages = (locale: string): I18nMessages | null => {
    const bytes = entries.get(`_locales/${locale}/messages.json`)
    if (!bytes) return null
    try {
      const raw = JSON.parse(stripJsonComments(decoder.decode(bytes).replace(/^\uFEFF/, ""))) as I18nMessages
      const out: I18nMessages = {}
      for (const [k, v] of Object.entries(raw)) {
        if (v && typeof v.message === "string") {
          const placeholders: Record<string, { content: string }> = {}
          for (const [pk, pv] of Object.entries(v.placeholders ?? {})) placeholders[pk.toLowerCase()] = pv
          out[k.toLowerCase()] = { message: v.message, placeholders }
        }
      }
      return out
    } catch {
      return null
    }
  }
  const lang = (typeof navigator !== "undefined" ? navigator.language : "en").replace("-", "_")
  const messages =
    readMessages(lang) ||
    readMessages(lang.split("_")[0]) ||
    (typeof manifest.default_locale === "string" ? readMessages(manifest.default_locale) : null) ||
    {}

  const files: Record<string, Blob> = {}
  entries.forEach((bytes, path) => {
    files[path] = new Blob([bytes as BlobPart], { type: mimeFor(path) })
  })

  const contentScripts: ContentScriptRule[] = []
  for (const cs of Array.isArray(manifest.content_scripts) ? manifest.content_scripts : []) {
    if (!cs || typeof cs !== "object") continue
    const rule = cs as Record<string, unknown>
    const js = asList(rule.js).map(normalizePath)
    const css = asList(rule.css).map(normalizePath)
    const missing = [...js, ...css].filter((p) => !files[p])
    if (missing.length) throw new Error(`The package is missing ${missing.join(", ")}`)
    contentScripts.push({
      matches: asList(rule.matches),
      excludeMatches: asList(rule.exclude_matches),
      includeGlobs: asList(rule.include_globs),
      excludeGlobs: asList(rule.exclude_globs),
      js,
      css,
      runAt: normalizeRunAt(rule.run_at),
      allFrames: rule.all_frames === true,
    })
  }

  const unsupported: string[] = []
  const action = (manifest.action || manifest.browser_action || manifest.page_action) as Record<string, unknown> | undefined
  const pages = pagesFromManifest(manifest)
  if (manifest.declarative_net_request) unsupported.push("blocking rules")
  if (manifest.devtools_page) unsupported.push("devtools")
  if (manifest.chrome_url_overrides) unsupported.push("new tab override")
  if (manifest.side_panel) unsupported.push("side panel")
  if (!contentScripts.length && !unsupported.length && !pages.popup && !pages.background && !pages.options)
    unsupported.push("no content scripts")

  // Icon: the largest one up to 128px
  let icon: string | undefined
  const icons = (manifest.icons ?? (action?.default_icon as unknown)) as Record<string, string> | string | undefined
  const iconPath =
    typeof icons === "string"
      ? icons
      : icons && typeof icons === "object"
        ? Object.entries(icons)
            .filter(([size]) => Number(size) <= 128)
            .sort((a, b) => Number(b[0]) - Number(a[0]))[0]?.[1]
        : undefined
  if (iconPath && files[normalizePath(iconPath)]) {
    try {
      icon = await blobToDataUrl(files[normalizePath(iconPath)])
    } catch {
      icon = undefined
    }
  }

  const name = localize(messages, manifest.name) || "Untitled extension"
  // Reinstalling the same extension (same key/name) replaces it and keeps its data
  const existing = (await listExtensions()).find(
    (e) => e.type === "chrome" && ((Boolean(source) && e.source === source) || e.name === name),
  )
  const now = Date.now()
  const ext: ChromeExtension = {
    type: "chrome",
    id: existing?.id ?? randomExtensionId(),
    name,
    version: typeof manifest.version === "string" ? manifest.version : "",
    description: localize(messages, manifest.description),
    enabled: existing?.enabled ?? true,
    installedAt: existing?.installedAt ?? now,
    updatedAt: now,
    icon,
    source,
    manifestVersion: Number(manifest.manifest_version) || 2,
    contentScripts,
    messages,
    unsupported,
    pages,
  }
  await saveExtension(ext, files)
  return ext
}

/** Accepts a Chrome Web Store link (or bare 32-letter id) and installs the extension */
export async function installFromChromeWebStore(input: string): Promise<ChromeExtension> {
  const id = /\b([a-p]{32})\b/.exec(input)?.[1]
  if (!id) throw new Error("That doesn't look like a Chrome Web Store link")
  const crxUrl =
    "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=131.0.0.0" +
    `&acceptformat=crx2,crx3&x=id%3D${id}%26uc`
  let data: ArrayBuffer
  try {
    data = await downloadViaProxy(crxUrl)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `${reason}. You can also download the extension's .crx file yourself and add it with "Load .zip / .crx / .user.js".`,
    )
  }
  if (data.byteLength < 100) throw new Error("The Chrome Web Store didn't return this extension")
  return installChromePackage(data, `https://chromewebstore.google.com/detail/${id}`)
}

// ---------------------------------------------------------------------------
// Userscripts
// ---------------------------------------------------------------------------

export function parseUserscript(code: string): UserscriptMeta {
  const block = /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/.exec(code)
  if (!block) throw new Error("Missing the // ==UserScript== header")
  const meta: UserscriptMeta = {
    name: "",
    namespace: "",
    version: "",
    description: "",
    author: "",
    match: [],
    include: [],
    exclude: [],
    excludeMatch: [],
    require: [],
    resource: [],
    grant: [],
    runAt: "document_idle",
    noframes: false,
  }
  const localized: Record<string, string> = {}
  const lang = (typeof navigator !== "undefined" ? navigator.language : "en").toLowerCase()

  for (const line of block[1].split("\n")) {
    const m = /^\s*\/\/\s*@([\w:-]+)(?:\s+(.*))?$/.exec(line)
    if (!m) continue
    const [, rawKey, rawValue = ""] = m
    const value = rawValue.trim()
    const [key, locale] = rawKey.split(":")
    if (locale) {
      if (locale.toLowerCase() === lang || lang.startsWith(locale.toLowerCase())) localized[key] = value
      continue
    }
    switch (key) {
      case "name":
      case "namespace":
      case "version":
      case "description":
      case "author":
      case "homepage":
      case "downloadURL":
      case "updateURL":
        ;(meta as unknown as Record<string, string>)[key] = value
        break
      case "homepageURL":
      case "website":
        meta.homepage = value
        break
      case "icon":
      case "iconURL":
      case "defaulticon":
        meta.icon = value
        break
      case "match":
        meta.match.push(value)
        break
      case "include":
        meta.include.push(value)
        break
      case "exclude":
        meta.exclude.push(value)
        break
      case "exclude-match":
        meta.excludeMatch.push(value)
        break
      case "require":
        if (value) meta.require.push(value)
        break
      case "resource": {
        const [name, ...rest] = value.split(/\s+/)
        if (name && rest.length) meta.resource.push({ name, url: rest.join(" ") })
        break
      }
      case "grant":
        meta.grant.push(value)
        break
      case "noframes":
        meta.noframes = true
        break
      case "run-at": {
        const v = value.replace(/-/g, "_")
        meta.runAt =
          v === "document_start" || v === "document_end" || v === "document_body" ? v : "document_idle"
        break
      }
    }
  }
  if (localized.name) meta.name = localized.name
  if (localized.description) meta.description = localized.description
  if (!meta.name) throw new Error("The userscript needs an @name")
  return meta
}

/** Installs or updates a userscript. Fetches its @require and @resource files. */
export async function installUserscript(code: string, source?: string, existingId?: string): Promise<Userscript> {
  const meta = parseUserscript(code)
  const id = existingId ?? (await stableId(`userscript:${meta.namespace}:${meta.name}`))

  const requires = await Promise.all(
    meta.require.map(async (url) => ({ url, code: await (await fetchViaProxy(url)).text() })),
  )
  const files: Record<string, Blob> = {}
  await Promise.all(
    meta.resource.map(async ({ name, url }) => {
      const res = await fetchViaProxy(url)
      const blob = await res.blob()
      files[`@resource/${name}`] = new Blob([blob], {
        type: res.headers.get("content-type")?.split(";")[0] || mimeFor(new URL(url).pathname),
      })
    }),
  )

  const previous = (await listExtensions()).find((e) => e.id === id)
  const now = Date.now()
  const script: Userscript = {
    type: "userscript",
    id,
    name: meta.name,
    version: meta.version,
    description: meta.description,
    enabled: previous?.enabled ?? true,
    installedAt: previous?.installedAt ?? now,
    updatedAt: now,
    icon: meta.icon && /^(https?:|data:)/.test(meta.icon) ? meta.icon : undefined,
    source: source ?? previous?.source,
    code,
    meta,
    requires,
  }
  await saveExtension(script, files)
  return script
}

export async function installUserscriptFromUrl(url: string): Promise<Userscript> {
  const code = await (await fetchViaProxy(url)).text()
  if (!/==UserScript==/.test(code)) throw new Error("That URL isn't a userscript (no ==UserScript== header)")
  return installUserscript(code, url)
}

export const NEW_USERSCRIPT_TEMPLATE = `// ==UserScript==
// @name         New userscript
// @namespace    devon
// @version      1.0
// @description  Runs on the pages it matches
// @match        *://*/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  // Your code here
})();
`
