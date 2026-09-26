"use client"

import { useEffect, useRef, useState } from "react"
import { AlertTriangle, CheckCircle2, Download, FileArchive, Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Switch } from "@/components/ui/switch"
import { Favicon } from "@/components/favicon"
import { archivePage, saveBlob, type ArchiveProgress, type ArchiveResult } from "@/lib/page-archiver"

export interface SaveTarget {
  /** The live, same-origin document of the proxied page */
  doc: Document
  url: string
  title: string
  favicon?: string
}

type Phase =
  | { kind: "idle" }
  | { kind: "running"; progress: ArchiveProgress }
  | { kind: "done"; result: ArchiveResult }
  | { kind: "error"; message: string }

const SCRIPTS_PREF = "devon-save-scripts"

function readPref(): boolean {
  try {
    return localStorage.getItem(SCRIPTS_PREF) === "1"
  } catch {
    return false
  }
}

function progressValue(p: ArchiveProgress): number {
  if (p.stage === "reading") return 3
  if (p.stage === "assets") return 5 + (p.total ? (p.done / p.total) * 80 : 80)
  return 85 + p.percent * 0.15
}

function progressLabel(p: ArchiveProgress): string {
  if (p.stage === "reading") return "Reading page…"
  if (p.stage === "assets") return p.total ? `Downloading assets ${p.done} / ${p.total}` : "Downloading assets…"
  return `Zipping ${p.percent}%`
}

function displayUrl(url: string) {
  return url.replace(/^https?:\/\/(www\.)?/, "")
}

export function SavePageDialog({
  open,
  onOpenChange,
  getTarget,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called when saving starts, so the snapshot is of the page as it is right then */
  getTarget: () => SaveTarget | null
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" })
  const [saveScripts, setSaveScripts] = useState(false)
  const [preview, setPreview] = useState<SaveTarget | null>(null)
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (open) {
      setPhase({ kind: "idle" })
      setSaveScripts(readPref())
      setPreview(getTarget())
    } else {
      controllerRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const toggleScripts = (on: boolean) => {
    setSaveScripts(on)
    try {
      localStorage.setItem(SCRIPTS_PREF, on ? "1" : "0")
    } catch {
      // not persisted
    }
  }

  const start = async () => {
    const target = getTarget()
    if (!target) {
      setPhase({ kind: "error", message: "The page isn't loaded yet. Wait for it to finish, then try again." })
      return
    }
    const controller = new AbortController()
    controllerRef.current = controller
    setPhase({ kind: "running", progress: { stage: "reading" } })
    try {
      const result = await archivePage(
        target.doc,
        target.url,
        target.title,
        { saveScripts, signal: controller.signal },
        (progress) => {
          if (!controller.signal.aborted) setPhase({ kind: "running", progress })
        },
      )
      saveBlob(result.blob, result.filename)
      setPhase({ kind: "done", result })
    } catch (err) {
      if (controller.signal.aborted) return
      setPhase({ kind: "error", message: err instanceof Error ? err.message : "Saving failed." })
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }

  const running = phase.kind === "running"

  return (
    <Dialog open={open} onOpenChange={(next) => (!running || !next ? onOpenChange(next) : undefined)}>
      <DialogContent className="gap-5 rounded-2xl border-border bg-toolbar sm:max-w-md" showCloseButton={!running}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileArchive className="size-5 text-primary" />
            Save page offline
          </DialogTitle>
          <DialogDescription>
            Downloads this page and its images, styles and fonts as a ZIP. Unzip it and open{" "}
            <span className="font-mono text-foreground/80">index.html</span> to view it without a connection. On iPhone
            or iPad, tap the ZIP in Files to unzip it.
          </DialogDescription>
        </DialogHeader>

        {preview && (
          <div className="flex items-center gap-3 rounded-xl bg-white/[0.04] p-3 ring-1 ring-border">
            <span className="grid size-9 flex-shrink-0 place-items-center rounded-lg bg-white/[0.06]">
              <Favicon src={preview.favicon} className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{preview.title}</p>
              <p className="truncate text-xs text-muted-foreground">{displayUrl(preview.url)}</p>
            </div>
          </div>
        )}

        {phase.kind === "idle" && (
          <label className="flex cursor-pointer items-start gap-3 rounded-xl p-1">
            <Switch checked={saveScripts} onCheckedChange={toggleScripts} className="mt-0.5" />
            <span className="text-sm">
              <span className="font-medium">Include scripts</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Keeps menus and other interactive parts working. Some sites redraw themselves on load and open blank
                offline. If that happens, save again with this off.
              </span>
            </span>
          </label>
        )}

        {phase.kind === "running" && (
          <div className="space-y-2">
            <Progress value={progressValue(phase.progress)} className="h-1.5" />
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {progressLabel(phase.progress)}
            </p>
          </div>
        )}

        {phase.kind === "done" && (
          <div className="space-y-3">
            <p className="flex items-start gap-2 text-sm">
              <CheckCircle2 className="mt-0.5 size-4 flex-shrink-0 text-emerald-400" />
              <span>
                Saved <span className="font-medium">{phase.result.filename}</span> with {phase.result.saved}{" "}
                {phase.result.saved === 1 ? "file" : "files"}.
              </span>
            </p>
            {phase.result.failed.length > 0 && (
              <details className="rounded-lg bg-white/[0.03] ring-1 ring-border">
                <summary className="cursor-pointer px-3 py-2 text-xs text-amber-300">
                  {phase.result.failed.length} {phase.result.failed.length === 1 ? "file" : "files"}{" "}
                  couldn&apos;t be downloaded (also listed in metadata.json)
                </summary>
                <ul className="max-h-36 space-y-1 overflow-auto scrollbar-thin px-3 pb-3 font-mono text-[11px] text-muted-foreground">
                  {phase.result.failed.map((f) => (
                    <li key={f} className="truncate" title={f}>
                      {f}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}

        {phase.kind === "error" && (
          <p className="flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-4 flex-shrink-0" />
            {phase.message}
          </p>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          {phase.kind === "running" ? (
            <Button variant="ghost" className="rounded-full" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          ) : phase.kind === "done" ? (
            <>
              <Button
                variant="ghost"
                className="rounded-full"
                onClick={() => saveBlob(phase.result.blob, phase.result.filename)}
              >
                <Download /> Download again
              </Button>
              <Button className="rounded-full px-5" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" className="rounded-full" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button className="rounded-full px-5" onClick={start} disabled={!preview}>
                <Download /> {phase.kind === "error" ? "Try again" : "Save ZIP"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
