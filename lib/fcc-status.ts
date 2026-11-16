/**
 * devon://fcc-status — the Free Claude Code status page (components/
 * fcc-status-page.tsx). A maintainer-only tool, so unlike lib/apps.ts's
 * devon://apps/* pages it isn't listed anywhere a visitor would browse to;
 * it's a top-level address like devon://games, reachable only by typing it.
 */

export const FCC_STATUS_URL = "devon://fcc-status"

/** devon://fcc-status (with or without a trailing slash/query) → true, else false */
export function parseFccStatusUrl(input: string): boolean {
  return /^devon:\/\/fcc-status\/?(?:[?#].*)?$/i.test(input.trim())
}
