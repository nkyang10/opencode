import { createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useServerSDK } from "./server-sdk"
import { usePlatform } from "./platform"
import { useLanguage } from "./language"
import { authTokenFromCredentials } from "@/utils/server"
import type { ServerConnection } from "./server"
import { showToast } from "@/utils/toast"

export type PauseState = { paused: boolean; waiting: boolean }

export async function requestSessionPause(input: {
  server: ServerConnection.HttpBase
  sessionID: string
  paused?: boolean
  fetch?: (url: string, options?: RequestInit) => Promise<Response>
}): Promise<PauseState | undefined> {
  const response = await (input.fetch ?? globalThis.fetch)(
    `${input.server.url.replace(/\/+$/, "")}/api/session/${encodeURIComponent(input.sessionID)}/pause`,
    {
      method: input.paused === undefined ? "GET" : "POST",
      headers: {
        ...(input.server.password
          ? {
              Authorization: `Basic ${authTokenFromCredentials({ username: input.server.username, password: input.server.password })}`,
            }
          : {}),
        ...(input.paused === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(input.paused === undefined ? {} : { body: JSON.stringify({ paused: input.paused }) }),
    },
  )
  if (response.status === 404) return
  if (!response.ok) throw new Error(String(response.status))
  const state = (await response.json()) as PauseState
  if (typeof state.paused !== "boolean" || typeof state.waiting !== "boolean") return
  return state
}

export function useSessionPause(input: { sessionID: () => string | undefined; working: () => boolean }) {
  const sdk = useServerSDK()
  const platform = usePlatform()
  const language = useLanguage()
  const [state, setState] = createStore({ available: false, paused: false, waiting: false, pending: false })
  let generation = 0
  let revision = 0

  createEffect(() => {
    const server = sdk().server.http
    const sessionID = input.sessionID()
    const working = input.working()
    const token = ++generation
    setState({ available: false, paused: false, waiting: false, pending: false })
    if (!sessionID) return
    let dead = false
    const poll = async () => {
      const observed = revision
      await requestSessionPause({ server, sessionID, fetch: platform.fetch })
        .then((result) => {
          if (dead || token !== generation || observed !== revision || state.pending) return
          if (!result) {
            setState("available", false)
            return
          }
          setState({ ...result, available: true })
        })
        .catch(() => {})
    }
    void poll()
    const timer = working ? setInterval(() => void poll(), 5_000) : undefined
    onCleanup(() => {
      dead = true
      if (timer) clearInterval(timer)
    })
  })

  return {
    get available() {
      return state.available
    },
    get paused() {
      return state.paused
    },
    get waiting() {
      return state.waiting
    },
    get pending() {
      return state.pending
    },
    get visible() {
      return state.available && (input.working() || state.paused)
    },
    async toggle() {
      const sessionID = input.sessionID()
      if (!sessionID || !state.available || state.pending) return
      const token = generation
      revision++
      setState("pending", true)
      await requestSessionPause({ server: sdk().server.http, sessionID, paused: !state.paused, fetch: platform.fetch })
        .then((result) => {
          if (token === generation && result) setState(result)
        })
        .catch(() => {
          if (token === generation) showToast({ title: language.t("common.requestFailed") })
        })
        .finally(() => {
          if (token === generation) setState("pending", false)
        })
    },
  }
}
