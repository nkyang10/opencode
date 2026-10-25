import { ServerConnection, useServer } from "@/context/server"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { ServerHealth } from "@/utils/server-health"
import { createEffect } from "solid-js"
import { serverUpdateVersion } from "./server-update-state"

/** Prompt only when a healthy server reports a different version. Temporary
 * disconnects and same-version restarts do not make the embedded UI stale. */
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
      if (!health) continue
      const next = serverUpdateVersion(seen.get(key), health)
      if (next.version !== undefined) seen.set(key, next.version)
      if (next.changed && next.version) showRefreshToast(language, next.version)
    }
  })

  return null
}
