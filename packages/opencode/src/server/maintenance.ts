export * as ServerMaintenance from "./maintenance"

import { ServerLifecycle } from "./lifecycle"

let restart: ((active: () => Promise<number>) => Promise<void>) | undefined
let pending = false

/** Known process managers must retain ownership of process replacement. */
export function standalone(env: NodeJS.ProcessEnv = process.env) {
  return !env.INVOCATION_ID && env.pm_id === undefined && env.SUPERVISOR_ENABLED !== "1"
}

/** Only a standalone CLI host opts in; a sidecar/TUI must not exit its owning application. */
export function install(handler: (active: () => Promise<number>) => Promise<void>) {
  restart = handler
  return () => {
    if (restart === handler) restart = undefined
  }
}

export function info() {
  return { restartSupported: !!restart, restarting: pending }
}

export function request(active: () => Promise<number>) {
  const handler = restart
  if (!handler) return false
  if (pending) return true
  pending = true
  ServerLifecycle.arm(60_000, "maintenance")
  // Let the acceptance response reach the client before touching its listener.
  setTimeout(() => {
    void handler(active)
      .catch((error: unknown) => {
        process.stderr.write(
          `[maintenance] restart failed: ${error instanceof Error ? error.message : String(error)}\n`,
        )
      })
      .finally(() => {
        pending = false
        ServerLifecycle.disarm()
      })
  }, 250)
  return true
}

/** Preserve the launch command, pinning an ephemeral listen port to the current URL. */
export function argumentsForRestart(argv: string[], compiled: boolean, port: number) {
  const args = argv.slice(compiled ? 2 : 1)
  const cleaned = args.filter(
    (arg, index) => arg !== "--port" && !arg.startsWith("--port=") && args[index - 1] !== "--port",
  )
  return [...cleaned, "--port", String(port)]
}
