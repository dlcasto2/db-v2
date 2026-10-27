/**
 * Devon AI's virtual document store, shared by both server backends.
 *
 * Records are inert UTF-8 documents with append-only versions and provenance.
 * The backing store is the conversation-scoped platform message store; no
 * sandbox path or model-controlled trust label is used as authority.
 */

import { createHash, randomUUID } from "node:crypto"
import type { AgentMemory } from "@edgeone/types"

export type FileTrust = "user" | "system" | "assistant" | "untrusted-web"
export type FileFormat = "md" | "json" | "csv" | "tsv"
export type FileActor = FileTrust

export interface FileProvenance {
  source: string
  trust: FileTrust
  createdAt: string
  tab?: string
  url?: string
  toolCall?: string
}

export interface FileRecord {
  id: string
  path: string
  created: string
  version: number
  supersedes?: string
  format: FileFormat
  body: string
  provenance: FileProvenance
  tags: string[]
  expiresAt?: number
  deleted?: boolean
  metadata?: Record<string, string | number | boolean>
}

export interface PromotionRequest {
  id: string
  sourcePath: string
  sourceVersion: number
  targetPath: string
  targetVersion: number
  reason: string
  proposedBody: string
  status: "pending" | "approved" | "rejected"
  createdAt: number
}

export interface FileListQuery {
  path?: string
  mount?: string
  tag?: string
  url?: string
  trust?: FileTrust
  since?: number
  until?: number
  limit?: number
}

export type FileStore = Pick<AgentMemory, "appendMessage" | "getMessages" | "deleteMessage"> & {
  state: Pick<AgentMemory["state"], "get" | "set" | "delete">
}

const MAX_RECORDS = 500
const MAX_TOTAL_BYTES = 5_000_000
const MOUNT_RECORD_LIMITS: Record<string, number> = {
  scratch: 100,
  session: 100,
  pages: 200,
  inbox: 50,
  artifacts: 100,
  journal: 200,
  trash: 100,
}
const MOUNT_BYTE_LIMITS: Record<string, number> = {
  scratch: 1_000_000,
  session: 500_000,
  pages: 2_000_000,
  inbox: 1_000_000,
  artifacts: 2_000_000,
  journal: 1_000_000,
  trash: 1_000_000,
}
const MAX_DOCUMENT_BYTES = 50_000
const MAX_READ_CHARS = 10_000
const MAX_LIST_RESULTS = 100
const MAX_PAGE_SNAPSHOTS_PER_TAB = 20
const MAX_PAGE_SNAPSHOTS_TOTAL = 80
const PAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const SCRATCH_TTL_MS = 24 * 60 * 60 * 1000
const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000
const ALLOWED_FORMATS = new Set<FileFormat>(["md", "json", "csv", "tsv"])
const MOUNTS = new Set(["scratch", "session", "pages", "inbox", "artifacts", "journal", "trash"])

type JournalEvent = {
  kind: "version" | "promotion_request" | "promotion_decision"
  record?: FileRecord
  request?: PromotionRequest
  requestId?: string
  status?: "approved" | "rejected"
  createdAt: number
}

type StoredEvent = JournalEvent & { messageId: string }
type AppendableStore = Pick<FileStore, "appendMessage" | "getMessages" | "deleteMessage">

export class FileSystemError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FileSystemError"
  }
}

function bucket(conversationId: string): string {
  const hash = createHash("sha256").update(`devon-filesystem:${conversationId}`).digest("hex").slice(0, 40)
  return `df-${hash}`
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0
  let result = ""
  for (const character of text) {
    const size = byteLength(character)
    if (bytes + size > maxBytes) break
    result += character
    bytes += size
  }
  return result
}

function parseEvent(content: unknown, messageId: string): StoredEvent | null {
  if (Array.isArray(content)) {
    const text = content.find((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string")
    content = text ? (text as { text: string }).text : ""
  }
  if (typeof content !== "string") return null
  try {
    const value = JSON.parse(content) as JournalEvent
    if (!value || typeof value !== "object" || typeof value.createdAt !== "number") return null
    if (value.kind !== "version" && value.kind !== "promotion_request" && value.kind !== "promotion_decision") return null
    return { ...value, messageId }
  } catch {
    return null
  }
}

async function events(store: AppendableStore, conversationId: string): Promise<StoredEvent[]> {
  const entries = await store.getMessages({ conversationId: bucket(conversationId), limit: MAX_RECORDS, order: "asc" })
  return entries
    .filter((entry) => entry.role === "system")
    .map((entry) => parseEvent(entry.content, entry.messageId))
    .filter((entry): entry is StoredEvent => Boolean(entry))
}

function currentRecords(all: StoredEvent[]): Map<string, FileRecord> {
  const current = new Map<string, FileRecord>()
  for (const event of all) {
    if (event.kind !== "version" || !event.record) continue
    const prior = current.get(event.record.path)
    if (
      !prior ||
      event.record.version > prior.version ||
      (event.record.version === prior.version &&
        `${event.record.created}:${event.record.id}` > `${prior.created}:${prior.id}`)
    ) {
      current.set(event.record.path, event.record)
    }
  }
  return current
}

function historyFor(all: StoredEvent[], path: string): StoredEvent[] {
  return all
    .filter((event) => event.kind === "version" && event.record?.path === path)
    .sort((a, b) => {
      const versionOrder = (a.record?.version ?? 0) - (b.record?.version ?? 0)
      if (versionOrder) return versionOrder
      return `${a.record?.created}:${a.record?.id}`.localeCompare(`${b.record?.created}:${b.record?.id}`)
    })
}

function normalizePath(input: string): string {
  const path = input.trim().replace(/\\/g, "/")
  const parts = path.split("/")
  if (
    !path.startsWith("/") ||
    parts.some((part, i) => (i > 0 && !part) || part === "." || part === "..") ||
    parts.length < 3 ||
    !MOUNTS.has(parts[1]) ||
    path.length > 240 ||
    /[\0-\x1f\x7f]/.test(path)
  ) {
    throw new FileSystemError("Use an absolute document path under /scratch, /session, /pages, /inbox, /artifacts, /journal, or /trash.")
  }
  const extension = parts[parts.length - 1].split(".").pop()?.toLowerCase() as FileFormat | undefined
  if (!extension || !ALLOWED_FORMATS.has(extension)) {
    throw new FileSystemError("Only inert Markdown, JSON, CSV, and TSV documents are supported.")
  }
  if (parts.some((part) => part.startsWith("."))) throw new FileSystemError("Hidden filesystem paths are not supported.")
  return path
}

function trustFor(actor: FileActor): FileTrust {
  return actor
}

function assertWriteAccess(path: string, actor: FileActor, internal = false): void {
  const mount = path.split("/")[1]
  if (actor === "untrusted-web" && mount !== "pages") throw new FileSystemError("Untrusted page snapshots can only be written under /pages.")
  if (internal) return
  if (actor === "assistant" && !internal && mount !== "scratch" && mount !== "artifacts") {
    throw new FileSystemError("Assistant writes are limited to /scratch and /artifacts. Use the user-approved promotion flow for durable memory.")
  }
  if (actor === "system" && mount !== "journal" && mount !== "trash" && mount !== "session" && mount !== "scratch" && mount !== "pages") {
    throw new FileSystemError("System writes are restricted to session, journal, retention, and snapshot records.")
  }
  if (actor === "user" && (mount === "pages" || mount === "journal" || mount === "trash")) {
    throw new FileSystemError("That mount is read-only for direct user edits.")
  }
}

function formatForPath(path: string): FileFormat {
  const format = path.split(".").pop()?.toLowerCase() as FileFormat | undefined
  if (!format || !ALLOWED_FORMATS.has(format)) throw new FileSystemError("Unsupported document format.")
  return format
}

function validateBody(path: string, body: string): void {
  if (typeof body !== "string" || body.includes("\0")) throw new FileSystemError("Documents must be inert UTF-8 text.")
  if (byteLength(body) > MAX_DOCUMENT_BYTES) throw new FileSystemError(`Documents are limited to ${MAX_DOCUMENT_BYTES.toLocaleString()} bytes.`)
  if (formatForPath(path) === "json") {
    try {
      JSON.parse(body)
    } catch {
      throw new FileSystemError("JSON documents must contain valid JSON.")
    }
  }
}

function latestFor(eventsForPath: StoredEvent[]): FileRecord | null {
  const sorted = [...eventsForPath].sort((a, b) => {
    const versionOrder = (a.record?.version ?? 0) - (b.record?.version ?? 0)
    if (versionOrder) return versionOrder
    return `${a.record?.created}:${a.record?.id}`.localeCompare(`${b.record?.created}:${b.record?.id}`)
  })
  return sorted.length ? sorted[sorted.length - 1].record ?? null : null
}

function recordExpired(record: FileRecord, now = Date.now()): boolean {
  const mount = record.path.split("/")[1]
  return Boolean(record.expiresAt && record.expiresAt <= now) ||
    (mount === "pages" && Date.parse(record.created) + PAGE_TTL_MS <= now) ||
    (mount === "trash" && Date.parse(record.created) + TRASH_TTL_MS <= now)
}

function unifiedDiff(before: string, after: string, fromVersion: number, toVersion: number): string {
  if (before === after) return `v${fromVersion} and v${toVersion} are identical.`
  const a = before.split("\n")
  const b = after.split("\n")
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--
    endB--
  }
  const contextStart = Math.max(0, start - 2)
  const contextEndA = Math.min(a.length, endA + 3)
  const contextEndB = Math.min(b.length, endB + 3)
  return [
    `--- v${fromVersion}`,
    `+++ v${toVersion}`,
    ...a.slice(contextStart, start).map((line) => ` ${line}`),
    ...a.slice(start, endA + 1).map((line) => `-${line}`),
    ...b.slice(start, endB + 1).map((line) => `+${line}`),
    ...a.slice(endA + 1, contextEndA).map((line) => ` ${line}`),
  ].join("\n")
}

function pathAllowedByActor(path: string, actor: FileActor, internal: boolean): void {
  assertWriteAccess(path, actor, internal)
}

async function appendEvent(store: AppendableStore, conversationId: string, event: JournalEvent): Promise<string> {
  const all = await events(store, conversationId)
  if (all.length >= MAX_RECORDS) throw new FileSystemError(`Filesystem record limit reached (${MAX_RECORDS}). Run gc or remove expired records before writing more.`)
  const projected = all.reduce((sum, item) => sum + (item.record ? byteLength(item.record.body) : 0), 0)
  const added = event.record ? byteLength(event.record.body) : byteLength(JSON.stringify(event))
  if (projected + added > MAX_TOTAL_BYTES) throw new FileSystemError("Filesystem storage quota reached. Remove old page snapshots or artifacts before writing more.")
  if (event.record) {
    const mount = event.record.path.split("/")[1]
    const mountEvents = all.filter((item) => item.record?.path.split("/")[1] === mount)
    if (mountEvents.length >= (MOUNT_RECORD_LIMITS[mount] ?? 100)) {
      throw new FileSystemError(`The /${mount} mount reached its ${MOUNT_RECORD_LIMITS[mount] ?? 100}-version limit.`)
    }
    const mountBytes = mountEvents.reduce((sum, item) => sum + byteLength(item.record?.body ?? ""), 0)
    if (mountBytes + added > (MOUNT_BYTE_LIMITS[mount] ?? MAX_DOCUMENT_BYTES)) {
      throw new FileSystemError(`The /${mount} mount reached its storage quota.`)
    }
  }
  const messageId = await store.appendMessage({
    conversationId: bucket(conversationId),
    role: "system",
    content: JSON.stringify(event),
  })
  const confirmed = await store.getMessages({ conversationId: bucket(conversationId), limit: MAX_RECORDS, order: "desc" })
  if (!confirmed.some((entry) => entry.messageId === messageId)) {
    throw new FileSystemError("The conversation store did not confirm the filesystem write.")
  }
  return messageId
}

export async function listFileRecords(store: AppendableStore, conversationId: string, query: FileListQuery = {}): Promise<FileRecord[]> {
  const all = await events(store, conversationId)
  const records = [...currentRecords(all).values()].filter((record) => {
    if (record.deleted) return false
    if (recordExpired(record)) return false
    if (query.mount && record.path.split("/")[1] !== query.mount.replace(/^\/+/, "")) return false
    if (query.path && !record.path.startsWith(query.path)) return false
    if (query.tag && !record.tags.includes(query.tag)) return false
    if (query.url && !record.provenance.url?.includes(query.url)) return false
    if (query.trust && record.provenance.trust !== query.trust) return false
    const created = Date.parse(record.created)
    if (query.since && created < query.since) return false
    if (query.until && created > query.until) return false
    return true
  })
  records.sort((a, b) => b.created.localeCompare(a.created))
  return records.slice(0, Math.min(Math.max(query.limit ?? MAX_LIST_RESULTS, 1), MAX_LIST_RESULTS))
}

export async function readFileRecord(
  store: AppendableStore,
  conversationId: string,
  inputPath: string,
  version?: number,
  offset = 0,
  length = MAX_READ_CHARS,
): Promise<{ record: FileRecord; chunk: string; nextOffset: number | null }> {
  const path = normalizePath(inputPath)
  const all = await events(store, conversationId)
  const allVersions = historyFor(all, path).map((event) => event.record!)
  const head = allVersions[allVersions.length - 1]
  const record = version === undefined
    ? head && !head.deleted && !recordExpired(head) ? head : undefined
    : allVersions.find((item) => item.version === version && !recordExpired(item))
  if (!record) throw new FileSystemError(`No document found at ${path}${version === undefined ? "" : ` version ${version}`}.`)
  const start = Math.max(0, Math.min(offset, record.body.length))
  const chunk = record.body.slice(start, start + Math.min(Math.max(length, 1), MAX_READ_CHARS))
  const next = start + chunk.length
  return { record, chunk, nextOffset: next < record.body.length ? next : null }
}

export async function listFileVersions(
  store: AppendableStore,
  conversationId: string,
  inputPath: string,
): Promise<FileRecord[]> {
  const path = normalizePath(inputPath)
  return historyFor(await events(store, conversationId), path).map((event) => event.record!)
}

export async function writeFileRecord(
  store: AppendableStore,
  conversationId: string,
  input: {
    path: string
    body: string
    expectedVersion: number
    actor: FileActor
    source: string
    tags?: string[]
    url?: string
    tab?: string
    toolCall?: string
    expiresAt?: number
    metadata?: Record<string, string | number | boolean>
    internal?: boolean
    deleted?: boolean
    copyTrust?: FileTrust
  },
): Promise<{ record: FileRecord; conflict?: never } | { record?: never; conflict: { current: FileRecord | null; diff: string } }> {
  const path = normalizePath(input.path)
  pathAllowedByActor(path, input.actor, Boolean(input.internal))
  validateBody(path, input.body)
  const all = await events(store, conversationId)
  const versions = historyFor(all, path)
  const current = latestFor(versions)
  const currentVersion = current?.deleted ? current.version : current?.version ?? 0
  if (input.expectedVersion !== currentVersion) {
    return {
      conflict: {
        current,
        diff: unifiedDiff(current?.body ?? "", input.body, currentVersion, currentVersion + 1),
      },
    }
  }

  const created = new Date().toISOString()
  const record: FileRecord = {
    id: randomUUID(),
    path,
    created,
    version: currentVersion + 1,
    ...(current ? { supersedes: current.id } : {}),
    format: formatForPath(path),
    body: input.body,
    provenance: {
      source: input.source,
      trust: input.internal && input.actor === "system" && input.copyTrust ? input.copyTrust : trustFor(input.actor),
      createdAt: created,
      ...(input.tab ? { tab: input.tab } : {}),
      ...(input.url ? { url: input.url } : {}),
      ...(input.toolCall ? { toolCall: input.toolCall } : {}),
    },
    tags: [...new Set((input.tags ?? []).map((tag) => tag.trim().slice(0, 40)).filter(Boolean))].slice(0, 20),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.deleted ? { deleted: true } : {}),
  }
  await appendEvent(store, conversationId, { kind: "version", record, createdAt: Date.now() })

  const refreshed = await events(store, conversationId)
  const refreshedVersions = historyFor(refreshed, path)
  const winner = latestFor(refreshedVersions)
  const sameVersion = refreshedVersions.filter((event) => event.record?.version === record.version)
  if (sameVersion.length > 1 && winner?.id !== record.id) {
    return {
      conflict: {
        current: winner,
        diff: unifiedDiff(winner?.body ?? "", record.body, winner?.version ?? 0, record.version),
      },
    }
  }
  return { record }
}

export async function diffFileRecords(
  store: AppendableStore,
  conversationId: string,
  inputPath: string,
  fromVersion: number,
  toVersion: number,
): Promise<string> {
  const path = normalizePath(inputPath)
  const all = await events(store, conversationId)
  const versions = historyFor(all, path).map((event) => event.record!)
  const from = versions.find((record) => record.version === fromVersion)
  const to = versions.find((record) => record.version === toVersion)
  if (!from || !to) throw new FileSystemError(`Both versions must exist for ${path}.`)
  return unifiedDiff(from.body, to.body, from.version, to.version)
}

export async function appendFileRecord(
  store: AppendableStore,
  conversationId: string,
  path: string,
  lines: string,
  expectedVersion: number,
  actor: FileActor,
  source: string,
  options: { expiresAt?: number; metadata?: Record<string, string | number | boolean> } = {},
): Promise<{ record: FileRecord; conflict?: never } | { record?: never; conflict: { current: FileRecord | null; diff: string } }> {
  const versions = await listFileVersions(store, conversationId, path)
  const current = versions[versions.length - 1]
  const body = (current?.deleted ? "" : current?.body ?? "") + ((current?.body && !current.body.endsWith("\n")) ? "\n" : "") + lines
  return writeFileRecord(store, conversationId, {
    path,
    body,
    expectedVersion,
    actor,
    source,
    tags: current?.tags,
    url: current?.provenance.url,
    tab: current?.provenance.tab,
    expiresAt: options.expiresAt ?? current?.expiresAt,
    metadata: options.metadata ?? current?.metadata,
  })
}

export async function requestFilePromotion(
  store: AppendableStore,
  conversationId: string,
  input: { path: string; targetPath: string; reason: string; proposedBody: string },
): Promise<PromotionRequest> {
  const source = await readFileRecord(store, conversationId, input.path)
  if (source.record.provenance.trust !== "untrusted-web") {
    throw new FileSystemError("Only untrusted-web records require promotion; trusted documents can be edited directly.")
  }
  const targetPath = normalizePath(input.targetPath)
  if (targetPath.split("/")[1] !== "session" && targetPath.split("/")[1] !== "artifacts") {
    throw new FileSystemError("Promotions may only create durable /session records or downloadable /artifacts.")
  }
  validateBody(targetPath, input.proposedBody)
  const all = await events(store, conversationId)
  const targetHead = latestFor(historyFor(all, targetPath))
  const request: PromotionRequest = {
    id: randomUUID(),
    sourcePath: source.record.path,
    sourceVersion: source.record.version,
    targetPath,
    targetVersion: targetHead?.version ?? 0,
    reason: input.reason.trim().slice(0, 500),
    proposedBody: input.proposedBody,
    status: "pending",
    createdAt: Date.now(),
  }
  await appendEvent(store, conversationId, { kind: "promotion_request", request, createdAt: request.createdAt })
  return request
}

export async function listPromotionRequests(store: AppendableStore, conversationId: string): Promise<PromotionRequest[]> {
  const all = await events(store, conversationId)
  const decisions = new Map<string, "approved" | "rejected">()
  for (const event of all) {
    if (event.kind === "promotion_decision" && event.requestId && event.status) decisions.set(event.requestId, event.status)
  }
  return all
    .filter((event) => event.kind === "promotion_request" && event.request)
    .map((event): PromotionRequest => ({ ...event.request!, status: decisions.get(event.request!.id) ?? "pending" }))
    .filter((request) => request.status === "pending")
    .sort((a, b) => a.createdAt - b.createdAt)
}

export async function decideFilePromotion(
  store: AppendableStore,
  conversationId: string,
  requestId: string,
  approved: boolean,
  approvedBody?: string,
): Promise<FileRecord | null> {
  const request = (await listPromotionRequests(store, conversationId)).find((item) => item.id === requestId)
  if (!request) throw new FileSystemError("That promotion request is no longer pending.")
  if (!approved) {
    await appendEvent(store, conversationId, {
      kind: "promotion_decision",
      requestId,
      status: "rejected",
      createdAt: Date.now(),
    })
    return null
  }
  const source = await readFileRecord(store, conversationId, request.sourcePath, request.sourceVersion)
  if (source.record.provenance.trust !== "untrusted-web") throw new FileSystemError("The source changed trust status; promotion was refused.")
  const body = approvedBody ?? request.proposedBody
  validateBody(request.targetPath, body)
  const target = await readFileRecord(store, conversationId, request.targetPath).catch(() => null)
  if (target?.record.metadata?.requestId === request.id && target.record.body === body) {
    await appendEvent(store, conversationId, {
      kind: "promotion_decision",
      requestId,
      status: "approved",
      createdAt: Date.now(),
    })
    return target.record
  }
  const write = await writeFileRecord(store, conversationId, {
    path: request.targetPath,
    body,
    expectedVersion: request.targetVersion ?? target?.record.version ?? 0,
    actor: "user",
    source: "user_approved_transform",
    tags: ["user-approved"],
    metadata: { sourcePath: request.sourcePath, sourceVersion: request.sourceVersion, reason: request.reason, requestId: request.id },
    internal: true,
  })
  if (!write.record) throw new FileSystemError(`The destination changed before approval was applied. ${write.conflict.diff}`)
  await appendEvent(store, conversationId, {
    kind: "promotion_decision",
    requestId,
    status: "approved",
    createdAt: Date.now(),
  })
  return write.record
}

export async function snapshotPage(
  store: AppendableStore,
  conversationId: string,
  input: { tab: string; url: string; title: string; text: string; toolCall?: string },
): Promise<FileRecord> {
  if (!/^https?:\/\//i.test(input.url)) throw new FileSystemError("Page snapshots require an http or https source URL.")
  const tab = input.tab.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "unknown"
  const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "page"
  const path = `/pages/${tab}/${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}-${slug}.md`
  const prefix = `# ${input.title.slice(0, 200)}\n\nSource: ${input.url}\n\n`
  const all = await events(store, conversationId)
  const snapshots = [...currentRecords(all).values()]
    .filter((record) => record.path.startsWith("/pages/") && !record.deleted)
    .sort((a, b) => a.created.localeCompare(b.created))
  const evict = new Set(
    snapshots
      .filter((record) => record.path.startsWith(`/pages/${tab}/`))
      .slice(0, Math.max(0, snapshots.filter((record) => record.path.startsWith(`/pages/${tab}/`)).length - MAX_PAGE_SNAPSHOTS_PER_TAB + 1))
      .map((record) => record.path),
  )
  let remainingCount = snapshots.length - evict.size
  for (const record of snapshots) {
    if (remainingCount < MAX_PAGE_SNAPSHOTS_TOTAL) break
    if (evict.has(record.path)) continue
    evict.add(record.path)
    remainingCount--
  }
  for (const expiredPath of evict) await removeRecordVersions(store, conversationId, expiredPath)
  const write = await writeFileRecord(store, conversationId, {
    path,
    body: `${prefix}${truncateUtf8(input.text, MAX_DOCUMENT_BYTES - byteLength(prefix))}`,
    expectedVersion: 0,
    actor: "untrusted-web",
    source: "page_snapshot",
    tags: ["page-snapshot"],
    url: input.url.slice(0, 2000),
    tab,
    toolCall: input.toolCall,
    expiresAt: Date.now() + PAGE_TTL_MS,
  })
  if (!write.record) throw new FileSystemError(write.conflict.diff)
  return write.record
}

export async function writeJournal(
  store: AppendableStore,
  conversationId: string,
  entry: Record<string, unknown>,
): Promise<FileRecord> {
  const id = randomUUID()
  const path = `/journal/${new Date().toISOString().replace(/[:.]/g, "-")}-${id.slice(0, 8)}.json`
  const body = JSON.stringify(entry)
  const write = await writeFileRecord(store, conversationId, {
    path,
    body,
    expectedVersion: 0,
    actor: "system",
    source: "action_journal",
    tags: ["journal"],
    internal: true,
  })
  if (!write.record) throw new FileSystemError(write.conflict.diff)
  return write.record
}

export async function finishJournal(
  store: AppendableStore,
  conversationId: string,
  path: string,
  expectedVersion: number,
  entry: Record<string, unknown>,
): Promise<FileRecord> {
  const write = await writeFileRecord(store, conversationId, {
    path,
    body: JSON.stringify(entry),
    expectedVersion,
    actor: "system",
    source: "action_journal",
    tags: ["journal"],
    internal: true,
  })
  if (!write.record) throw new FileSystemError(write.conflict.diff)
  return write.record
}

async function removeRecordVersions(store: AppendableStore, conversationId: string, path: string): Promise<number> {
  const all = await events(store, conversationId)
  const ids = historyFor(all, path).map((event) => event.messageId)
  await Promise.all(ids.map((messageId) => store.deleteMessage({ conversationId: bucket(conversationId), messageId })))
  return ids.length
}

export async function deleteFileRecord(store: AppendableStore, conversationId: string, inputPath: string): Promise<FileRecord> {
  const path = normalizePath(inputPath)
  if (path.split("/")[1] === "journal" || path.split("/")[1] === "trash") {
    throw new FileSystemError("Journal entries and trash records are managed by retention and cannot be manually deleted.")
  }
  const current = await readFileRecord(store, conversationId, path)
  const trashPath = `/trash/${Date.now()}-${randomUUID().slice(0, 8)}.md`
  const archived = await writeFileRecord(store, conversationId, {
    path: trashPath,
    body: current.record.body,
    expectedVersion: 0,
    actor: "system",
    source: "soft_delete",
    tags: ["trash", ...current.record.tags],
    expiresAt: Date.now() + TRASH_TTL_MS,
    metadata: {
      originalPath: path,
      originalVersion: current.record.version,
      originalTrust: current.record.provenance.trust,
      originalSource: current.record.provenance.source,
      ...(current.record.provenance.url ? { originalUrl: current.record.provenance.url } : {}),
      ...(current.record.provenance.tab ? { originalTab: current.record.provenance.tab } : {}),
    },
    internal: true,
    copyTrust: current.record.provenance.trust,
  })
  if (!archived.record) throw new FileSystemError(archived.conflict.diff)
  const tombstone = await writeFileRecord(store, conversationId, {
    path,
    body: current.record.body,
    expectedVersion: current.record.version,
    actor: "system",
    source: "soft_delete",
    tags: current.record.tags,
    metadata: { deleted: true, trashPath },
    internal: true,
    deleted: true,
  })
  if (!tombstone.record) throw new FileSystemError(tombstone.conflict.diff)
  return tombstone.record
}

export async function restoreFileRecord(
  store: AppendableStore,
  conversationId: string,
  trashPath: string,
): Promise<FileRecord> {
  const archived = await readFileRecord(store, conversationId, trashPath)
  if (archived.record.path.split("/")[1] !== "trash") throw new FileSystemError("Restore requires a document from /trash.")
  const originalPath = archived.record.metadata?.originalPath
  const originalTrust = archived.record.metadata?.originalTrust
  if (typeof originalPath !== "string" || !["user", "system", "assistant", "untrusted-web"].includes(String(originalTrust))) {
    throw new FileSystemError("Trash metadata is incomplete; the record cannot be restored safely.")
  }
  const path = normalizePath(originalPath)
  if (path.split("/")[1] === "journal" || path.split("/")[1] === "trash") {
    throw new FileSystemError("Journal and trash records cannot be restored to writable paths.")
  }
  const all = await events(store, conversationId)
  const head = latestFor(historyFor(all, path))
  const restored = await writeFileRecord(store, conversationId, {
    path,
    body: archived.record.body,
    expectedVersion: head?.version ?? 0,
    actor: "system",
    source: "trash_restore",
    tags: archived.record.tags.filter((tag) => tag !== "trash"),
    metadata: { restoredFrom: trashPath },
    internal: true,
    copyTrust: originalTrust === "user" || originalTrust === "assistant" || originalTrust === "system" || originalTrust === "untrusted-web"
      ? originalTrust
      : "system",
  })
  if (!restored.record) throw new FileSystemError(`The destination changed before restore. ${restored.conflict.diff}`)
  return restored.record
}

export async function garbageCollect(store: AppendableStore, conversationId: string, now = Date.now()): Promise<{ recordsRemoved: number }> {
  const all = await events(store, conversationId)
  const current = currentRecords(all)
  const expiredPaths = new Set<string>()
  const expiredTrashPaths = new Set<string>()
  for (const record of current.values()) {
    if (record.deleted) continue
    const mount = record.path.split("/")[1]
    const expired = recordExpired(record, now)
    if (expired) expiredPaths.add(record.path)
    if (expired && mount === "trash") expiredTrashPaths.add(record.path)
  }
  for (const path of expiredTrashPaths) {
    const trashRecord = current.get(path)
    const originalPath = trashRecord?.metadata?.originalPath
    const original = typeof originalPath === "string" ? current.get(originalPath) : undefined
    if (original?.deleted && original.metadata?.trashPath === path) expiredPaths.add(original.path)
  }
  let recordsRemoved = 0
  for (const path of expiredPaths) recordsRemoved += await removeRecordVersions(store, conversationId, path)
  return { recordsRemoved }
}

export async function expireScratchTask(store: AppendableStore, conversationId: string, task: string): Promise<number> {
  const all = await events(store, conversationId)
  const current = [...currentRecords(all).values()].filter(
    (record) => record.path.startsWith("/scratch/") && !record.deleted && record.metadata?.task === task,
  )
  let expired = 0
  for (const record of current) {
    const write = await writeFileRecord(store, conversationId, {
      path: record.path,
      body: record.body,
      expectedVersion: record.version,
      actor: "system",
      source: "scratch_task_end",
      tags: record.tags,
      expiresAt: Date.now() + SCRATCH_TTL_MS,
      metadata: { ...record.metadata, taskEnded: true },
      internal: true,
    })
    if (!write.record) throw new FileSystemError(`Scratch document ${record.path} changed while the task ended. ${write.conflict.diff}`)
    expired++
  }
  return expired
}

export async function writeSessionDocuments(
  store: FileStore,
  conversationId: string,
  session: { task: string; steps: { text: string; done: boolean }[]; notes: string[]; openQuestions: string[]; pages: { url: string; title: string; at: number; state?: string }[]; updatedAt: number },
): Promise<void> {
  const docs: [string, string][] = [
    ["/session/task.md", session.task ? `# Current task\n\n${session.task}` : ""],
    ["/session/steps.json", JSON.stringify(session.steps, null, 2)],
    ["/session/notes.json", JSON.stringify(session.notes, null, 2)],
    ["/session/open_questions.json", JSON.stringify(session.openQuestions, null, 2)],
    ["/session/pages.json", JSON.stringify(session.pages, null, 2)],
  ]
  for (const [path, body] of docs) {
    const existing = await readFileRecord(store, conversationId, path).catch(() => null)
    if (existing?.record.body === body) continue
    const all = await events(store, conversationId)
    const head = latestFor(historyFor(all, path))
    const result = await writeFileRecord(store, conversationId, {
      path,
      body,
      expectedVersion: head?.version ?? 0,
      actor: "assistant",
      source: "session_update",
      tags: ["session"],
      internal: true,
    })
    if (!result.record) throw new FileSystemError(`Session record ${path} changed concurrently. ${result.conflict.diff}`)
  }
}

export async function readSessionDocuments(store: FileStore, conversationId: string): Promise<unknown | null> {
  const [task, steps, notes, openQuestions, pages] = await Promise.all(
    [
      "/session/task.md",
      "/session/steps.json",
      "/session/notes.json",
      "/session/open_questions.json",
      "/session/pages.json",
    ].map((path) => readFileRecord(store, conversationId, path).catch(() => null)),
  )
  if (![task, steps, notes, openQuestions, pages].some(Boolean)) return null
  const parse = <T>(record: { record: FileRecord } | null, fallback: T): T => {
    if (!record) return fallback
    try {
      return JSON.parse(record.record.body) as T
    } catch {
      return fallback
    }
  }
  const legacyNotes = parse(notes, [] as string[])
  return {
    task: task?.record.body.replace(/^# Current task\s*/, "").trim() ?? "",
    steps: parse(steps, [] as { text: string; done: boolean }[]),
    notes: Array.isArray(legacyNotes) ? legacyNotes : [],
    openQuestions: parse(openQuestions, [] as string[]),
    pages: parse(pages, [] as { url: string; title: string; at: number; state?: string }[]),
    updatedAt: Math.max(task?.record.provenance.createdAt ? Date.parse(task.record.provenance.createdAt) : 0, ...[steps, notes, openQuestions, pages].map((item) => item?.record.provenance.createdAt ? Date.parse(item.record.provenance.createdAt) : 0)),
  }
}

export async function clearSessionDocuments(store: FileStore, conversationId: string): Promise<void> {
  for (const path of ["/session/task.md", "/session/steps.json", "/session/notes.json", "/session/open_questions.json", "/session/pages.json"]) {
    const current = await readFileRecord(store, conversationId, path).catch(() => null)
    if (!current) continue
    await writeFileRecord(store, conversationId, {
      path,
      body: path.endsWith(".json") ? "[]" : "",
      expectedVersion: current.record.version,
      actor: "system",
      source: "session_clear",
      tags: ["session"],
      metadata: { cleared: true },
      internal: true,
      deleted: true,
    })
  }
}

export async function clearSessionStore(store: FileStore, conversationId: string): Promise<void> {
  const intent = await writeJournal(store, conversationId, {
    action: "session_clear",
    phase: "intent",
    at: new Date().toISOString(),
  })
  try {
    await clearSessionDocuments(store, conversationId)
    await store.state.delete("devon_session")
    await finishJournal(store, conversationId, intent.path, intent.version, {
      action: "session_clear",
      phase: "result",
      status: "success",
      whatChanged: "Session records were cleared.",
      at: new Date().toISOString(),
    })
  } catch (error) {
    try {
      await finishJournal(store, conversationId, intent.path, intent.version, {
        action: "session_clear",
        phase: "result",
        status: "error",
        result: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
      })
    } catch {
      // Preserve the clear error; an unfinished intent remains in the journal.
    }
    throw error
  }
}

export async function storeInboxUploads(
  store: FileStore,
  conversationId: string,
  files: Array<{ name: string; path: string; mimeType: string; size: number; text: string }>,
): Promise<void> {
  for (const file of files) {
    const baseName = file.path.split("/").filter(Boolean).join("-").replace(/[^A-Za-z0-9._-]/g, "_").slice(-120) || file.name.replace(/[^A-Za-z0-9._-]/g, "_")
    const supported = /\.(md|json|csv|tsv)$/i.test(baseName)
    const path = `/inbox/${baseName}${supported ? "" : ".json"}`
    const existing = await readFileRecord(store, conversationId, path).catch(() => null)
    const body = supported && byteLength(file.text) <= MAX_DOCUMENT_BYTES
      ? file.text
      : JSON.stringify({ attachment: true, name: file.name, path: file.path, mimeType: file.mimeType, size: file.size, note: "Opaque attachment metadata only; binary content is not stored." }, null, 2)
    if (existing?.record.body === body) continue
    const head = await listFileVersions(store, conversationId, path)
    const currentVersion = head[head.length - 1]?.version ?? 0
    const intent = await writeJournal(store, conversationId, {
      action: "inbox_upload",
      phase: "intent",
      path,
      name: file.name,
      size: file.size,
      at: new Date().toISOString(),
    })
    try {
      const write = await writeFileRecord(store, conversationId, {
        path,
        body,
        expectedVersion: currentVersion,
        actor: "user",
        source: "user_upload",
        tags: ["inbox", "upload"],
        metadata: { originalName: file.name, originalPath: file.path, mimeType: file.mimeType, size: file.size, opaqueAttachment: !supported || byteLength(file.text) > MAX_DOCUMENT_BYTES },
        internal: true,
      })
      if (!write.record) throw new FileSystemError(`Inbox upload ${file.name} conflicted with another version. ${write.conflict.diff}`)
      await finishJournal(store, conversationId, intent.path, intent.version, {
        action: "inbox_upload",
        phase: "result",
        status: "success",
        whatChanged: { path: write.record.path, version: write.record.version, opaqueAttachment: write.record.metadata?.opaqueAttachment ?? false },
        at: new Date().toISOString(),
      })
    } catch (error) {
      try {
        await finishJournal(store, conversationId, intent.path, intent.version, {
          action: "inbox_upload",
          phase: "result",
          status: "error",
          result: error instanceof Error ? error.message : String(error),
          at: new Date().toISOString(),
        })
      } catch {
        // Preserve the upload error; its intent remains inspectable in the journal.
      }
      throw error
    }
  }
}

export function renderFileRecord(record: FileRecord): string {
  const quote = (value: string) => JSON.stringify(value)
  const tags = record.tags.map(quote).join(", ")
  return [
    "---",
    `id: ${quote(record.id)}`,
    `path: ${quote(record.path)}`,
    `created: ${quote(record.created)}`,
    `version: ${record.version}`,
    `supersedes: ${quote(record.supersedes ?? "")}`,
    `format: ${record.format}`,
    `provenance:`,
    `  source: ${quote(record.provenance.source)}`,
    `  trust: ${record.provenance.trust}`,
    `  created_at: ${quote(record.provenance.createdAt)}`,
    ...(record.provenance.tab ? [`  tab: ${quote(record.provenance.tab)}`] : []),
    ...(record.provenance.url ? [`  url: ${quote(record.provenance.url)}`] : []),
    ...(record.provenance.toolCall ? [`  tool_call: ${quote(record.provenance.toolCall)}`] : []),
    `tags: [${tags}]`,
    ...(record.expiresAt ? [`expires_at: ${quote(new Date(record.expiresAt).toISOString())}`] : []),
    "---",
    record.body,
  ].join("\n")
}

export function fileSystemBucketForTests(conversationId: string): string {
  return bucket(conversationId)
}
