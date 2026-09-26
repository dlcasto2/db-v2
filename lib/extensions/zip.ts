/**
 * Minimal ZIP / CRX reader (no dependencies). Supports stored and deflated
 * entries, which covers Chrome extension packages. Inflating uses the
 * browser's built-in DecompressionStream.
 */

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** A .crx is a small header followed by a normal zip. Returns the zip part. */
export function stripCrxHeader(bytes: Uint8Array): Uint8Array {
  // "Cr24"
  if (bytes.length < 16 || bytes[0] !== 0x43 || bytes[1] !== 0x72 || bytes[2] !== 0x32 || bytes[3] !== 0x34) return bytes
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint32(4, true)
  if (version === 3) return bytes.subarray(12 + view.getUint32(8, true))
  if (version === 2) return bytes.subarray(16 + view.getUint32(8, true) + view.getUint32(12, true))
  throw new Error(`Unsupported CRX version ${version}`)
}

export async function unzip(input: ArrayBuffer | Uint8Array): Promise<Map<string, Uint8Array>> {
  const bytes = stripCrxHeader(input instanceof Uint8Array ? input : new Uint8Array(input))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  // End of central directory record: scan backwards (it may be followed by a comment)
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd === -1) throw new Error("Not a valid .zip or .crx file")

  const count = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  const decoder = new TextDecoder()
  const files = new Map<string, Uint8Array>()

  for (let n = 0; n < count; n++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("Corrupt zip central directory")
    const method = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    offset += 46 + nameLength + extraLength + commentLength

    if (name.endsWith("/")) continue // directory
    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`Corrupt zip entry: ${name}`)
    const dataStart =
      localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true)
    const raw = bytes.subarray(dataStart, dataStart + compressedSize)

    let data: Uint8Array
    if (method === 0) data = raw.slice()
    else if (method === 8) data = await inflateRaw(raw)
    else throw new Error(`Unsupported compression in ${name}`)
    files.set(name.replace(/^\.\//, ""), data)
  }

  // Zips made by zipping the folder (not its contents) have everything under one directory
  if (!files.has("manifest.json")) {
    const nested = [...files.keys()].find((k) => /^[^/]+\/manifest\.json$/.test(k))
    if (nested) {
      const prefix = nested.slice(0, nested.indexOf("/") + 1)
      const flat = new Map<string, Uint8Array>()
      files.forEach((v, k) => {
        if (k.startsWith(prefix)) flat.set(k.slice(prefix.length), v)
      })
      return flat
    }
  }
  return files
}
