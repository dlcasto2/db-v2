/**
 * Devon's side of Google accounts: talking to the auth cloud functions and
 * carrying the synced data between the server and the browser. The merge rules
 * themselves live in cloud-functions/_auth/sync.ts, shared with the server so
 * both sides reconcile identically.
 *
 * Accounts are an EdgeOne feature (the cloud functions under cloud-functions/).
 * Where they aren't deployed, every call here reports "signed out, not
 * available" and Devon works exactly as before.
 */

import { mergeSync, normalizeSyncData, type SyncData } from "@/cloud-functions/_auth/sync"

export type { SyncData }
export { mergeSync, normalizeSyncData }

export interface AccountUser {
  sub: string
  email?: string
  name?: string
  picture?: string
}

export interface AccountState {
  /** Whether Google sign-in is set up on this deployment */
  enabled: boolean
  signedIn: boolean
  user?: AccountUser
}

const API = {
  me: "/auth-me",
  start: "/auth-google-start",
  logout: "/auth-logout",
  sync: "/account-sync",
} as const

async function asJson(res: Response): Promise<Record<string, unknown> | null> {
  if (!res.ok || !(res.headers.get("content-type") || "").includes("json")) return null
  return (await res.json().catch(() => null)) as Record<string, unknown> | null
}

/** Current sign-in state. Never throws; a deployment without accounts reads as disabled. */
export async function fetchAccount(): Promise<AccountState> {
  try {
    const data = await asJson(await fetch(API.me, { cache: "no-store" }))
    if (!data) return { enabled: false, signedIn: false }
    const user = data.user as AccountUser | undefined
    return {
      enabled: Boolean(data.enabled),
      signedIn: Boolean(data.signedIn) && Boolean(user?.sub),
      user: data.signedIn && user?.sub ? user : undefined,
    }
  } catch {
    return { enabled: false, signedIn: false }
  }
}

/** Send the browser to Google's consent screen (a full-page navigation of the app shell) */
export function startSignIn(): void {
  window.location.href = API.start
}

export async function signOut(): Promise<boolean> {
  try {
    const res = await fetch(API.logout, { method: "POST" })
    return res.ok
  } catch {
    return false
  }
}

/** The account's data from the server, or null if signed out / unavailable */
export async function pullSync(): Promise<SyncData | null> {
  try {
    const data = await asJson(await fetch(API.sync, { cache: "no-store" }))
    if (!data || !data.available) return null
    return normalizeSyncData(data.data)
  } catch {
    return null
  }
}

/** Push the browser's data; returns the server's merged result (or null if unavailable) */
export async function pushSync(local: SyncData): Promise<SyncData | null> {
  try {
    const data = await asJson(
      await fetch(API.sync, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(local),
      }),
    )
    if (!data || !data.available) return null
    return normalizeSyncData(data.data)
  } catch {
    return null
  }
}
