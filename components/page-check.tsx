"use client"

import { useState } from "react"
import { Loader2, ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX, X } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { CATEGORY_LABELS, type PageCheck } from "@/lib/page-check"

export type PageCheckState =
  | { status: "checking" }
  | { status: "done"; result: PageCheck }
  | { status: "error"; message: string }

const VERDICT_STYLE = {
  safe: { icon: ShieldCheck, color: "text-emerald-400", label: "Looks safe" },
  caution: { icon: ShieldAlert, color: "text-amber-400", label: "Be careful" },
  danger: { icon: ShieldX, color: "text-red-400", label: "Dangerous page" },
} as const

const TRUST_LABELS = ["Untrustworthy", "Questionable", "Ordinary", "Reputable"]

function pct(n: number) {
  return `${Math.round(n * 100)}%`
}

function Meter({ label, value, invert = false }: { label: string; value: number; invert?: boolean }) {
  const bad = invert ? 1 - value : value
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[12px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono text-foreground">{pct(value)}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className={cn("h-full rounded-full", bad >= 0.75 ? "bg-red-400" : bad >= 0.45 ? "bg-amber-400" : "bg-emerald-400")}
          style={{ width: `${Math.max(2, value * 100)}%` }}
        />
      </div>
    </div>
  )
}

/** Toolbar shield: colour shows Jev's verdict, click for details */
export function PageCheckButton({ state, pageUrl }: { state: PageCheckState; pageUrl: string }) {
  const [open, setOpen] = useState(false)

  const result = state.status === "done" ? state.result : null
  const style = result ? VERDICT_STYLE[result.verdict] : null
  const Icon = style?.icon ?? ShieldQuestion
  const title =
    state.status === "checking"
      ? "Checking this page…"
      : state.status === "error"
        ? `Page check: ${state.message}`
        : `${style!.label} · ${CATEGORY_LABELS[result!.category]}`

  let host = pageUrl
  try {
    host = new URL(pageUrl).hostname.replace(/^www\./, "")
  } catch {}

  return (
    <>
      <button
        onClick={() => state.status !== "checking" && setOpen(true)}
        title={title}
        className={cn(
          "grid size-8 place-items-center rounded-full transition hover:bg-white/[0.08]",
          style?.color ?? "text-muted-foreground",
        )}
      >
        {state.status === "checking" ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4" />}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="gap-4 rounded-2xl border-border bg-toolbar sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Icon className={cn("size-5", style?.color ?? "text-muted-foreground")} />
              {style?.label ?? "Page check unavailable"}
            </DialogTitle>
            <DialogDescription className="break-all">{host}</DialogDescription>
          </DialogHeader>

          {state.status === "error" && <p className="text-sm text-muted-foreground">{state.message}</p>}

          {result && (
            <>
              <div className="flex flex-wrap gap-2 text-[12px]">
                <span className="rounded-full bg-white/[0.06] px-2.5 py-1 ring-1 ring-border">
                  {CATEGORY_LABELS[result.category]}
                  <span className="ml-1 text-muted-foreground">{pct(result.categoryConfidence)} sure</span>
                </span>
                <span className="rounded-full bg-white/[0.06] px-2.5 py-1 ring-1 ring-border">
                  {TRUST_LABELS[Math.round(Math.min(3, Math.max(0, result.trust)))]} site
                </span>
              </div>

              {result.reasons.length > 0 && (
                <ul className="space-y-1.5 text-[13px]">
                  {result.reasons.map((r) => (
                    <li key={r} className="flex gap-2">
                      <ShieldAlert className="mt-0.5 size-3.5 flex-shrink-0 text-amber-400" />
                      {r}
                    </li>
                  ))}
                </ul>
              )}

              <div className="space-y-2.5 rounded-xl bg-white/[0.03] p-3 ring-1 ring-border">
                <Meter label="Phishing" value={result.phishing} />
                <Meter label="Scam" value={result.scam} />
                <Meter label="Domain matches brand" value={result.brandMatch} invert />
              </div>

              <p className="text-[11px] text-muted-foreground">
                Checked by {result.model} (TypeSafe Jev){result.cached ? " · cached" : ""}. Automated checks can be
                wrong, so don&apos;t rely on this alone before entering passwords or payment details.
              </p>
            </>
          )}

          <div className="flex justify-end">
            <Button variant="ghost" className="rounded-full" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Warning strip above the page when Jev thinks it's dangerous */
export function PageCheckBanner({ result, onDismiss, onLeave }: { result: PageCheck; onDismiss: () => void; onLeave: () => void }) {
  if (result.verdict !== "danger") return null
  return (
    <div className="flex items-center gap-3 border-b border-red-400/20 bg-red-500/10 px-3 py-2 text-[13px] text-red-100">
      <ShieldX className="size-4 flex-shrink-0 text-red-400" />
      <span className="flex-1">
        <strong className="font-semibold">This page may be dangerous.</strong> {result.reasons[0]}{" "}
        Don&apos;t enter passwords or payment details here.
      </span>
      <Button size="sm" variant="secondary" className="h-7 rounded-full text-xs" onClick={onLeave}>
        Go back
      </Button>
      <button
        onClick={onDismiss}
        className="grid size-6 place-items-center rounded-full text-red-200/80 hover:bg-white/[0.08] hover:text-red-100"
        title="Dismiss"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
