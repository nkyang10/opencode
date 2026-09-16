import type { Session } from "@opencode-ai/sdk/v2/client"
import { useQuery } from "@tanstack/solid-query"
import { createEffect, createMemo, startTransition } from "solid-js"
import {
  loadHomeSessionIndex,
  retainHomeSessions,
  type HomeSessionEvents,
} from "@/context/global-sync/home-session-index"
import type { LocalProject } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { ServerConnection, serverName } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { sessionHasOpenTab, useTabs } from "@/context/tabs"
import { compareSessionTime, displayName, projectForSession } from "@/pages/layout/helpers"
import { pathKey } from "@/utils/path-key"
import type { HomeController } from "./home-controller"
import type { HomeSessionRecord } from "./home-sessions-controller"

export const HOME_SESSION_TABLE_LIMIT = 64

const HOME_SESSION_PREVIEW_LIMIT = 20
const HOME_SESSION_PREVIEW_CONCURRENCY = 3

export function createHomeSessionsTableController(home: HomeController) {
  const tabs = useTabs()
  const language = useLanguage()
  const projectByID = createMemo(
    () => new Map(home.project.list().flatMap((project) => (project.id ? [[project.id, project] as const] : []))),
  )
  const homeSessions = () => home.server.focusedSync().homeSessions

  const sessionEventLoad = useQuery(() => ({
    queryKey: homeSessions().eventsKey,
    queryFn: async (): Promise<HomeSessionEvents> => ({ sequence: 0, entries: [] }),
    initialData: { sequence: 0, entries: [] } satisfies HomeSessionEvents,
    enabled: false,
  }))

  const sessionLoad = useQuery(() => ({
    queryKey: homeSessions().indexKey,
    enabled: !!home.server.focusedContext(),
    queryFn: async ({ signal }) => {
      const ctx = home.server.focusedContext()
      if (!ctx) return { sessions: [], eventSequence: 0 }
      const cache = homeSessions()
      const eventSequence = cache.eventSequence()
      const index = await loadHomeSessionIndex(
        (input, options) => ctx.sdk.client.v2.session.list(input, options),
        eventSequence,
        signal,
      )
      cache.complete(eventSequence)
      return index
    },
    retry: false,
    staleTime: 30_000,
    refetchOnMount: true,
    refetchOnReconnect: true,
  }))

  const indexedSessions = createMemo(() =>
    retainHomeSessions(
      homeSessions().sessions(sessionLoad.data, sessionEventLoad.data),
      HOME_SESSION_TABLE_LIMIT,
      Date.now(),
    ),
  )

  const records = createMemo(() => buildAllFolderRecords(indexedSessions, home.project.list, projectByID))

  const server = createMemo(() => home.selection.value().server)

  const previewSync = useServerSync()
  const previewInflight = new Set<string>()
  const previewPending: string[] = []
  const previewQueued = new Set<string>()
  const pumpPreview = () => {
    while (previewInflight.size < HOME_SESSION_PREVIEW_CONCURRENCY) {
      const sessionID = previewPending.shift()
      if (!sessionID) break
      previewInflight.add(sessionID)
      void previewSync()
        .session.prefetch(sessionID, HOME_SESSION_PREVIEW_LIMIT)
        .catch(() => {})
        .finally(() => {
          previewInflight.delete(sessionID)
          pumpPreview()
        })
    }
  }
  createEffect(() => {
    const entries = records()
    for (const record of entries) {
      const sessionID = record.session.id
      if (previewInflight.has(sessionID) || previewQueued.has(sessionID)) continue
      if (!previewSync().session.shouldPrefetch(sessionID, HOME_SESSION_PREVIEW_LIMIT)) continue
      previewPending.push(sessionID)
      previewQueued.add(sessionID)
    }
    pumpPreview()
  })

  const open = (session: Session, options?: { background?: boolean }) => {
    const directoryKey = pathKey(session.directory)
    const project =
      home.project
        .list()
        .find(
          (item) =>
            pathKey(item.worktree) === directoryKey ||
            item.sandboxes?.some((sandbox) => pathKey(sandbox) === directoryKey),
        ) ?? projectForSession(session, home.project.list(), projectByID())
    const conn = home.server.focused()
    if (!conn) return
    const directory = project?.worktree ?? session.directory
    const ctx = home.server.focusedContext()
    if (!ctx) return
    ctx.projects.open(directory)
    if (options?.background) {
      tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: session.id })
      return
    }
    ctx.projects.touch(directory)
    void startTransition(() => {
      const tab = tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: session.id })
      tabs.select(tab)
    })
  }

  return {
    copy: { language },
    data: {
      records,
      loading: () => sessionLoad.isLoading,
    },
    session: {
      showProjectName: () => true,
      server,
      serverName: () => serverName(home.server.focused()),
      open,
    },
    tab: {
      isOpen: (record: HomeSessionRecord) =>
        sessionHasOpenTab(tabs.store, home.selection.value().server, record.session),
    },
  }
}

function buildAllFolderRecords(
  sessions: () => Session[],
  projects: () => LocalProject[],
  projectByID: () => Map<string, LocalProject>,
) {
  const projectList = projects()
  const directories = new Set(projectList.flatMap((project) => [project.worktree, ...(project.sandboxes ?? [])]).map(pathKey))
  const filtered = sessions().filter((session) => directories.has(pathKey(session.directory)))
  return [...new Map(filtered.map((session) => [session.id, session] as const)).values()]
    .sort(compareSessionTime)
    .flatMap((session) => {
      const directory = pathKey(session.directory)
      const project =
        projectList.find(
          (item) =>
            pathKey(item.worktree) === directory || item.sandboxes?.some((sandbox) => pathKey(sandbox) === directory),
        ) ?? projectForSession(session, projectList, projectByID())
      if (!project) return []
      return { session, project, projectName: displayName(project) }
    })
}
