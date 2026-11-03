/**
 * Where Devon AI's backend lives.
 *
 * Unset (default): same origin, so the built-in app/ai-* routes or EdgeOne
 * agents answer as before. Set NEXT_PUBLIC_DEVON_AI_API_URL to use the
 * standalone service in devon-ai-api/.
 */
const BASE = (process.env.NEXT_PUBLIC_DEVON_AI_API_URL || "").replace(/\/+$/, "")

export function aiUrl(path: string): string {
  return `${BASE}${path.startsWith("/") ? path : `/${path}`}`
}
