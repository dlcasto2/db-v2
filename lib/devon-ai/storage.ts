/**
 * Devon AI's browser storage (IndexedDB). Adapted from
 * TencentEdgeOne/claude-agent-starter-node (MIT): its idb, imageStore and
 * chatUiStore modules in one file.
 *
 * - Images from tools (screenshots, charts) are kept as Blobs, keyed by
 *   `${conversationId}/${imageId}`, so a reload can show them again.
 * - Each conversation's messages are kept as a snapshot holding image
 *   references (no base64, no blob: URLs) and the page each question was about.
 * Server history (/ai-history) is the fallback when there's no snapshot.
 */

import type { Message } from "@/lib/devon-ai/types"

const dbCache = new Map<string, Promise<IDBDatabase>>()

function openDatabase(name: string, version: number, onUpgrade: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  const cached = dbCache.get(name)
  if (cached) return cached
  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"))
      return
    }
    const request = indexedDB.open(name, version)
    request.onupgradeneeded = () => onUpgrade(request.result)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      dbCache.delete(name)
      reject(request.error)
    }
  })
  dbCache.set(name, promise)
  return promise
}

function run<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const req = fn(db.transaction(store, mode).objectStore(store))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

const IMAGE_DB = "devon-ai-images"
const IMAGE_STORE = "images"

export interface StoredImageRecord {
  storageKey: string
  conversationId: string
  messageId: string
  imageId: string
  blob: Blob
  mimeType: string
  size: number
  createdAt: number
}

function openImageDb() {
  return openDatabase(IMAGE_DB, 1, (db) => {
    if (!db.objectStoreNames.contains(IMAGE_STORE)) {
      const store = db.createObjectStore(IMAGE_STORE, { keyPath: "storageKey" })
      store.createIndex("byConversation", "conversationId", { unique: false })
    }
  })
}

export function base64ToBlob(base64: string, mimeType = "image/png"): Blob {
  const chars = atob(base64)
  const bytes = new Uint8Array(chars.length)
  for (let i = 0; i < chars.length; i++) bytes[i] = chars.charCodeAt(i)
  return new Blob([bytes], { type: mimeType })
}

export function makeStorageKey(conversationId: string, imageId: string): string {
  return `${conversationId}/${imageId}`
}

export async function saveImage(params: { conversationId: string; messageId: string; imageId: string; blob: Blob; mimeType: string }) {
  const record: StoredImageRecord = {
    ...params,
    storageKey: makeStorageKey(params.conversationId, params.imageId),
    size: params.blob.size,
    createdAt: Date.now(),
  }
  const db = await openImageDb()
  await run(db, IMAGE_STORE, "readwrite", (s) => s.put(record))
  return record
}

export async function loadConversationImages(conversationId: string): Promise<StoredImageRecord[]> {
  try {
    const db = await openImageDb()
    return (await run(db, IMAGE_STORE, "readonly", (s) => s.index("byConversation").getAll(conversationId))) ?? []
  } catch {
    return []
  }
}

export async function deleteConversationImages(conversationId: string): Promise<void> {
  const db = await openImageDb()
  await new Promise<void>((resolve, reject) => {
    const req = db.transaction(IMAGE_STORE, "readwrite").objectStore(IMAGE_STORE).index("byConversation").openCursor(conversationId)
    req.onsuccess = () => {
      const cursor = req.result
      if (cursor) {
        cursor.delete()
        cursor.continue()
      } else resolve()
    }
    req.onerror = () => reject(req.error)
  })
}

const activeUrls = new Map<string, string>()

/** One blob: URL per stored image, reused while it's on screen */
export function createObjectUrl(storageKey: string, blob: Blob): string {
  const existing = activeUrls.get(storageKey)
  if (existing) return existing
  const url = URL.createObjectURL(blob)
  activeUrls.set(storageKey, url)
  return url
}

export function revokeAllObjectUrls(): void {
  for (const url of activeUrls.values()) URL.revokeObjectURL(url)
  activeUrls.clear()
}

// ---------------------------------------------------------------------------
// Message snapshots
// ---------------------------------------------------------------------------

const SNAPSHOT_DB = "devon-ai-snapshots"
const SNAPSHOT_STORE = "snapshots"

function openSnapshotDb() {
  return openDatabase(SNAPSHOT_DB, 1, (db) => {
    if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) db.createObjectStore(SNAPSHOT_STORE, { keyPath: "conversationId" })
  })
}

/** Drop runtime-only fields (blob: URLs, tool chips, streaming flags) before saving */
function forStorage(messages: Message[]): Message[] {
  return messages.map(({ activity: _activity, streaming: _streaming, images, ...rest }) => ({
    ...rest,
    ...(images?.length ? { images: images.map((img) => ({ ...img, url: "" })) } : {}),
  }))
}

export async function saveSnapshot(conversationId: string, messages: Message[]): Promise<void> {
  try {
    const db = await openSnapshotDb()
    await run(db, SNAPSHOT_STORE, "readwrite", (s) => s.put({ conversationId, messages: forStorage(messages), updatedAt: Date.now() }))
  } catch (e) {
    console.warn("[devon-ai] couldn't save the chat snapshot:", e)
  }
}

export async function loadSnapshot(conversationId: string): Promise<Message[]> {
  try {
    const db = await openSnapshotDb()
    const record = (await run(db, SNAPSHOT_STORE, "readonly", (s) => s.get(conversationId))) as { messages?: Message[] } | undefined
    return Array.isArray(record?.messages) ? record.messages : []
  } catch {
    return []
  }
}

export async function deleteSnapshot(conversationId: string): Promise<void> {
  try {
    const db = await openSnapshotDb()
    await run(db, SNAPSHOT_STORE, "readwrite", (s) => s.delete(conversationId))
  } catch {
    // nothing saved
  }
}
