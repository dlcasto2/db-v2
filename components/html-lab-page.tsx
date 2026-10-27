"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, Check, Code2, Copy, Download, Eye, FolderOpen, RotateCcw, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type EditorTab = "html" | "css" | "js"
type Project = Record<EditorTab, string>
type LocalAssets = Record<string, string>

const STORAGE_KEY = "devon_html_lab"
const MAX_PROJECT_FILES = 250
const MAX_PROJECT_ASSET_BYTES = 20 * 1024 * 1024
const TABS: { id: EditorTab; label: string; language: string }[] = [
  { id: "html", label: "HTML", language: "text/html" },
  { id: "css", label: "CSS", language: "text/css" },
  { id: "js", label: "JavaScript", language: "text/javascript" },
]

const STARTER: Project = {
  html: `<main class="card">
  <span class="eyebrow">YOUR LIVE PREVIEW</span>
  <h1>Hello, Devon</h1>
  <p>Edit the HTML, CSS, or JavaScript and watch this page update.</p>
  <button id="count">Clicked 0 times</button>
</main>`,
  css: `* { box-sizing: border-box; }
body {
  min-height: 100vh;
  margin: 0;
  display: grid;
  place-items: center;
  background: #111827;
  color: #f9fafb;
  font: 16px/1.6 system-ui, sans-serif;
}
.card {
  width: min(440px, calc(100% - 32px));
  padding: 32px;
  border: 1px solid #374151;
  border-radius: 20px;
  background: #1f2937;
  box-shadow: 0 24px 70px #0005;
}
.eyebrow { color: #a5b4fc; font-size: 12px; letter-spacing: .14em; }
h1 { margin: 12px 0 4px; font-size: 32px; }
p { color: #cbd5e1; }
button {
  margin-top: 12px;
  padding: 10px 16px;
  border: 0;
  border-radius: 10px;
  background: #818cf8;
  color: #111827;
  font: inherit;
  cursor: pointer;
}`,
  js: `let clicks = 0;
document.querySelector("#count").addEventListener("click", (event) => {
  clicks += 1;
  event.currentTarget.textContent = \`Clicked \${clicks} times\`;
});`,
}

function loadProject(): Project {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as Partial<Project> | null
    if (!saved) return STARTER
    return {
      html: typeof saved.html === "string" ? saved.html : STARTER.html,
      css: typeof saved.css === "string" ? saved.css : STARTER.css,
      js: typeof saved.js === "string" ? saved.js : STARTER.js,
    }
  } catch {
    return STARTER
  }
}

function normalizeProjectPath(path: string): string {
  const parts: string[] = []
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  return parts.join("/")
}

function resolveProjectPath(basePath: string, relativePath: string): string {
  return normalizeProjectPath(`${basePath}/${relativePath}`)
}

function mimeTypeFor(file: File): string {
  if (file.type) return file.type
  const extension = file.name.split(".").pop()?.toLowerCase()
  const types: Record<string, string> = {
    avif: "image/avif",
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    svg: "image/svg+xml",
    webp: "image/webp",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    webm: "video/webm",
  }
  return (extension && types[extension]) || "application/octet-stream"
}

function toBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)))
  }
  return btoa(binary)
}

async function loadFolderProject(files: File[]): Promise<{ project: Project; assets: LocalAssets; name: string; basePath: string }> {
  if (files.length > MAX_PROJECT_FILES) throw new Error(`Choose a folder with up to ${MAX_PROJECT_FILES} files.`)
  const entries = files
    .map((file) => ({
      file,
      path: normalizeProjectPath((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name),
    }))
    .filter((entry) => entry.path)
  const fileByPath = new Map(entries.map((entry) => [entry.path.toLowerCase(), entry]))
  const htmlEntry =
    entries.find((entry) => /(?:^|\/)index\.html?$/i.test(entry.path)) ||
    entries.find((entry) => /\.html?$/i.test(entry.path))
  if (!htmlEntry) throw new Error("This folder has no HTML file. Include index.html or another .html file.")

  const htmlDirectory = htmlEntry.path.includes("/") ? htmlEntry.path.slice(0, htmlEntry.path.lastIndexOf("/")) : ""
  let html = await htmlEntry.file.text()
  let css = ""
  const scripts: string[] = []
  const usedStyles = new Set<string>()
  const usedScripts = new Set<string>()
  const referencedAssets = new Set<string>()
  let totalAssetBytes = 0

  const findFile = (base: string, reference: string) => {
    const url = reference.trim().replace(/&amp;/gi, "&")
    if (!url || /^(?:[a-z][a-z\d+.-]*:|\/\/|#|data:|blob:)/i.test(url)) return null
    const path = resolveProjectPath(base, url.split(/[?#]/, 1)[0])
    return fileByPath.get(path.toLowerCase()) ?? null
  }

  const importAsset = async (entry: (typeof entries)[number]) => {
    if (referencedAssets.has(entry.path.toLowerCase())) return
    referencedAssets.add(entry.path.toLowerCase())
    totalAssetBytes += entry.file.size
    if (totalAssetBytes > MAX_PROJECT_ASSET_BYTES) {
      throw new Error("Referenced folder assets exceed the 20 MB preview limit.")
    }
    const bytes = new Uint8Array(await entry.file.arrayBuffer())
    const uri = `data:${mimeTypeFor(entry.file)};base64,${toBase64(bytes)}`
    assets[entry.path.toLowerCase()] = uri
  }

  const assets: LocalAssets = {}
  const htmlAssets = Array.from(html.matchAll(/<(?:img|source|video|audio|track|input)\b[^>]*>/gi))
  for (const match of htmlAssets) {
    const attrs = [...match[0].matchAll(/\b(src|poster)\s*=\s*(["'])(.*?)\2/gi)]
    for (const attr of attrs) {
      const entry = findFile(htmlDirectory, attr[3])
      if (entry) await importAsset(entry)
    }
  }

  const linkTags = [...html.matchAll(/<link\b[^>]*>/gi)]
  for (const match of linkTags) {
    const tag = match[0]
    if (!/\brel\s*=\s*(["'])stylesheet\1/i.test(tag)) continue
    const href = /\bhref\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2]
    if (!href) continue
    const entry = findFile(htmlDirectory, href)
    if (!entry || !/\.css$/i.test(entry.path) || usedStyles.has(entry.path.toLowerCase())) continue
    usedStyles.add(entry.path.toLowerCase())
    const cssDirectory = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : ""
    let source = await entry.file.text()
    const cssUrls = [...source.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)]
    for (const urlMatch of cssUrls) {
      const asset = findFile(cssDirectory, urlMatch[2])
      if (asset) {
        await importAsset(asset)
        source = source.replace(urlMatch[0], `url("devon-asset://${asset.path}")`)
      }
    }
    css += `${source}\n`
    html = html.replace(tag, "")
  }

  const scriptTags = [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi)]
  for (const match of scriptTags) {
    const tag = match[0]
    const sourcePath = /\bsrc\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2]
    if (sourcePath) {
      const entry = findFile(htmlDirectory, sourcePath)
      if (entry && /\.m?js$/i.test(entry.path) && !usedScripts.has(entry.path.toLowerCase())) {
        usedScripts.add(entry.path.toLowerCase())
        scripts.push(await entry.file.text())
      }
      html = html.replace(tag, "")
    } else {
      scripts.push(tag.replace(/^<script\b[^>]*>/i, "").replace(/<\/script\s*>$/i, ""))
    }
  }

  const name = htmlEntry.path.split("/")[0] || htmlEntry.file.name
  return { project: { html, css, js: scripts.join("\n\n") }, assets, name, basePath: htmlDirectory }
}

function makePreview(project: Project, assets: LocalAssets = {}, htmlBasePath = ""): string {
  const csp =
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'\">"
  const assetUrl = (url: string, basePath: string) => {
    if (!url.startsWith("devon-asset://") && /^(?:data:|blob:|#|[a-z][a-z\d+.-]*:|\/\/)/i.test(url)) return url
    const path = url.startsWith("devon-asset://")
      ? normalizeProjectPath(url.slice("devon-asset://".length))
      : resolveProjectPath(basePath, url.split(/[?#]/, 1)[0])
    return assets[path.toLowerCase()] || ""
  }
  const safeCss = project.css
    .replace(/<\/style/gi, "<\\/style")
    .replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (whole, _quote: string, url: string) => {
      if (url.startsWith("devon-asset://")) {
        const asset = assetUrl(url, htmlBasePath)
        return asset ? `url("${asset}")` : "url(about:blank)"
      }
      if (/^(?:data:|blob:|#|[a-z][a-z\d+.-]*:|\/\/)/i.test(url)) return whole
      const asset = assetUrl(url, htmlBasePath)
      return asset ? `url("${asset}")` : "url(about:blank)"
    })
  const scriptText = JSON.stringify(project.js).replace(/</g, "\\u003c")
  const runner =
    `<script>(()=>{` +
    `const report=(message)=>parent.postMessage({type:"devon-html-lab-error",message:String(message).slice(0,1000)},"*");` +
    `addEventListener("error",event=>report(event.message||"JavaScript error"));` +
    `addEventListener("unhandledrejection",event=>report(event.reason?.message||event.reason||"Unhandled promise rejection"));` +
    `const code=${scriptText};if(!code.trim())return;` +
    `const script=document.createElement("script");script.src=URL.createObjectURL(new Blob([code],{type:"text/javascript"}));` +
    `script.onerror=()=>report("JavaScript could not run.");document.body.appendChild(script);` +
    `})();</script>`

  let document = project.html.trim()
  document = document.replace(/<(?:img|source|video|audio|track|input)\b[^>]*>/gi, (tag) =>
    tag.replace(/\b(src|poster)\s*=\s*(["'])(.*?)\2/gi, (whole, attr: string, quote: string, url: string) => {
      if (/^(?:data:|blob:|#|[a-z][a-z\d+.-]*:|\/\/)/i.test(url)) return whole
      const asset = assetUrl(url, htmlBasePath)
      return asset ? `${attr}=${quote}${asset}${quote}` : `${attr}=${quote}about:blank${quote}`
    }),
  )
  if (!/<html(?:\s|>)/i.test(document)) {
    document = `<!doctype html><html><head><meta charset="utf-8"></head><body>${document}</body></html>`
  }

  if (/<head(?:\s|>)/i.test(document)) {
    document = document.replace(/<head([^>]*)>/i, `<head$1>${csp}<style>${safeCss}</style>`)
  } else {
    document = document.replace(/<html([^>]*)>/i, `<html$1><head>${csp}<style>${safeCss}</style></head>`)
  }
  if (/<\/body>/i.test(document)) {
    document = document.replace(/<\/body>/i, `${runner}</body>`)
  } else if (/<\/html>/i.test(document)) {
    document = document.replace(/<\/html>/i, `${runner}</html>`)
  } else {
    document += runner
  }
  return document
}

/** HTML Lab (devon://apps/html-lab): an offline, live HTML/CSS/JavaScript playground. */
export function HtmlLabPage({ onOpenApps }: { onOpenApps: () => void }) {
  const [project, setProject] = useState<Project>(STARTER)
  const [activeTab, setActiveTab] = useState<EditorTab>("html")
  const [loaded, setLoaded] = useState(false)
  const [preview, setPreview] = useState(STARTER)
  const [previewAssets, setPreviewAssets] = useState<LocalAssets>({})
  const [runtimeError, setRuntimeError] = useState("")
  const [folderNotice, setFolderNotice] = useState("")
  const [copied, setCopied] = useState(false)
  const [htmlBasePath, setHtmlBasePath] = useState("")
  const frameRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    setProject(loadProject())
    setLoaded(true)
  }, [])

  useEffect(() => {
    if (!loaded) return
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(project))
    } catch {
      // Storage can be unavailable in private browsing.
    }
    const timer = window.setTimeout(() => {
      setRuntimeError("")
      setPreview(project)
    }, 180)
    return () => window.clearTimeout(timer)
  }, [project, loaded])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow || event.data?.type !== "devon-html-lab-error") return
      setRuntimeError(typeof event.data.message === "string" ? event.data.message : "JavaScript error")
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [])

  const previewDocument = useMemo(() => makePreview(preview, previewAssets, htmlBasePath), [preview, previewAssets, htmlBasePath])
  const update = (value: string) => setProject((current) => ({ ...current, [activeTab]: value }))
  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(project[activeTab])
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setRuntimeError("Could not access the clipboard. Select and copy the code from the editor.")
    }
  }
  const download = () => {
    const blob = new Blob([makePreview(project, previewAssets, htmlBasePath)], { type: "text/html;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = "devon-html-lab.html"
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const reset = () => {
    setProject(STARTER)
    setPreviewAssets({})
    setHtmlBasePath("")
    setRuntimeError("")
    setFolderNotice("")
  }
  const importFolder = async (files: FileList | null, input: HTMLInputElement) => {
    if (!files?.length) return
    try {
      const imported = await loadFolderProject(Array.from(files))
      setProject(imported.project)
      setPreviewAssets(imported.assets)
      setHtmlBasePath(imported.basePath)
      setFolderNotice(`Loaded ${imported.name} with ${files.length} files. Reopen the folder after a reload to restore its assets.`)
      setRuntimeError("")
      setActiveTab("html")
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "Could not load this folder.")
    } finally {
      input.value = ""
    }
  }

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <Button size="sm" variant="ghost" className="h-8 rounded-full px-3" onClick={onOpenApps}>
          <ArrowLeft /> Apps
        </Button>
        <span className="grid size-7 place-items-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/30">
          <Code2 className="size-4" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">HTML Lab</span>
        <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
          <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />
          Live preview
        </span>
        <Button size="sm" variant="ghost" className="h-8 px-2.5" onClick={reset} title="Reset starter code">
          <RotateCcw className="size-4" /> <span className="hidden sm:inline">Reset</span>
        </Button>
        <Button size="sm" variant="outline" className="h-8 px-2.5" onClick={() => document.getElementById("html-lab-folder-input")?.click()}>
          <FolderOpen className="size-4" /> <span className="hidden sm:inline">Open folder</span>
        </Button>
        <Button size="sm" variant="outline" className="h-8 px-2.5" onClick={download}>
          <Download className="size-4" /> <span className="hidden sm:inline">Download</span>
        </Button>
        <input
          id="html-lab-folder-input"
          type="file"
          className="hidden"
          multiple
          onChange={(event) => void importFolder(event.currentTarget.files, event.currentTarget)}
          ref={(element) => {
            element?.setAttribute("webkitdirectory", "")
            element?.setAttribute("directory", "")
          }}
        />
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(240px,1fr)_minmax(220px,0.9fr)] lg:grid-cols-2 lg:grid-rows-1">
        <section className="flex min-h-0 flex-col border-b border-border lg:border-b-0 lg:border-r" aria-label="Code editor">
          <div className="flex h-11 shrink-0 items-center border-b border-border px-2">
            <div className="flex min-w-0 flex-1 items-center gap-1" role="tablist" aria-label="Code files">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  id={`html-lab-tab-${tab.id}`}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  aria-controls="html-lab-editor"
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-xs transition",
                    activeTab === tab.id ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <Button size="sm" variant="ghost" className="h-8 px-2.5" onClick={() => void copyCode()}>
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
            </Button>
          </div>
          <div className="relative min-h-0 flex-1 bg-[#111318]">
            <label htmlFor="html-lab-editor" className="sr-only">
              {TABS.find((tab) => tab.id === activeTab)?.label} code
            </label>
            <textarea
              id="html-lab-editor"
              role="tabpanel"
              aria-labelledby={`html-lab-tab-${activeTab}`}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              value={project[activeTab]}
              onChange={(event) => update(event.target.value)}
              className="h-full w-full resize-none bg-transparent p-4 font-mono text-[13px] leading-6 text-slate-100 outline-none selection:bg-indigo-500/40"
              style={{ tabSize: 2 }}
            />
          </div>
          <footer className="flex h-8 shrink-0 items-center justify-between border-t border-border px-3 text-[11px] text-muted-foreground">
            <span>{TABS.find((tab) => tab.id === activeTab)?.language}</span>
            <span>{project[activeTab].split("\n").length} lines</span>
          </footer>
        </section>

        <section className="flex min-h-0 flex-col" aria-label="Live output">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
            <Eye className="size-4 text-muted-foreground" />
            <h2 className="flex-1 text-xs font-medium">Output</h2>
            <span className="text-[11px] text-muted-foreground">Sandboxed preview</span>
          </div>
          {folderNotice && <div role="status" className="border-b border-border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">{folderNotice}</div>}
          {runtimeError && (
            <div role="status" className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <span className="break-all">{runtimeError}</span>
            </div>
          )}
          <iframe
            ref={frameRef}
            title="HTML Lab live preview"
            sandbox="allow-scripts"
            srcDoc={previewDocument}
            className="min-h-0 flex-1 border-0 bg-white"
          />
        </section>
      </main>
    </div>
  )
}
