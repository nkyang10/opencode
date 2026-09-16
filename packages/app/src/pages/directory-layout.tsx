import { DataProvider } from "@opencode-ai/session-ui/context"
import { showToast } from "@/utils/toast"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { type Accessor, createEffect, createMemo, createResource, onCleanup, onMount, type ParentProps, Show } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { useLanguage } from "@/context/language"
import { LocalProvider } from "@/context/local"
import { SDKProvider } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { decode64 } from "@/utils/base64"
import { Schema } from "effect"
import type { ServerConnection } from "@/context/server"
import { sessionHref } from "@/utils/session-route"
import { useServerSync } from "@/context/server-sync"
import { debugLog } from "@/utils/foreground-debug"

export function DirectoryDataProvider(
  props: ParentProps<{
    directory: string | Accessor<string>
    draftID?: string
    server?: Accessor<ServerConnection.Key | undefined>
  }>,
) {
  const location = useLocation()
  const navigate = useNavigate()
  const params = useParams()
  const sync = useSync()
  const serverSync = useServerSync()
  const directory = () => (typeof props.directory === "function" ? props.directory() : props.directory)
  const slug = createMemo(() => base64Encode(directory()))
  const href = (sessionID: string) => {
    const server = props.server?.()
    if (server) return sessionHref(server, sessionID)
    return `/${slug()}/session/${sessionID}`
  }

  createEffect(() => {
    // A draft lives at /new-session?draftId=… and has no directory segment to normalize.
    if (props.draftID || props.server?.()) return
    const next = sync().data.path.directory
    if (!next || next === directory()) return
    const path = location.pathname.slice(slug().length + 1)
    navigate(`/${base64Encode(next)}${path}${location.search}${location.hash}`, { replace: true })
  })

  createResource(
    () => params.id,
    (id) =>
      sync()
        .session.sync(id)
        .catch(() => {}),
  )

  createEffect(() => {
    const sessionID = params.id
    if (!sessionID) return
    serverSync().session.pin(sessionID)
    onCleanup(() => serverSync().session.unpin(sessionID))
  })

  // Returning from background (mobile app switch, bfcache restore) loses SSE updates emitted
  // while suspended. Re-fetch the open session's content and rebuild the pending question dock
  // from fresh server state, so the decision dialog self-heals without switching tabs.
  // iOS Safari doesn't reliably fire `visibilitychange`→visible or bfcache `pageshow` on
  // app background→foreground, so also track `pagehide` (reliably fired on iOS when leaving)
  // and re-check on `focus`, re-syncing only if we recently left the page (not routine focus).
  onMount(() => {
    let lastHiddenAt = 0
    const markHidden = () => {
      lastHiddenAt = Date.now()
    }
    const foreground = () => {
      const id = params.id
      if (!id) return
      if (document.visibilityState !== "visible") {
        debugLog("lyt:foreground", `skip visibility=${document.visibilityState}`)
        return
      }
      debugLog("lyt:foreground", `begin id=${id}`)
      void Promise.all([
        sync()
          .session.sync(id, { force: true })
          .catch((error) => debugLog("lyt:sync-error", String(error))),
        sync()
          .session.syncQuestions(id)
          .catch((error) => debugLog("lyt:syncq-error", String(error))),
      ]).then(() => debugLog("lyt:foreground", "end"))
    }
    onCleanup(
      makeEventListener(document, "visibilitychange", () => {
        debugLog("lyt:visibilitychange", `state=${document.visibilityState}`)
        if (document.visibilityState === "hidden") {
          markHidden()
          return
        }
        foreground()
      }),
    )
    onCleanup(
      makeEventListener(window, "pageshow", (event) => {
        debugLog("lyt:pageshow", `persisted=${event.persisted}`)
        if (event.persisted) foreground()
      }),
    )
    onCleanup(makeEventListener(window, "pagehide", markHidden))
    onCleanup(
      makeEventListener(window, "focus", () => {
        debugLog("lyt:focus", `lastHiddenAt=${lastHiddenAt} age=${Date.now() - lastHiddenAt}`)
        if (lastHiddenAt && Date.now() - lastHiddenAt < 5000) foreground()
      }),
    )
  })

  return (
    <Show when={directory()} keyed>
      {(directory) => (
        <DataProvider
          data={sync().data}
          directory={directory}
          sessionID={params.id}
          onNavigateToSession={(sessionID: string) => navigate(href(sessionID))}
          onSessionHref={href}
        >
          <LocalProvider>{props.children}</LocalProvider>
        </DataProvider>
      )}
    </Show>
  )
}

export const ProjectDirString = Schema.String.pipe(Schema.brand("ProjectDirString"))
export type ProjectDirString = Schema.Schema.Type<typeof ProjectDirString>

export function decodeDirectory(dir: string): ProjectDirString | undefined {
  const decoded = decode64(dir)
  if (!decoded) return
  return ProjectDirString.make(decoded)
}

export default function Layout(props: ParentProps) {
  const params = useParams()
  const language = useLanguage()
  const navigate = useNavigate()
  let invalid = ""

  const resolved = createMemo(() => {
    if (!params.dir) return ""
    return decodeDirectory(params.dir) ?? ""
  })

  createEffect(() => {
    const dir = params.dir
    if (!dir) return
    if (resolved()) {
      invalid = ""
      return
    }
    if (invalid === dir) return
    invalid = dir
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: language.t("directory.error.invalidUrl"),
    })
    navigate("/", { replace: true })
  })

  return (
    <Show when={resolved()} keyed>
      {(resolved) => (
        <SDKProvider directory={resolved}>
          <DirectoryDataProvider directory={resolved}>{props.children}</DirectoryDataProvider>
        </SDKProvider>
      )}
    </Show>
  )
}
