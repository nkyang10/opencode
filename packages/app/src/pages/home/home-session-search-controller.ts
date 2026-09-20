import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { serverName } from "@/context/server"
import { displayName } from "@/pages/layout/helpers"
import { makeEventListener } from "@solid-primitives/event-listener"
import { useQuery } from "@tanstack/solid-query"
import { createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { loadHomeSessionIndex, retainHomeSessions } from "@/context/global-sync/home-session-index"
import type { HomeController } from "./home-controller"
import {
  buildHomeSessionRecords,
  projectDirectories as homeProjectDirectories,
  homeSessionSearchKey,
  type HomeSessionRecord,
} from "./home-session-records"

const HOME_SEARCH_LIMIT = 64

type HomeSessionSearchSource = {
  session: { open: (session: Session, options?: { background?: boolean }) => void }
}

export function createHomeSessionSearchController(home: HomeController, sessions: HomeSessionSearchSource) {
  const command = useCommand()
  const language = useLanguage()
  const [state, setState] = createStore({ value: "", focused: false, highlighted: "" })
  let root: HTMLDivElement | undefined
  let input: HTMLInputElement | undefined
  let list: HTMLDivElement | undefined
  const query = createMemo(() => state.value.trim())

  const homeSessionCache = () => home.server.focusedSync().homeSessions
  const projectDirectories = createMemo(() => {
    const project = home.project.selected()
    if (!project) return home.project.list().flatMap(homeProjectDirectories)
    return homeProjectDirectories(project)
  })
  const projectByID = createMemo(
    () => new Map(home.project.list().flatMap((project) => (project.id ? [[project.id, project] as const] : []))),
  )

  // Eager full-index scan for search; only runs while the search is focused so
  // a refresh that never opens search does not pay the full table scan.
  const searchLoad = useQuery(() => ({
    queryKey: homeSessionCache().indexKey,
    enabled: state.focused && !!home.server.focusedContext(),
    queryFn: async ({ signal }) => {
      const ctx = home.server.focusedContext()
      if (!ctx) return { sessions: [] as Session[], eventSequence: 0 }
      const cache = homeSessionCache()
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

  const searchRecords = createMemo(() => {
    if (!state.focused) return []
    const data = searchLoad.data
    if (!data) return []
    return buildHomeSessionRecords({
      sessions: () => retainHomeSessions(data.sessions, HOME_SEARCH_LIMIT, Date.now()),
      projectDirectories,
      projects: home.project.list,
      projectByID,
    })
  })

  const results = createMemo(() => {
    const value = query().toLowerCase()
    if (!value) return []
    return searchRecords()
      .filter((record) => `${record.session.title} ${record.projectName}`.toLowerCase().includes(value))
  })
  const active = createMemo(() => {
    const records = results()
    if (records.some((record) => homeSessionSearchKey(record) === state.highlighted)) return state.highlighted
    return records[0] ? homeSessionSearchKey(records[0]) : ""
  })
  const open = createMemo(() => state.focused && query().length > 0)
  const placeholder = createMemo(() => {
    const project = home.project.selected()
    if (project) return language.t("home.sessions.search.placeholder.scoped", { scope: displayName(project) })
    if (home.server.list().length > 1) {
      const conn = home.server.focused()
      if (conn) return language.t("home.sessions.search.placeholder.scoped", { scope: serverName(conn) })
    }
    return language.t("home.sessions.search.placeholder")
  })

  onCleanup(
    makeEventListener(document, "pointerdown", (event) => {
      if (!open()) return
      const target = event.target
      if (!(target instanceof Node) || root?.contains(target)) return
      close()
    }),
  )

  command.register("home.search", () => [
    {
      id: "home.sessions.search.focus",
      title: placeholder(),
      keybind: "mod+f",
      hidden: true,
      onSelect: focus,
    },
  ])

  function focus() {
    input?.focus()
    setState("focused", true)
  }

  function close() {
    setState({ value: "", focused: false })
  }

  function select(record: HomeSessionRecord, options?: { background?: boolean }) {
    sessions.session.open(record.session, options)
    if (!options?.background) close()
  }

  return {
    query: {
      value: () => state.value,
      placeholder,
      open,
      focus,
      input: (value: string) => setState({ value, highlighted: "" }),
      close,
    },
    result: {
      loading: () => state.focused && searchLoad.isLoading,
      list: results,
      active,
      noResultsLabel: () => language.t("home.sessions.search.noResults", { query: query() }),
      highlight: (record: HomeSessionRecord) => setState("highlighted", homeSessionSearchKey(record)),
      move: (delta: number) => {
        const records = results()
        if (records.length === 0) return
        const index = records.findIndex((record) => homeSessionSearchKey(record) === active())
        const next = ((index === -1 ? 0 : index) + delta + records.length) % records.length
        setState("highlighted", homeSessionSearchKey(records[next]))
        list?.querySelector<HTMLElement>(`[data-key="${state.highlighted}"]`)?.scrollIntoView({ block: "nearest" })
      },
      select,
      selectActive: () => {
        const record = results().find((item) => homeSessionSearchKey(item) === active())
        if (record) select(record)
      },
    },
    element: {
      setRoot: (element: HTMLDivElement) => (root = element),
      setInput: (element: HTMLInputElement) => (input = element),
      setList: (element: HTMLDivElement) => (list = element),
    },
  }
}

export type HomeSessionSearchController = ReturnType<typeof createHomeSessionSearchController>
