import { Server } from "@/server/server"
import { InstanceRuntime } from "@/project/instance-runtime"
import { Rpc } from "@/util/rpc"
import { upgrade } from "@/cli/upgrade"
import { Config } from "@/config/config"
import { GlobalBus } from "@/bus/global"
import { ServerAuth } from "@/server/auth"
import { Flag } from "@opencode-ai/core/flag/flag"
import { writeHeapSnapshot } from "node:v8"
import { Heap } from "@/cli/heap"
import { AppRuntime } from "@/effect/app-runtime"
import { Cause, Effect } from "effect"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { WebuiAutostart } from "@/cli/web-autostart"

Heap.start()

const onUnhandledRejection = (_error: unknown) => {}

const onUncaughtException = (_error: Error) => {}

process.on("unhandledRejection", onUnhandledRejection)
process.on("uncaughtException", onUncaughtException)

// Subscribe to global events and forward them via RPC
GlobalBus.on("event", (event) => {
  Rpc.emit("global.event", event)
})

let server: Awaited<ReturnType<typeof Server.listen>> | undefined

export const rpc = {
  async fetch(input: { url: string; method: string; headers: Record<string, string>; body?: string }) {
    const headers = { ...input.headers }
    const auth = ServerAuth.header()
    if (auth && !headers["authorization"] && !headers["Authorization"]) {
      headers["Authorization"] = auth
    }
    const request = new Request(input.url, {
      method: input.method,
      headers,
      body: input.body,
    })
    const response = await Server.Default().app.fetch(request)
    const body = await response.text()
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    }
  },
  snapshot() {
    const result = writeHeapSnapshot("server.heapsnapshot")
    return result
  },
  async server(input: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    if (server) await server.stop(true)
    server = await Server.listen(input)
    return { url: server.url.toString() }
  },
  // FE-024: bind the web-interface server when the Admin setting asks for it. The
  // TUI process owns the listener (same one the `--port` path uses), so this never
  // spawns a second process and `shutdown` stops it with the rest.
  async webuiAutoStart(input: { port: number; hostname: string }) {
    return AppRuntime.runPromise(
      Effect.gen(function* () {
        const cfg = yield* Config.Service
        const global = yield* cfg.getGlobal()
        // `server.port` is the value the Admin port row writes; an explicit --port
        // arrives as a non-zero `input.port` because `resolveNetworkOptionsNoConfig`
        // already applied it.
        const port = input.port || global.server?.port || WebuiAutostart.suggestedPort
        return yield* Effect.promise(() =>
          WebuiAutostart.autoStartWebServer({
            autoStart: global.server?.webui?.autoStart,
            alreadyListening: server !== undefined,
            port,
            hostname: global.server?.hostname ?? input.hostname,
            // Same source `ServerAuth.header()` reads, so "secured" here means the
            // same thing it means for the routes: a password in the environment.
            secured: !!Flag.OPENCODE_SERVER_PASSWORD,
            listen: async (options) => {
              server = await Server.listen(options)
              return { url: server.url, port: server.port }
            },
          }),
        ).pipe(
          // A failed bind must not take the TUI down with it: the admin setting is a
          // convenience, so report it and carry on without a listener.
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logError("[webui] auto-start failed", Cause.pretty(cause))
              return { started: false as const, reason: "disabled" as const }
            }),
          ),
        )
      }),
    )
  },
  async checkUpgrade(input: { directory: string }) {
    await InstanceRuntime.load({ directory: input.directory })
    await upgrade().catch(() => {})
  },
  async reload() {
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        const cfg = yield* Config.Service
        yield* cfg.invalidate()
        yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })
      }),
    )
  },
  async shutdown() {
    await InstanceRuntime.disposeAllInstances()
    if (server) await server.stop(true)
    process.off("unhandledRejection", onUnhandledRejection)
    process.off("uncaughtException", onUncaughtException)
  },
}

Rpc.listen(rpc)
