import type { ServerHealth } from "@/utils/server-health"

/** An outage is not evidence of a deploy. Only compare healthy version reports. */
export function serverUpdateVersion(previous: string | undefined, health: ServerHealth) {
  if (!health.healthy || !health.version?.trim()) return { version: previous, changed: false }
  return { version: health.version, changed: previous !== undefined && previous !== health.version }
}
