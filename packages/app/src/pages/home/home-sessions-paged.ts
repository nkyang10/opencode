import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import {
  fetchHomeSessionPage,
  type HomeSessionEvents,
  type HomeSessionFetchPage,
} from "@/context/global-sync/home-session-index"
import type { Session } from "@opencode-ai/sdk/v2/client"

// Deduplicated merge favouring the newest entry for a given session id, sorted
// newest-first by updated time (falling back to created time).
export function mergeSessionPages(pages: Session[][]): Session[] {
  const ordered = new Map<string, Session>()
  for (const page of pages) {
    for (const session of page) ordered.set(session.id, session)
  }
  return [...ordered.values()].sort(
    (a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created),
  )
}

export type PagedHomeSessions = {
  sessions: Accessor<Session[]>
  hasMore: Accessor<boolean>
  loadingMore: Accessor<boolean>
  loadMore: () => Promise<void>
}

// Cursor-paginated loader for the Home session lists. Page 1 is backed by a
// tanstack query (refetch on mount / reconnect, stale-aware); subsequent pages
// are appended client-side via `loadMore`. SSE session events trigger a cheap
// page-1 reload so new/updated sessions surface at the top without merging
// cursor pages.
export function createPagedHomeSessions(options: {
  queryKey: () => ReadonlyArray<string>
  enabled: Accessor<boolean>
  list: () => HomeSessionFetchPage["list"]
  pageLimit: number
  eventsKey?: () => ReadonlyArray<string>
}): PagedHomeSessions {
  const queryClient = useQueryClient()

  const page1 = useQuery(() => ({
    queryKey: [...options.queryKey()],
    enabled: options.enabled(),
    queryFn: async ({ signal }) =>
      fetchHomeSessionPage(options.list(), options.pageLimit, undefined, signal),
    staleTime: 30_000,
    refetchOnMount: true,
    refetchOnReconnect: true,
    refetchOnWindowFocus: false,
  }))

  const [state, setState] = createStore({
    extraPages: [] as Session[][],
    cursor: undefined as string | undefined,
    hasMore: false,
    loadingMore: false,
  })

  const sessions: Accessor<Session[]> = () => {
    const first = page1.data
    const pages: Session[][] = first ? [first.sessions, ...state.extraPages] : state.extraPages
    return mergeSessionPages(pages)
  }

  const hasMore: Accessor<boolean> = () => {
    const first = page1.data
    const baseHasMore = state.extraPages.length > 0 ? state.hasMore : first?.hasMore
    return state.loadingMore || (baseHasMore ?? false)
  }

  // When new sessions arrive via SSE events, reload page 1 (cheap, top stays fresh).
  if (options.eventsKey) {
    const eventsKey = options.eventsKey
    createEffect(() => {
      const events = queryClient.getQueryData<HomeSessionEvents>([...eventsKey()])
      const seq = events?.sequence ?? 0
      if (seq === 0) return
      const id = setTimeout(() => void reloadFirstPage(), 0)
      return () => clearTimeout(id)
    })
  }

  async function reloadFirstPage() {
    setState({ extraPages: [], cursor: undefined, hasMore: false })
    await page1.refetch()
  }

  async function loadMore() {
    if (state.loadingMore) return
    const next = state.cursor ?? page1.data?.nextCursor
    if (!next) return
    setState({ loadingMore: true })
    try {
      const page = await fetchHomeSessionPage(options.list(), options.pageLimit, next)
      setState({
        cursor: page.nextCursor,
        hasMore: page.hasMore,
        extraPages: [...state.extraPages, page.sessions],
      })
    } finally {
      setState({ loadingMore: false })
    }
  }

  return {
    sessions,
    hasMore,
    loadingMore: () => state.loadingMore,
    loadMore,
  }
}
