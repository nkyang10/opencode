import { ServerConnection, useServer } from "@/context/server"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { ServerHealth } from "@/utils/server-health"
import { createEffect } from "solid-js"

/**
 * Watches the active server's health. Shows a persistent Refresh toast when a
 * new deploy is detected. Unlike the old version-only comparison, this also
 * fires when a previously-seen healthy server goes down and comes back up
 * (a deploy restart) even if the reported `version` string is unchanged — so an
 * AJAX update / reconnect after a server restart still prompts a refresh.
 * The health poll is the existing 10s pull: `GET /api/health` returns
 * `{ healthy, version }` (protocol health group + server handler).
 */
type SeenState = { version: string; up: boolean }

function showRefreshToast(language: ReturnType<typeof useLanguage>, version: string) {
  showToast({
    variant: "success",
    persistent: true,
    title: language.t("toast.serverUpdate.title"),
    description: language.t("toast.serverUpdate.description", { version }),
    actions: [
      {
        label: language.t("toast.serverUpdate.refresh"),
        onClick: () => window.location.reload(),
      },
    ],
  })
}

export function ServerUpdateRefresh() {
  const global = useGlobal()
  const server = useServer()
  const language = useLanguage()
  const seen = new Map<ServerConnection.Key, SeenState>()

  createEffect(() => {
    const list = server.list
    const activeKey = server.key
    const order = [...list].sort((a, b) =>
      ServerConnection.key(a) === activeKey ? -1 : ServerConnection.key(b) === activeKey ? 1 : 0,
    )

    for (const conn of order) {
      const key = ServerConnection.key(conn)
      const health: ServerHealth | undefined = global.servers.health[key]
      if (!health) continue
      const next = health.version ?? ""

      const prev = seen.get(key)

      // First observation — record a baseline, never toast on the very first poll.
      if (prev === undefined) {
        seen.set(key, { version: next, up: health.healthy })
        continue
      }

      // Server is currently down/unhealthy (deploy restart window).
      if (!health.healthy || !health.version) {
        seen.set(key, { version: next, up: false })
        continue
      }

      // Recovered from a drop — the server restarted. Toast even if version is
      // identical, so a redeploy that doesn't change the version string still
      // triggers the refresh prompt.
      if (!prev.up) {
        seen.set(key, { version: next, up: true })
        showRefreshToast(language, next)
        continue
      }

      // Never went down — only toast when the reported version actually changed.
      if (prev.version === next) continue
      seen.set(key, { version: next, up: true })
      showRefreshToast(language, next)
    }
  })

  return null
}
