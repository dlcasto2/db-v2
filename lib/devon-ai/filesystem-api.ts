import {
  decideFilePromotion,
  deleteFileRecord,
  diffFileRecords,
  FileSystemError,
  finishJournal,
  garbageCollect,
  listFileRecords,
  listFileVersions,
  listPromotionRequests,
  readFileRecord,
  renderFileRecord,
  restoreFileRecord,
  writeFileRecord,
  writeJournal,
  type FileListQuery,
  type FileStore,
} from "./filesystem"

export async function handleFileSystemRequest(
  store: FileStore,
  conversationId: string,
  input: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown>; text?: string }> {
  const action = typeof input.action === "string" ? input.action : ""
  const path = typeof input.path === "string" ? input.path : ""
  const number = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) ? value : undefined
  const start = async (details: Record<string, unknown>) =>
    writeJournal(store, conversationId, { action, phase: "intent", details, at: new Date().toISOString() })
  const finish = async (intent: { path: string; version: number }, result: unknown) =>
    finishJournal(store, conversationId, intent.path, intent.version, {
      action,
      phase: "result",
      status: isConflict(result) ? "conflict" : "success",
      whatChanged: isConflict(result) ? "Stale write rejected; no document version was created." : summarize(result),
      at: new Date().toISOString(),
    })
  const audited = async <T>(details: Record<string, unknown>, operation: () => Promise<T>): Promise<T> => {
    const intent = await start(details)
    try {
      const result = await operation()
      await finish(intent, result)
      return result
    } catch (error) {
      try {
        await finishJournal(store, conversationId, intent.path, intent.version, {
          action,
          phase: "result",
          status: "error",
          result: error instanceof Error ? error.message : String(error),
          at: new Date().toISOString(),
        })
      } catch {
        // The original operation error is more useful; the journal failure is returned if it was the only failure.
        if (!(error instanceof Error)) throw error
      }
      throw error
    }
  }

  try {
    switch (action) {
      case "list": {
        const rawQuery = input.query && typeof input.query === "object" ? input.query as Record<string, unknown> : {}
        const query: FileListQuery = {
          ...(typeof rawQuery.path === "string" ? { path: rawQuery.path.slice(0, 240) } : {}),
          ...(typeof rawQuery.mount === "string" && ["scratch", "session", "pages", "inbox", "artifacts", "journal", "trash"].includes(rawQuery.mount)
            ? { mount: rawQuery.mount }
            : {}),
          ...(typeof rawQuery.tag === "string" ? { tag: rawQuery.tag.slice(0, 40) } : {}),
          ...(typeof rawQuery.url === "string" ? { url: rawQuery.url.slice(0, 2000) } : {}),
          ...(rawQuery.trust === "user" || rawQuery.trust === "system" || rawQuery.trust === "assistant" || rawQuery.trust === "untrusted-web"
            ? { trust: rawQuery.trust }
            : {}),
          ...(number(rawQuery.since) !== undefined ? { since: number(rawQuery.since) } : {}),
          ...(number(rawQuery.until) !== undefined ? { until: number(rawQuery.until) } : {}),
          ...(number(rawQuery.limit) !== undefined ? { limit: number(rawQuery.limit) } : {}),
        }
        const records = await listFileRecords(store, conversationId, query)
        return { status: 200, body: { records: records.map(({ body: _body, ...record }) => record) } }
      }
      case "read": {
        const version = number(input.version)
        const offset = number(input.offset) ?? 0
        const length = number(input.length) ?? 10_000
        const result = await readFileRecord(store, conversationId, path, version, offset, length)
        const { body: _body, ...record } = result.record
        return { status: 200, body: { record, chunk: result.chunk, nextOffset: result.nextOffset } }
      }
      case "versions": {
        const versions = await listFileVersions(store, conversationId, path)
        return { status: 200, body: { versions: versions.map(({ body: _body, ...record }) => record) } }
      }
      case "diff": {
        const from = number(input.fromVersion)
        const to = number(input.toVersion)
        if (from === undefined || to === undefined) throw new FileSystemError("Both version numbers are required.")
        return { status: 200, body: { diff: await diffFileRecords(store, conversationId, path, from, to) } }
      }
      case "promotions":
        return { status: 200, body: { requests: await listPromotionRequests(store, conversationId) } }
      case "write": {
        const body = typeof input.body === "string" ? input.body : undefined
        if (body === undefined) throw new FileSystemError("Document body is required.")
        const expectedVersion = number(input.expectedVersion)
        if (expectedVersion === undefined || expectedVersion < 0) throw new FileSystemError("A valid expectedVersion is required.")
        const tags = Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 20) : []
        const result = await audited({ path, expectedVersion }, () =>
          writeFileRecord(store, conversationId, {
            path,
            body,
            expectedVersion,
            actor: "user",
            source: "filesystem_editor",
            tags,
          }),
        )
        return result.record
          ? { status: 200, body: { record: result.record } }
          : { status: 409, body: { conflict: result.conflict } }
      }
      case "delete": {
        const result = await audited({ path }, () => deleteFileRecord(store, conversationId, path))
        return { status: 200, body: { record: result } }
      }
      case "restore": {
        const trashPath = typeof input.trashPath === "string" ? input.trashPath : path
        const result = await audited({ trashPath }, () => restoreFileRecord(store, conversationId, trashPath))
        return { status: 200, body: { record: result } }
      }
      case "approve":
      case "reject": {
        const requestId = typeof input.requestId === "string" ? input.requestId : ""
        if (!requestId) throw new FileSystemError("A promotion request ID is required.")
        const result = await audited({ requestId, approved: action === "approve" }, () =>
          decideFilePromotion(
            store,
            conversationId,
            requestId,
            action === "approve",
            action === "approve" && typeof input.body === "string" ? input.body : undefined,
          ),
        )
        return { status: 200, body: { record: result } }
      }
      case "gc": {
        const result = await audited({}, () => garbageCollect(store, conversationId))
        return { status: 200, body: result }
      }
      case "export": {
        const result = await readFileRecord(store, conversationId, path, number(input.version))
        return { status: 200, body: { record: result.record, rendered: renderFileRecord(result.record) } }
      }
      default:
        return { status: 400, body: { error: "Unknown filesystem action." } }
    }
  } catch (error) {
    return {
      status: error instanceof Error && error.name === "FileSystemError" ? 400 : 500,
      body: { error: error instanceof Error ? error.message : "The filesystem action failed." },
    }
  }
}

function summarize(value: unknown): unknown {
  if (Array.isArray(value)) return { count: value.length }
  if (!value || typeof value !== "object") return value
  const result = value as Record<string, unknown>
  const record = result.record && typeof result.record === "object" ? result.record as Record<string, unknown> : result
  return {
    path: record.path,
    version: record.version,
    trust: (record.provenance as Record<string, unknown> | undefined)?.trust,
    count: result.records && Array.isArray(result.records) ? result.records.length : undefined,
  }
}

function isConflict(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && "conflict" in value)
}
