import { ServerConnection, useServer } from "@/context/server"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { ServerHealth } from "@/utils/server-health"
import { createEffect } from "solid-js"

/**
 * Watches the active server's health `version`. When a newly deployed server
 * reports a different version than the previous build the client already saw,
 * show a persistent toast with a Refresh action so the user can load the new
 * bundle. The health poll is the existing 10s pull: `GET /api/health` now
 * returns `{ healthy, version }` (protocol health group + server handler).
 */
export function ServerUpdateRefresh() {
  const global = useGlobal()
  const server = useServer()
  const language = useLanguage()
  const seen = new Map<ServerConnection.Key, string>()

  createEffect(() => {
    const list = server.list
    const activeKey = server.key
    const order = [...list].sort((a, b) =>
      ServerConnection.key(a) === activeKey ? -1 : ServerConnection.key(b) === activeKey ? 1 : 0,
    )

    for (const conn of order) {
      const key = ServerConnection.key(conn)
      const health: ServerHealth | undefined = global.servers.health[key]
      const next = health?.version
      if (!health?.healthy || !next) continue

      const previous = seen.get(key)
      if (previous === undefined) {
        seen.set(key, next)
        continue
      }
      if (previous === next) continue

      seen.set(key, next)
      showToast({
        variant: "success",
        persistent: true,
        title: language.t("toast.serverUpdate.title"),
        description: language.t("toast.serverUpdate.description", { version: next }),
        actions: [
          {
            label: language.t("toast.serverUpdate.refresh"),
            onClick: () => window.location.reload(),
          },
        ],
      })
    }
  })

  return null
}
