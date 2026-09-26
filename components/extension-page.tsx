"use client"

import { useEffect, useRef, useState } from "react"
import { Loader2, Puzzle, X } from "lucide-react"
import type { ExtensionHost } from "@/lib/extensions/runtime"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"

interface Props {
  host: ExtensionHost | null
  extId: string
  name: string
  icon?: string
  onClose: () => void
}

function useMountedPage(host: ExtensionHost | null, extId: string, kind: "popup" | "options", onClose: () => void) {
  // Callback ref: dialogs render their content a moment later (portal), so wait for the frame
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  frameRef.current = frame
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (!frame || !host) return
    setError(null)
    setReady(false)
    host
      .mountPage(frame, extId, kind)
      .then(() => setReady(true))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [host, extId, kind, frame])

  // Escape inside the extension page (focus is in the frame, so the dialog never sees it)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const win = ready ? frame?.contentWindow : null
    if (!win) return
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current()
    win.addEventListener("keydown", onKey)
    return () => {
      try {
        win.removeEventListener("keydown", onKey)
      } catch {
        // frame gone
      }
    }
  }, [ready, frame])
  return { frameRef, setFrame, error, ready }
}

/** An extension's toolbar popup, shown under the toolbar like Chrome's */
export function ExtensionPopup({ host, extId, name, onClose }: Props) {
  const { frameRef, setFrame, error, ready } = useMountedPage(host, extId, "popup", onClose)
  const [size, setSize] = useState({ w: 320, h: 120 })
  const panelRef = useRef<HTMLDivElement | null>(null)

  // Chrome sizes popups to their content (up to 800 x 600)
  useEffect(() => {
    if (!ready) return
    const id = window.setInterval(() => {
      const doc = frameRef.current?.contentDocument
      if (!doc?.documentElement) return
      const body = doc.body
      const w = Math.max(doc.documentElement.scrollWidth, body?.scrollWidth ?? 0)
      const h = Math.max(doc.documentElement.scrollHeight, body?.scrollHeight ?? 0)
      setSize((prev) => {
        const next = { w: Math.min(800, Math.max(160, w)), h: Math.min(600, Math.max(40, h)) }
        return prev.w === next.w && prev.h === next.h ? prev : next
      })
    }, 250)
    return () => window.clearInterval(id)
  }, [ready, frameRef])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    const onDown = (e: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener("keydown", onKey)
    window.addEventListener("pointerdown", onDown, true)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("pointerdown", onDown, true)
    }
  }, [onClose])

  return (
    <div
      ref={panelRef}
      className="fixed right-2 top-[92px] z-50 overflow-hidden rounded-xl bg-white shadow-2xl ring-1 ring-black/20"
      style={{ width: Math.min(size.w, window.innerWidth - 16) }}
      role="dialog"
      aria-label={`${name} popup`}
    >
      {error ? (
        <div className="w-80 bg-popover p-4 text-sm text-foreground">
          <p className="mb-1 flex items-center gap-2 font-medium">
            <Puzzle className="size-4 text-primary" /> {name}
          </p>
          <p className="text-xs text-destructive">{error}</p>
        </div>
      ) : (
        <>
          {!ready && (
            <div className="flex h-24 w-80 items-center justify-center bg-popover text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          )}
          <iframe
            ref={setFrame}
            title={`${name} popup`}
            className="block border-0 bg-white"
            style={{ width: "100%", height: ready ? size.h : 0 }}
          />
        </>
      )}
    </div>
  )
}

/** An extension's options page, in a dialog */
export function ExtensionOptions({ host, extId, name, icon, onClose }: Props) {
  const { setFrame, error, ready } = useMountedPage(host, extId, "options", onClose)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[85vh] max-w-[min(960px,calc(100vw-1.5rem))] flex-col gap-3 rounded-2xl border-border bg-toolbar p-4 sm:max-w-[min(960px,calc(100vw-1.5rem))]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            {icon ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={icon} alt="" className="size-5 object-contain" />
            ) : (
              <Puzzle className="size-4 text-primary" />
            )}
            {name} options
          </DialogTitle>
        </DialogHeader>
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl bg-white ring-1 ring-border">
          {error ? (
            <p className="p-4 text-sm text-destructive">{error}</p>
          ) : (
            <>
              {!ready && (
                <div className="absolute inset-0 grid place-items-center text-muted-foreground">
                  <Loader2 className="size-5 animate-spin" />
                </div>
              )}
              <iframe ref={setFrame} title={`${name} options`} className="size-full border-0 bg-white" />
            </>
          )}
        </div>
        <button onClick={onClose} className="sr-only">
          <X /> Close
        </button>
      </DialogContent>
    </Dialog>
  )
}
