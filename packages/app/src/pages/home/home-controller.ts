import { useGlobal } from "@/context/global"
import { type HomeProjectSelection, type LocalProject, useLayout } from "@/context/layout"
import { ServerConnection, useServer } from "@/context/server"
import { type ServerSync, useServerSync } from "@/context/server-sync"
import { useTabs } from "@/context/tabs"
import { toggleHomeProjectSelection } from "@/pages/layout/helpers"
import { pathKey } from "@/utils/path-key"
import { useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo } from "solid-js"
import { mergeProjectFolders } from "./home-project-folders"

export function createHomeController() {
  const sync = useServerSync()
  const layout = useLayout()
  const server = useServer()
  const global = useGlobal()
  const tabs = useTabs()
  const queryClient = useQueryClient()
  const selection = layout.home.selection
  const focusedServer = createMemo(
    () => global.servers.list().find((conn) => ServerConnection.key(conn) === selection().server) ?? server.current,
  )
  const focusedServerCtx = createMemo(() => {
    const conn = focusedServer()
    if (!conn) return undefined
    return global.ensureServerCtx(conn)
  })
  const focusedSync = () => focusedServerCtx()?.sync ?? sync()
  // The Home project list is the SOURCE OF TRUTH from the server (/project),
  // NOT the per-device localStorage store. This keeps the "starting project
  // selection" session list identical across devices/browsers. Plain folders
  // (directories that are not a git repository) have no project row, so the
  // directories the server recorded for the global project are listed too.
  const projectsFor = (data: ServerSync["data"]) => mergeProjectFolders(data.project, data.folder)
  const projects = createMemo<LocalProject[]>(() => projectsFor(focusedSync().data))
  const recentlyClosed = createMemo(
    () => focusedServerCtx()?.projects.recentlyClosed() ?? layout.projects.recentlyClosed(),
  )
  const homedir = createMemo(() => focusedSync().data.path.home ?? "")
  const selectedProject = createMemo(() => projects().find((project) => project.worktree === selection().directory))
  const newSessionProject = createMemo(
    () =>
      selectedProject() ??
      projects().find((project) => project.worktree === focusedServerCtx()?.projects.last()) ??
      projects()[0],
  )

  createEffect(() => {
    const list = global.servers.list()
    if (list.some((conn) => ServerConnection.key(conn) === selection().server)) return
    const conn = list.find((conn) => ServerConnection.key(conn) === server.key) ?? list[0]
    if (conn) setSelection({ server: ServerConnection.key(conn) })
  })

  function setSelection(next: HomeProjectSelection) {
    layout.home.setSelection(next)
  }

  function openProjectNewSession(conn: ServerConnection.Any, directory: string) {
    const ctx = global.ensureServerCtx(conn)
    ctx.projects.open(directory)
    ctx.projects.touch(directory)
    void tabs.newDraft({ server: ServerConnection.key(conn), directory })
  }

  return {
    selection: {
      value: selection,
      set: setSelection,
      focusServer: (conn: ServerConnection.Any) => setSelection({ server: ServerConnection.key(conn) }),
    },
    server: {
      list: global.servers.list,
      health: (conn: ServerConnection.Any) => global.servers.health[ServerConnection.key(conn)],
      context: (conn: ServerConnection.Any) => global.ensureServerCtx(conn),
      focused: focusedServer,
      focusedContext: focusedServerCtx,
      focusedSync,
    },
    project: {
      list: projects,
      recentlyClosed,
      homedir,
      selected: selectedProject,
      newSession: newSessionProject,
      // Every server section is server truth too, not just the focused one, so a
      // plain folder is listed under a remote server as well.
      forServer: (conn: ServerConnection.Any) => projectsFor(global.ensureServerCtx(conn).sync.data),
      select: (conn: ServerConnection.Any, directory: string) => {
        const key = ServerConnection.key(conn)
        if (global.servers.health[key]?.healthy === false) return
        // Accept any directory known to the server, even before this device has
        // added it to its (now deprecated) local open-projects store. Plain
        // folders count as known: they are directories the server resolved, they
        // just have no project row because they are not a git repository.
        const data = (conn === focusedServer() ? focusedSync() : global.ensureServerCtx(conn).sync).data
        const known = new Set([...data.project.map((project) => pathKey(project.worktree)), ...data.folder.map(pathKey)])
        if (!known.has(pathKey(directory))) return
        setSelection(toggleHomeProjectSelection(selection(), key, directory))
      },
      add: (conn: ServerConnection.Any, directories: string[]) => {
        const directory = directories[0]
        if (!directory) return
        const ctx = global.ensureServerCtx(conn)
        directories.forEach((item) => {
          if (ctx.projects.list().some((project) => project.worktree === item)) return
          const location = { directory: item }
          // Resolving the project is what makes the server record the directory,
          // which is how a folder without a repository becomes a listed project.
          // No `initGit` here: a folder does not have to be a repository to be
          // worked in, and initialising one would write into the user's folder.
          void ctx.sdk.api.project
            .current({ location })
            .then((project) => {
              ctx.sync.child(item, { bootstrap: false })[1]("project", project.id)
              // The recording only just happened, so refetch instead of waiting for
              // the `project.directories.updated` event to come back around.
              return queryClient.fetchQuery(ctx.sync.queryOptions.projectFolders())
            })
            .catch(() => undefined)
          ctx.projects.open(item)
        })
        ctx.projects.touch(directory)
        setSelection({ server: ServerConnection.key(conn), directory })
      },
      openNewSession: () => {
        const conn = focusedServer()
        const project = newSessionProject()
        if (!conn || !project) return
        openProjectNewSession(conn, project.worktree)
      },
      openProjectNewSession,
    },
  }
}

export type HomeController = ReturnType<typeof createHomeController>
