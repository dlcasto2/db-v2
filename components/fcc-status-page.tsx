"use client"

import { useEffect, useState } from "react"
import { ArrowLeft, CircleCheck, CircleX, ExternalLink, KeyRound, RefreshCw, ServerCog } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

/**
 * devon://fcc-status — the web equivalent of fcc-cli's (github.com/bobbibob/
 * fcc-cli) `fcc-gui` status pill: shows whether the site's Free Claude Code
 * provider (agents/_model.ts's "fcc") is configured and reachable, lists the
 * models it currently exposes, and links out to its real Admin UI. It can't
 * start or stop the remote FCC process — Devon's backend has no access to
 * whatever machine FCC actually runs on, which is the whole point of the
 * provider — so this is read-only, maintainer-facing status, not control.
 *
 * Not listed in devon://apps (lib/apps.ts): this is a site-owner tool, not
 * something every visitor should see, so it's reachable only by address, the
 * same way devon://games is a top-level page outside the Apps grid.
 *
 * The admin key is only ever kept in this browser's localStorage and sent as
 * the POST body of /ai-fcc-status (or /ai-session's EdgeOne twin) — the same
 * DEVON_AI_ADMIN_KEY already used by the ai-feedback digest.
 */

const STORAGE_KEY = "devon_fcc_status_admin_key"

interface FccStatus {
  configured: boolean
  baseUrl?: string
  reachable: boolean
  models?: string[]
  adminUrl?: string
  error?: string
}

function loadAdminKey(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || ""
  } catch {
    return ""
  }
}

export function FccStatusPage({ onOpenApps }: { onOpenApps: () => void }) {
  const [adminKey, setAdminKey] = useState("")
  const [status, setStatus] = useState<FccStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [authError, setAuthError] = useState(false)

  useEffect(() => {
    setAdminKey(loadAdminKey())
  }, [])

  async function check(key: string) {
    if (!key.trim()) return
    setLoading(true)
    setAuthError(false)
    try {
      const response = await fetch("/ai-fcc-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ admin_key: key.trim() }),
      })
      if (response.status === 403) {
        setAuthError(true)
        setStatus(null)
        return
      }
      const data = (await response.json()) as FccStatus
      setStatus(data)
      try {
        localStorage.setItem(STORAGE_KEY, key.trim())
      } catch {
        // best-effort only
      }
    } catch {
      setStatus({ configured: true, reachable: false, error: "Could not reach this site's own /ai-fcc-status endpoint" })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const saved = loadAdminKey()
    if (saved) void check(saved)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <Button size="sm" variant="ghost" className="h-8 rounded-full px-3" onClick={onOpenApps}>
          <ArrowLeft /> Apps
        </Button>
        <span className="grid size-7 place-items-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/30">
          <ServerCog className="size-4" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">Free Claude Code status</span>
      </header>

      <div className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-5 overflow-y-auto px-4 py-8">
        <p className="text-sm text-muted-foreground">
          Maintainer-only. Enter this site's <code className="rounded bg-muted px-1 py-0.5 text-xs">DEVON_AI_ADMIN_KEY</code> to check whether the
          Free Claude Code provider is configured and reachable. This can't start or stop the server — only the status.
        </p>

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void check(adminKey)
          }}
        >
          <div className="relative flex-1">
            <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="password"
              value={adminKey}
              onChange={(e) => setAdminKey(e.target.value)}
              placeholder="Admin key"
              className="pl-9"
              autoComplete="off"
            />
          </div>
          <Button type="submit" disabled={loading || !adminKey.trim()}>
            {loading ? <RefreshCw className="size-4 animate-spin" /> : "Check"}
          </Button>
        </form>

        {authError && <p className="text-sm text-destructive">Not authorized — that key doesn't match DEVON_AI_ADMIN_KEY on this deployment.</p>}

        {status && (
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted/30 p-4">
            {!status.configured ? (
              <div className="flex items-center gap-2 text-sm">
                <CircleX className="size-4 shrink-0 text-muted-foreground" />
                Not configured — DEVON_FCC_BASE_URL isn't set in this site's environment variables.
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 text-sm font-medium">
                  {status.reachable ? (
                    <>
                      <CircleCheck className="size-4 shrink-0 text-emerald-500" /> Reachable
                    </>
                  ) : (
                    <>
                      <CircleX className="size-4 shrink-0 text-destructive" /> Not reachable
                    </>
                  )}
                </div>
                {status.baseUrl && <div className="truncate text-xs text-muted-foreground">{status.baseUrl}</div>}
                {status.error && <div className="text-xs text-destructive">{status.error}</div>}
                {status.models && status.models.length > 0 && (
                  <div>
                    <div className="mb-1 text-xs font-medium text-muted-foreground">Models FCC currently exposes</div>
                    <ul className="flex flex-wrap gap-1.5">
                      {status.models.map((model) => (
                        <li key={model} className="rounded-full bg-background px-2.5 py-1 text-xs ring-1 ring-border">
                          {model}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {status.adminUrl && (
                  <a
                    href={status.adminUrl}
                    target="_blank"
                    rel="noreferrer"
                    className={cn("flex w-fit items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground")}
                  >
                    Open Admin UI <ExternalLink className="size-3.5" />
                  </a>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
