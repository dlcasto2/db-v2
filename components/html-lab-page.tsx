"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, Check, Code2, Copy, Download, Eye, RotateCcw, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type EditorTab = "html" | "css" | "js"
type Project = Record<EditorTab, string>

const STORAGE_KEY = "devon_html_lab"
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

function makePreview(project: Project): string {
  const csp =
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'\">"
  const safeCss = project.css.replace(/<\/style/gi, "<\\/style")
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
  const [runtimeError, setRuntimeError] = useState("")
  const [copied, setCopied] = useState(false)
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

  const previewDocument = useMemo(() => makePreview(preview), [preview])
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
    const blob = new Blob([makePreview(project)], { type: "text/html;charset=utf-8" })
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
    setRuntimeError("")
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
        <Button size="sm" variant="outline" className="h-8 px-2.5" onClick={download}>
          <Download className="size-4" /> <span className="hidden sm:inline">Download</span>
        </Button>
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
