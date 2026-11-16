/**
 * Free Claude Code status check (EdgeOne copy).
 *
 * Kept as its own copy here rather than importing agents/_fcc_status.ts: EdgeOne
 * bundles cloud functions and agent routes as separate deployment units, each
 * only reaching modules within its own top-level folder (see cloud-functions/
 * _feedback.ts's header for the same reasoning). The two copies are meant to
 * stay byte-for-byte identical in behavior — change one, change the other.
 *
 * This is the web equivalent of fcc-cli's (github.com/bobbibob/fcc-cli)
 * `fcc-gui` status pill: it can't start/stop the remote FCC process (Devon's
 * backend has no access to whatever machine FCC actually runs on), but it can
 * report whether DEVON_FCC_BASE_URL is reachable and which models it
 * currently exposes, and it can hand back a link to the real Admin UI.
 */

type Env = Record<string, string | undefined>;

export interface FccStatus {
  configured: boolean;
  baseUrl?: string;
  reachable: boolean;
  models?: string[];
  adminUrl?: string;
  error?: string;
}

function clean(value: string | undefined): string {
  return (value ?? '').trim();
}

/** Pings DEVON_FCC_BASE_URL's /v1/models endpoint; never throws. */
export async function checkFccStatus(env: Env): Promise<FccStatus> {
  const baseUrl = clean(env.DEVON_FCC_BASE_URL).replace(/\/+$/, '');
  if (!baseUrl) return { configured: false, reachable: false };

  const apiKey = clean(env.DEVON_FCC_API_KEY);
  const adminUrl = `${baseUrl}/admin`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(`${baseUrl}/v1/models?view=messages`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!response.ok) {
      return {
        configured: true,
        baseUrl,
        reachable: response.status !== 0,
        adminUrl,
        error: `FCC responded with HTTP ${response.status}${response.status === 401 || response.status === 403 ? ' (check DEVON_FCC_API_KEY against its Proxy Authentication token)' : ''}`,
      };
    }

    const body = await response.json().catch(() => null) as { data?: { id?: string }[] } | null;
    const models = Array.isArray(body?.data) ? body.data.map((m) => m.id).filter((id): id is string => typeof id === 'string') : undefined;
    return { configured: true, baseUrl, reachable: true, models, adminUrl };
  } catch (error) {
    return {
      configured: true,
      baseUrl,
      reachable: false,
      adminUrl,
      error: error instanceof Error ? error.message : 'Could not reach the FCC server',
    };
  }
}
