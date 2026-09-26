"use client"

import { useEffect, useState } from "react"
import { AlertTriangle, Check, Copy, Loader2 } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { type PageActivity, type PageError, buildReport } from "@/lib/diagnostics"

/** Dispatch on window to open the report dialog even when nothing failed */
export const OPEN_REPORT_EVENT = "devon-open-report"

function shortFile(url: string) {
  try {
    const u = new URL(url)
    const last = u.pathname.split("/").filter(Boolean).pop() || u.pathname
    return `${u.hostname.replace(/^www\./, "")} › ${last}`
  } catch {
    return url || "(inline script)"
  }
}

/** Toolbar button (shown when the page reported errors) + report dialog */
export function PageProblems({
  errors,
  pageUrl,
  activity = [],
  getFrame,
}: {
  errors: PageError[]
  pageUrl: string
  activity?: PageActivity[]
  getFrame?: () => Window | null
}) {
  const [open, setOpen] = useState(false)
  const [report, setReport] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const onOpen = () => {
      setReport(null)
      setCopied(false)
      setOpen(true)
    }
    window.addEventListener(OPEN_REPORT_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_REPORT_EVENT, onOpen)
  }, [])

  const makeReport = async () => {
    setBusy(true)
    setCopied(false)
    try {
      const text = await buildReport(errors, pageUrl, { activity, frame: getFrame?.() ?? null })
      setReport(text)
      try {
        await navigator.clipboard.writeText(text)
        setCopied(true)
      } catch {
        // clipboard blocked: the text is shown for manual copying
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {errors.length > 0 && (
      <button
        onClick={() => {
          setReport(null)
          setCopied(false)
          setOpen(true)
        }}
        title={`${errors.length} ${errors.length === 1 ? "problem" : "problems"} on this page`}
        className="relative grid size-8 place-items-center rounded-full text-amber-400 transition hover:bg-white/[0.08]"
      >
        <AlertTriangle className="size-4" />
        <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-amber-400 px-1 text-[10px] font-semibold leading-none text-black">
          {errors.length > 99 ? "99+" : errors.length}
        </span>
      </button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="gap-4 rounded-2xl border-border bg-toolbar sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-amber-400" />
              Page problems
            </DialogTitle>
            <DialogDescription>
              Scripts or requests on this page failed. &ldquo;Copy report&rdquo; re-downloads the failing files to check
              whether they arrive complete, and copies everything so you can share it.
            </DialogDescription>
          </DialogHeader>

          <ul className="max-h-60 space-y-2 overflow-y-auto scrollbar-thin">
            {errors.map((e, i) => (
              <li key={i} className="rounded-lg bg-white/[0.04] p-2.5 ring-1 ring-border">
                <p className="break-words text-[13px] font-medium text-foreground">{e.message}</p>
                <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={e.file}>
                  {shortFile(e.file)}
                  {e.line ? `:${e.line}:${e.col ?? 0}` : ""}
                </p>
              </li>
            ))}
          </ul>

          {report && (
            <textarea
              readOnly
              value={report}
              onFocus={(ev) => ev.currentTarget.select()}
              className="h-40 w-full resize-none rounded-lg bg-omnibox p-2.5 font-mono text-[11px] text-muted-foreground outline-none ring-1 ring-border"
            />
          )}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" className="rounded-full" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button className="rounded-full px-5" onClick={makeReport} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : copied ? <Check /> : <Copy />}
              {busy ? "Checking files…" : copied ? "Copied" : "Copy report"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
