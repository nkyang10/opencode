export * as ScreenCaptureSelect from "./select"

import type { Window } from "./schema"

export type Match = {
  readonly selected: Window
  readonly others: ReadonlyArray<Window>
}

export const MAX_CANDIDATES = 10

const normalizeId = (id: string) => {
  const trimmed = id.trim().toLowerCase()
  try {
    return BigInt(trimmed).toString(16)
  } catch {
    return trimmed
  }
}

export const sameWindowId = (left: string, right: string) => normalizeId(left) === normalizeId(right)

export function isWindowId(selector: string) {
  return /^0x[0-9a-f]{1,16}$/i.test(selector.trim())
}

export function matchWindows(windows: ReadonlyArray<Window>, selector: string): Window[] {
  const wanted = selector.trim()
  if (!wanted) return []
  const lower = wanted.toLowerCase()
  const ids = windows.filter((window) => normalizeId(window.id) === normalizeId(wanted))
  if (ids.length > 0) return ids
  const apps = windows.filter((window) => window.app?.toLowerCase() === lower)
  if (apps.length > 0) return apps
  return windows.filter((window) => window.title?.toLowerCase().includes(lower))
}

export function selectWindow(
  windows: ReadonlyArray<Window>,
  selector: string,
  activeID?: string,
): { ok: true; match: Match } | { ok: false; candidates: string[] } {
  const matches = orderFrontToBack(matchWindows(windows, selector), activeID)
  if (matches.length === 0) return { ok: false, candidates: windows.slice(0, MAX_CANDIDATES).map(summarize) }
  const selected = matches[0]
  if (!selected) return { ok: false, candidates: windows.slice(0, MAX_CANDIDATES).map(summarize) }
  return { ok: true, match: { selected, others: matches.slice(1) } }
}

export function orderFrontToBack(windows: ReadonlyArray<Window>, activeID?: string) {
  if (!activeID) return [...windows]
  const active = windows.find((window) => normalizeId(window.id) === normalizeId(activeID))
  if (!active) return [...windows]
  return [active, ...windows.filter((window) => window !== active)]
}

export function summarize(window: Window) {
  const app = window.app ? ` ${window.app}` : ""
  const pid = window.pid === undefined ? "" : ` pid ${window.pid}`
  const title = window.title ? ` "${window.title}"` : ""
  return `${window.id}${app}${pid}${title}`
}
