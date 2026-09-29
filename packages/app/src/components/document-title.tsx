import { createRenderEffect } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { ServerConnection } from "@/context/server"
import { useTabs } from "@/context/tabs"

// The product name is not translated, and it is already the static title in `index.html`; this is
// the same string the browser, the installed PWA and the desktop window show before hydration.
const APP_TITLE = "MarkCode"

/**
 * Puts how many of the open agent tabs are finished into the window title — `MarkCode [1 of 2]`.
 *
 * The title is the one piece of the UI that is still on screen when the user is in another app on
 * their phone, so it is where "is the agent done yet" belongs. `session_working` is the app's own
 * definition of a session that is still going (`busy` and `retry` both count as not finished), and
 * the open tabs are the persisted titlebar list, so the numbers follow tab open/close and every
 * status event without a reload.
 *
 * A draft tab is not an agent yet — it has no session and cannot be busy — so it is left out of
 * both numbers rather than counted as finished.
 */
export function DocumentTitle() {
  const global = useGlobal()
  const language = useLanguage()
  const tabs = useTabs()

  createRenderEffect(() => {
    if (typeof document === "undefined") return
    const connections = global.servers.list()
    const agents = tabs.store.filter((tab) => tab.type === "session")
    const finished = agents.filter((tab) => {
      const connection = connections.find((item) => ServerConnection.key(item) === tab.server)
      if (!connection) return true
      return !global.ensureServerCtx(connection).sync.session.data.session_working(tab.sessionId)
    }).length
    document.title = agents.length
      ? `${APP_TITLE} ${language.t("app.title.tabs", { done: finished, total: agents.length })}`
      : APP_TITLE
  })

  return null
}
