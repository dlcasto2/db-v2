"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Download, FileText, RefreshCw, Save, ShieldAlert, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { fileSystemRequest } from "@/lib/devon-ai/api"
import { refreshDevonAiSession } from "@/lib/devon-ai/store"
import { cn } from "@/lib/utils"

interface FileRecord {
  id: string
  path: string
  created: string
  version: number
  body?: string
  format: string
  provenance: { source: string; trust: string; createdAt: string; url?: string }
  tags: string[]
  expiresAt?: number
  deleted?: boolean
  metadata?: Record<string, string | number | boolean>
}

interface PromotionRequest {
  id: string
  sourcePath: string
  sourceVersion: number
  targetPath: string
  targetVersion: number
  reason: string
  proposedBody: string
  createdAt: number
}

const MOUNTS = ["scratch", "session", "pages", "inbox", "artifacts", "journal", "trash"] as const

export function DevonAiFilesystem({ conversationId }: { conversationId: string }) {
  const [records, setRecords] = useState<FileRecord[]>([])
  const [requests, setRequests] = useState<PromotionRequest[]>([])
  const [selected, setSelected] = useState<FileRecord | null>(null)
  const [versions, setVersions] = useState<FileRecord[]>([])
  const [body, setBody] = useState("")
  const [path, setPath] = useState("")
  const [expectedVersion, setExpectedVersion] = useState(0)
  const [selectedVersion, setSelectedVersion] = useState<number | "">("")
  const [mount, setMount] = useState("")
  const [tag, setTag] = useState("")
  const [url, setUrl] = useState("")
  const [trust, setTrust] = useState("")
  const [since, setSince] = useState("")
  const [until, setUntil] = useState("")
  const [promotionBodies, setPromotionBodies] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")

  const request = useCallback(
    <T,>(action: string, input: Record<string, unknown> = {}) => fileSystemRequest<T>(conversationId, action, input),
    [conversationId],
  )

  const refresh = useCallback(async () => {
    if (!conversationId) return
    setBusy(true)
    setError("")
    try {
      const query: Record<string, unknown> = { limit: 100 }
      if (mount) query.mount = mount
      if (tag.trim()) query.tag = tag.trim()
      if (url.trim()) query.url = url.trim()
      if (trust) query.trust = trust
      if (since) query.since = new Date(since).getTime()
      if (until) query.until = new Date(until).getTime() + 86_399_999
      const [listed, pending] = await Promise.all([
        request<{ records: FileRecord[] }>("list", { query }),
        request<{ requests: PromotionRequest[] }>("promotions"),
      ])
      setRecords(listed.records ?? [])
      setRequests(pending.requests ?? [])
      setPromotionBodies((prior) => {
        const next = { ...prior }
        for (const item of pending.requests ?? []) if (!(item.id in next)) next[item.id] = item.proposedBody
        return next
      })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load the document store.")
    } finally {
      setBusy(false)
    }
  }, [conversationId, mount, request, since, tag, trust, until, url])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const visibleRecords = useMemo(() => records.filter((record) => !record.deleted), [records])

  const openRecord = async (item: FileRecord, version?: number) => {
    setBusy(true)
    setError("")
    try {
      const [first, history] = await Promise.all([
        request<{ record: FileRecord; chunk: string; nextOffset: number | null }>("read", { path: item.path, ...(version ? { version } : {}), offset: 0, length: 10_000 }),
        request<{ versions: FileRecord[] }>("versions", { path: item.path }),
      ])
      let contents = first.chunk
      let offset = first.nextOffset
      while (offset !== null) {
        const next = await request<{ chunk: string; nextOffset: number | null }>("read", {
          path: item.path,
          ...(version ? { version } : {}),
          offset,
          length: 10_000,
        })
        contents += next.chunk
        offset = next.nextOffset
      }
      setSelected(first.record)
      setPath(first.record.path)
      setBody(contents)
      setSelectedVersion(first.record.version)
      setVersions(history.versions ?? [])
      setExpectedVersion(history.versions?.[history.versions.length - 1]?.version ?? first.record.version)
      setNotice("")
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not read the selected document.")
    } finally {
      setBusy(false)
    }
  }

  const newDocument = () => {
    setSelected(null)
    setVersions([])
    setPath("/artifacts/")
    setBody("")
    setExpectedVersion(0)
    setSelectedVersion("")
    setError("")
    setNotice("")
  }

  const save = async () => {
    setBusy(true)
    setError("")
    setNotice("")
    try {
      const result = await request<{ record?: FileRecord; conflict?: { current: FileRecord | null; diff: string } }>("write", {
        path,
        body,
        expectedVersion,
      })
      if (result.conflict) {
        setError(`This document changed since it was opened. Current version: ${result.conflict.current?.version ?? 0}.\n${result.conflict.diff}`)
        return
      }
      if (result.record) {
        setNotice(`Saved ${result.record.path} as version ${result.record.version}.`)
        await refreshDevonAiSession()
        await refresh()
        await openRecord(result.record)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save this document.")
    } finally {
      setBusy(false)
    }
  }

  const comparePrevious = async () => {
    if (!selected || selected.version < 2) return
    setBusy(true)
    setError("")
    try {
      const result = await request<{ diff: string }>("diff", {
        path: selected.path,
        fromVersion: selected.version - 1,
        toVersion: selected.version,
      })
      setNotice(result.diff)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not compare versions.")
    } finally {
      setBusy(false)
    }
  }

  const download = async () => {
    if (!selected) return
    setBusy(true)
    try {
      const result = await request<{ rendered: string }>("export", { path: selected.path, version: selected.version })
      const blob = new Blob([result.rendered], { type: "text/plain;charset=utf-8" })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = `${selected.path.split("/").pop() || "document"}.txt`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not export this document.")
    } finally {
      setBusy(false)
    }
  }

  const softDelete = async () => {
    if (!selected || !confirm(`Move ${selected.path} to /trash?`)) return
    setBusy(true)
    setError("")
    try {
      await request("delete", { path: selected.path })
      await refreshDevonAiSession()
      setSelected(null)
      setNotice("Document moved to /trash and retained for 30 days.")
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not soft-delete this document.")
    } finally {
      setBusy(false)
    }
  }

  const restore = async (item: FileRecord) => {
    setBusy(true)
    setError("")
    try {
      const result = await request<{ record: FileRecord }>("restore", { trashPath: item.path })
      await refreshDevonAiSession()
      setNotice(`Restored ${result.record.path} with ${result.record.provenance.trust} trust.`)
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not restore this document.")
    } finally {
      setBusy(false)
    }
  }

  const decide = async (item: PromotionRequest, approve: boolean) => {
    setBusy(true)
    setError("")
    try {
      await request(approve ? "approve" : "reject", {
        requestId: item.id,
        ...(approve ? { body: promotionBodies[item.id] ?? item.proposedBody } : {}),
      })
      if (approve) await refreshDevonAiSession()
      setNotice(approve ? `Approved transform into ${item.targetPath}.` : `Rejected promotion from ${item.sourcePath}.`)
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not record the promotion decision.")
    } finally {
      setBusy(false)
    }
  }

  const collectGarbage = async () => {
    setBusy(true)
    setError("")
    try {
      const result = await request<{ recordsRemoved: number }>("gc")
      setNotice(`Retention cleanup removed ${result.recordsRemoved} expired version records.`)
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not run retention cleanup.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="relative z-20 flex max-h-[65%] min-h-0 flex-shrink-0 flex-col overflow-y-auto border-b border-border bg-toolbar px-3 py-3 text-xs shadow-lg md:px-4">
      <header className="flex flex-wrap items-center gap-2">
        <FileText className="size-4 text-primary" />
        <strong className="mr-auto text-sm">Conversation files</strong>
        <Button size="sm" variant="ghost" className="h-7" disabled={busy} onClick={() => void refresh()} title="Refresh files">
          <RefreshCw className="size-3.5" />
        </Button>
        <Button size="sm" variant="ghost" className="h-7" disabled={busy} onClick={() => void collectGarbage()}>Run retention</Button>
        <Button size="sm" variant="ghost" className="h-7" disabled={busy} onClick={newDocument}>New artifact</Button>
      </header>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Inert, conversation-scoped Markdown/JSON/CSV/TSV. Writes are versioned; snapshots are untrusted-web. Export records to inspect or edit them outside Devon.
      </p>

      <div className="mt-2 grid gap-2 md:grid-cols-[minmax(190px,0.8fr)_minmax(0,1.2fr)]">
        <div className="min-h-32 space-y-2">
          <div className="flex flex-wrap gap-1">
            <select aria-label="Filter by mount" className="h-8 min-w-24 rounded-md border border-border bg-background px-2" value={mount} onChange={(event) => setMount(event.target.value)}>
              <option value="">All mounts</option>
              {MOUNTS.map((item) => <option key={item} value={item}>/{item}</option>)}
            </select>
            <select aria-label="Filter by trust" className="h-8 min-w-28 rounded-md border border-border bg-background px-2" value={trust} onChange={(event) => setTrust(event.target.value)}>
              <option value="">All trust</option>
              {["user", "system", "assistant", "untrusted-web"].map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>
          <input className="h-8 w-full rounded-md border border-border bg-background px-2" value={tag} onChange={(event) => setTag(event.target.value)} placeholder="Filter by tag" />
          <input className="h-8 w-full rounded-md border border-border bg-background px-2" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="Filter by source URL" />
          <div className="grid grid-cols-2 gap-1">
            <label className="text-[10px] text-muted-foreground">After<input aria-label="Filter records after date" type="date" className="mt-1 h-8 w-full rounded-md border border-border bg-background px-1 text-xs" value={since} onChange={(event) => setSince(event.target.value)} /></label>
            <label className="text-[10px] text-muted-foreground">Before<input aria-label="Filter records before date" type="date" className="mt-1 h-8 w-full rounded-md border border-border bg-background px-1 text-xs" value={until} onChange={(event) => setUntil(event.target.value)} /></label>
          </div>
          <div className="max-h-44 overflow-y-auto rounded-md border border-border">
            {visibleRecords.map((item) => (
              <button
                key={`${item.path}:${item.version}`}
                className={cn("block w-full border-b border-border/70 px-2 py-1.5 text-left hover:bg-white/[0.05]", selected?.path === item.path && "bg-white/[0.06]")}
                onClick={() => void openRecord(item)}
              >
                <span className="block truncate font-medium">{item.path}</span>
                <span className="text-[10px] text-muted-foreground">v{item.version} · {item.provenance.trust}</span>
              </button>
            ))}
            {!visibleRecords.length && <p className="px-2 py-3 text-muted-foreground">No matching records.</p>}
          </div>
        </div>

        <div className="min-w-0 space-y-2">
          <input className="h-8 w-full rounded-md border border-border bg-background px-2 font-mono" value={path} onChange={(event) => setPath(event.target.value)} placeholder="/artifacts/example.md" />
          {selected && (
            <div className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
              <span>{selected.provenance.trust} · {selected.provenance.source} · v{selected.version}</span>
              {selected.provenance.url && <span className="max-w-40 truncate" title={selected.provenance.url}>· {selected.provenance.url}</span>}
              <select aria-label="Select document version" className="h-7 rounded border border-border bg-background px-1" value={selectedVersion} onChange={(event) => void openRecord(selected, Number(event.target.value))}>
                {versions.map((item) => <option key={item.id} value={item.version}>Version {item.version}{item.deleted ? " · deleted" : ""}</option>)}
              </select>
            </div>
          )}
          <textarea
            className="min-h-36 w-full resize-y rounded-md border border-border bg-background p-2 font-mono text-[11px] leading-relaxed"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Document body…"
            maxLength={50_000}
          />
          <div className="flex flex-wrap gap-1">
            <Button size="sm" className="h-7" disabled={busy || !path.trim()} onClick={() => void save()}><Save className="mr-1 size-3.5" />Save v{expectedVersion + 1}</Button>
            {selected && <Button size="sm" variant="ghost" className="h-7" disabled={busy} onClick={() => void download()}><Download className="mr-1 size-3.5" />Export</Button>}
            {selected && selected.version > 1 && <Button size="sm" variant="ghost" className="h-7" disabled={busy} onClick={() => void comparePrevious()}>Diff previous</Button>}
            {selected && selected.path.split("/")[1] !== "journal" && selected.path.split("/")[1] !== "trash" && (
              <Button size="sm" variant="ghost" className="h-7 text-destructive" disabled={busy} onClick={() => void softDelete()}><Trash2 className="mr-1 size-3.5" />Move to trash</Button>
            )}
            {selected && <span className="self-center text-[10px] text-muted-foreground">Expected version {expectedVersion}</span>}
          </div>
        </div>
      </div>

      {!!requests.length && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <h3 className="flex items-center gap-1 font-semibold"><ShieldAlert className="size-3.5 text-amber-300" />Promotion review · {requests.length} pending</h3>
          {requests.map((item) => (
            <div key={item.id} className="space-y-1 rounded-md border border-amber-300/20 p-2">
              <p>{item.sourcePath} v{item.sourceVersion} → {item.targetPath} (target v{item.targetVersion})</p>
              <p className="text-muted-foreground">{item.reason}</p>
              <textarea
                aria-label={`Review promoted content from ${item.sourcePath}`}
                className="min-h-20 w-full rounded border border-border bg-background p-2 font-mono text-[11px]"
                value={promotionBodies[item.id] ?? item.proposedBody}
                onChange={(event) => setPromotionBodies((prior) => ({ ...prior, [item.id]: event.target.value }))}
                maxLength={50_000}
              />
              <div className="flex gap-1">
                <Button size="sm" className="h-7" disabled={busy} onClick={() => void decide(item, true)}>Approve reviewed transform</Button>
                <Button size="sm" variant="ghost" className="h-7" disabled={busy} onClick={() => void decide(item, false)}>Reject</Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {mount === "trash" && visibleRecords.map((item) => (
        <Button key={`restore:${item.path}`} size="sm" variant="ghost" className="mt-1 h-7 justify-start" disabled={busy} onClick={() => void restore(item)}>
          Restore {item.path}
        </Button>
      ))}
      {busy && <p role="status" className="mt-2 text-muted-foreground">Working…</p>}
      {error && <pre role="alert" className="mt-2 whitespace-pre-wrap rounded bg-destructive/10 p-2 text-[11px] text-destructive">{error}</pre>}
      {notice && <pre role="status" className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-white/[0.04] p-2 text-[11px] text-muted-foreground">{notice}</pre>}
    </section>
  )
}
