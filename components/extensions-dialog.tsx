"use client"

import { useRef, useState } from "react"
import {
  AlertTriangle,
  ChevronDown,
  Code2,
  FileCode2,
  Loader2,
  MoreVertical,
  Pencil,
  Puzzle,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  type Extension,
  NEW_USERSCRIPT_TEMPLATE,
  NOW_SUPPORTED,
  downloadViaProxy,
  installChromePackage,
  installFromChromeWebStore,
  installUserscript,
  installUserscriptFromUrl,
  removeExtension,
  setEnabled,
} from "@/lib/extensions/store"
import { cn } from "@/lib/utils"

interface ExtensionsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  extensions: Extension[]
  /** Called after any install/remove/toggle so the app reloads the registry */
  onChanged: (message?: string) => Promise<void> | void
  /** Opens an extension's popup or options page */
  onOpenPage?: (extId: string, kind: "popup" | "options") => void
}

const isWebStoreInput = (s: string) => /chromewebstore\.google\.com|chrome\.google\.com\/webstore/i.test(s) || /^[a-p]{32}$/.test(s)

/** Install a Chrome extension or userscript from a link (used by the dialog and by .user.js navigation) */
export async function installFromLink(link: string): Promise<Extension> {
  const value = link.trim()
  if (isWebStoreInput(value)) return installFromChromeWebStore(value)
  if (!/^https?:\/\//i.test(value)) throw new Error("Paste a full link starting with https://")
  if (/\.(zip|crx)(\?|#|$)/i.test(value)) {
    return installChromePackage(await downloadViaProxy(value), value)
  }
  return installUserscriptFromUrl(value)
}

function runsOn(ext: Extension): string[] {
  if (ext.type === "userscript") {
    const rules = [...ext.meta.match, ...ext.meta.include]
    return rules.length ? rules : ["All sites"]
  }
  return [...new Set(ext.contentScripts.flatMap((r) => r.matches))]
}

export function ExtensionsDialog({ open, onOpenChange, extensions, onChanged, onOpenPage }: ExtensionsDialogProps) {
  const [link, setLink] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id?: string; code: string } | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const run = async (label: string, task: () => Promise<string | undefined>) => {
    setBusy(label)
    setError(null)
    try {
      const message = await task()
      await onChanged(message)
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy(null)
    }
  }

  const installLink = () =>
    run("link", async () => {
      const ext = await installFromLink(link)
      setLink("")
      return `Installed ${ext.name}`
    })

  const installFiles = (files: FileList | null) => {
    if (!files?.length) return
    run("file", async () => {
      const names: string[] = []
      for (const file of Array.from(files)) {
        if (/\.(user\.)?js$/i.test(file.name)) {
          names.push((await installUserscript(await file.text(), file.name)).name)
        } else {
          names.push((await installChromePackage(await file.arrayBuffer(), file.name)).name)
        }
      }
      return `Installed ${names.join(", ")}`
    })
    if (fileRef.current) fileRef.current.value = ""
  }

  const saveScript = async () => {
    if (!editing) return
    const ok = await run("save", async () => {
      const script = await installUserscript(editing.code, undefined, editing.id)
      return `Saved ${script.name}`
    })
    if (ok) setEditing(null)
  }

  const reinstall = (ext: Extension) =>
    run(ext.id, async () => {
      if (!ext.source) throw new Error("This extension wasn't installed from a link")
      const updated = await installFromLink(ext.source)
      return `Updated ${updated.name}`
    })

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) {
          setEditing(null)
          setError(null)
        }
      }}
    >
      <DialogContent className="flex max-h-[min(720px,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden rounded-2xl border-border bg-toolbar p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border px-5 py-4 text-left">
          <DialogTitle className="flex items-center gap-2 text-base">
            {editing ? <Code2 className="size-4 text-primary" /> : <Puzzle className="size-4 text-primary" />}
            {editing ? (editing.id ? "Edit userscript" : "New userscript") : "Extensions"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {editing
              ? "Changes apply the next time a matching page loads."
              : "Chrome extensions (content scripts) and userscripts run on the pages they match."}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="mx-5 mt-4 flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-[13px] text-destructive ring-1 ring-destructive/20">
            <AlertTriangle className="mt-0.5 size-4 flex-shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        )}

        {editing ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3 p-5">
            <textarea
              value={editing.code}
              onChange={(e) => setEditing({ ...editing, code: e.target.value })}
              spellCheck={false}
              className="min-h-[360px] flex-1 resize-none rounded-lg bg-background p-3 font-mono text-[12px] leading-relaxed text-foreground ring-1 ring-border outline-none focus:ring-2 focus:ring-primary/60 select-text"
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" className="rounded-full" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button className="rounded-full px-5" onClick={saveScript} disabled={busy === "save"}>
                {busy === "save" && <Loader2 className="animate-spin" />} Save
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-2 border-b border-border px-5 py-4">
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (link.trim()) installLink()
                }}
              >
                <input
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  placeholder="Chrome Web Store link, or a .user.js / .zip / .crx URL"
                  spellCheck={false}
                  className="h-9 min-w-0 flex-1 rounded-full bg-omnibox px-4 text-sm ring-1 ring-border outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/60 select-text"
                />
                <Button type="submit" className="h-9 rounded-full px-4" disabled={!link.trim() || busy !== null}>
                  {busy === "link" && <Loader2 className="animate-spin" />} Install
                </Button>
              </form>
              <div className="flex flex-wrap gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept=".zip,.crx,.js"
                  multiple
                  hidden
                  onChange={(e) => installFiles(e.target.files)}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  className="rounded-full text-xs"
                  onClick={() => fileRef.current?.click()}
                  disabled={busy !== null}
                >
                  {busy === "file" ? <Loader2 className="animate-spin" /> : <Upload />} Load .zip / .crx / .user.js
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="rounded-full text-xs"
                  onClick={() => setEditing({ code: NEW_USERSCRIPT_TEMPLATE })}
                >
                  <FileCode2 /> New userscript
                </Button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin p-3">
              {extensions.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
                  <span className="grid size-12 place-items-center rounded-2xl bg-white/[0.05] ring-1 ring-border">
                    <Puzzle className="size-5 text-muted-foreground" />
                  </span>
                  <p className="text-sm font-medium">No extensions yet</p>
                  <p className="max-w-sm text-xs text-muted-foreground">
                    Paste a Chrome Web Store link, load an unpacked extension as a .zip, or install a userscript from
                    Greasy Fork or OpenUserJS.
                  </p>
                </div>
              ) : (
                <ul className="space-y-1">
                  {extensions.map((ext) => {
                    const open = expanded === ext.id
                    return (
                      <li key={ext.id} className="rounded-xl px-3 py-2.5 transition-colors hover:bg-white/[0.04]">
                        <div className="flex items-start gap-3">
                          <span className="mt-0.5 grid size-9 flex-shrink-0 place-items-center overflow-hidden rounded-lg bg-white/[0.06]">
                            {ext.icon ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={ext.icon} alt="" className="size-6 object-contain" />
                            ) : ext.type === "userscript" ? (
                              <FileCode2 className="size-4 text-muted-foreground" />
                            ) : (
                              <Puzzle className="size-4 text-muted-foreground" />
                            )}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                              <span className={cn("truncate text-sm font-medium", !ext.enabled && "text-muted-foreground")}>
                                {ext.name}
                              </span>
                              {ext.version && <span className="text-[11px] text-muted-foreground">{ext.version}</span>}
                              <span
                                className={cn(
                                  "rounded-full px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide",
                                  ext.type === "chrome" ? "bg-primary/15 text-primary" : "bg-emerald-400/15 text-emerald-300",
                                )}
                              >
                                {ext.type === "chrome" ? "Chrome" : "Userscript"}
                              </span>
                            </div>
                            {ext.description && (
                              <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{ext.description}</p>
                            )}
                            {ext.type === "chrome" &&
                              ext.unsupported.filter((u) => !NOW_SUPPORTED.includes(u)).length > 0 && (
                                <p className="mt-1 flex items-center gap-1 text-[11px] text-amber-300/90">
                                  <AlertTriangle className="size-3 flex-shrink-0" />
                                  Not available in Devon: {ext.unsupported.filter((u) => !NOW_SUPPORTED.includes(u)).join(", ")}
                                </p>
                              )}
                            {ext.type === "chrome" && ext.enabled && (ext.pages?.popup || ext.pages?.options) && onOpenPage && (
                              <div className="mt-1 flex gap-2">
                                {ext.pages?.popup && (
                                  <button
                                    onClick={() => {
                                      onOpenChange(false)
                                      onOpenPage(ext.id, "popup")
                                    }}
                                    className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] text-foreground hover:bg-white/[0.12]"
                                  >
                                    Open popup
                                  </button>
                                )}
                                {ext.pages?.options && (
                                  <button
                                    onClick={() => {
                                      onOpenChange(false)
                                      onOpenPage(ext.id, "options")
                                    }}
                                    className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] text-foreground hover:bg-white/[0.12]"
                                  >
                                    Options
                                  </button>
                                )}
                              </div>
                            )}
                            <button
                              onClick={() => setExpanded(open ? null : ext.id)}
                              className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                            >
                              Runs on <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
                            </button>
                            {open && (
                              <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-muted-foreground">
                                {runsOn(ext).length ? (
                                  runsOn(ext).map((r) => (
                                    <li key={r} className="truncate">
                                      {r}
                                    </li>
                                  ))
                                ) : (
                                  <li>Nothing (no content scripts)</li>
                                )}
                              </ul>
                            )}
                          </div>
                          <div className="flex flex-shrink-0 items-center gap-1">
                            {busy === ext.id && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
                            <Switch
                              checked={ext.enabled}
                              aria-label={ext.enabled ? `Turn off ${ext.name}` : `Turn on ${ext.name}`}
                              onCheckedChange={(on) =>
                                run(ext.id, async () => {
                                  await setEnabled(ext.id, on)
                                  return undefined
                                })
                              }
                            />
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button
                                  className="grid size-7 place-items-center rounded-full text-muted-foreground outline-none hover:bg-white/[0.08] hover:text-foreground"
                                  title="More"
                                >
                                  <MoreVertical className="size-4" />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-48 rounded-xl p-1.5">
                                {ext.type === "userscript" && (
                                  <DropdownMenuItem onSelect={() => setEditing({ id: ext.id, code: ext.code })}>
                                    <Pencil /> Edit
                                  </DropdownMenuItem>
                                )}
                                {ext.source && /^https?:/.test(ext.source) && (
                                  <DropdownMenuItem onSelect={() => reinstall(ext)}>
                                    <RefreshCw /> Update from source
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  variant="destructive"
                                  onSelect={() => {
                                    if (!confirm(`Remove ${ext.name}? Its saved data will be deleted too.`)) return
                                    run(ext.id, async () => {
                                      await removeExtension(ext.id)
                                      return `Removed ${ext.name}`
                                    })
                                  }}
                                >
                                  <Trash2 /> Remove
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
