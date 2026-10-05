import { createSimpleContext } from "@opencode-ai/ui/context"
import { usePlatform } from "@/context/platform"
import { ServerConnection, useServer } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"
import { createEffect, createSignal, onCleanup } from "solid-js"
import { deadlineFrom, phaseAfterPoll, type LifecycleInfo, type Phase } from "./restart-state"

// The client half of the restart window (s100). The server says "I stop in N ms"
// once; everything after that happens locally — the countdown runs off this device's
// clock and survives the server dying, which is the entire point. A countdown that
// needs the server would end exactly when it matters.
//
// The hold covers more than the announced window: a poll failure means the daemon is
// unreachable, announced or not, and input is held for that too. The one exception is
// a 404 — an old server that can never announce a window must not hold input forever
// (see `phaseAfterPoll`).

const pollMs = 5_000
const timeoutMs = 4_000

function timeoutSignal(ms: number) {
  const signal = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout
  if (signal) return signal.call(AbortSignal, ms)
  const controller = new AbortController()
  setTimeout(() => controller.abort(), ms)
  return controller.signal
}

export const { use: useRestart, provider: RestartProvider } = createSimpleContext({
  name: "Restart",
  init: () => {
    const server = useServer()
    const platform = usePlatform()
    const fetcher = platform.fetch ?? globalThis.fetch

    const [phase, setPhase] = createSignal<Phase>("idle")
    const [deadlineLocal, setDeadlineLocal] = createSignal(0)
    const [remaining, setRemaining] = createSignal<number | null>(null)

    // The countdown is a local ticker against a locally-stamped deadline. It runs only
    // while it has a window to count, and never asks the server for the time.
    createEffect(() => {
      if (phase() !== "draining") return
      setRemaining(Math.max(0, deadlineLocal() - Date.now()))
      const id = setInterval(() => setRemaining(Math.max(0, deadlineLocal() - Date.now())), 250)
      onCleanup(() => clearInterval(id))
    })

    createEffect(() => {
      const conn = server.current
      if (!conn) return
      const http: ServerConnection.HttpBase = conn.http
      let dead = false

      const poll = async () => {
        const headers: Record<string, string> = {}
        if (http.password) {
          headers.Authorization = `Basic ${authTokenFromCredentials({
            username: http.username,
            password: http.password,
          })}`
        }
        try {
          const res = await fetcher(`${http.url.replace(/\/+$/, "")}/global/lifecycle`, {
            headers,
            signal: timeoutSignal(timeoutMs),
          })
          if (dead) return
          let info: LifecycleInfo | undefined
          if (res.ok) info = await res.json()
          setPhase(phaseAfterPoll(phase(), { ok: true, status: res.status, info }))
          if (res.ok && info?.draining) {
            setDeadlineLocal(deadlineFrom(Date.now(), info.remainingMs))
            setRemaining(Math.max(0, deadlineLocal() - Date.now()))
          }
        } catch {
          if (!dead) setPhase("reconnecting")
        }
      }

      void poll()
      const id = setInterval(() => void poll(), pollMs)
      onCleanup(() => {
        dead = true
        clearInterval(id)
      })
    })

    return {
      phase,
      /** Seconds left in the window, or null when there is nothing to count. */
      remaining,
      /** True while input should be held: an announced window or an unreachable server. */
      blocking: (): boolean => phase() !== "idle",
    }
  },
})