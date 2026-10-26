export * as ServerMaintenance from "./maintenance"

import { ServerLifecycle } from "./lifecycle"
import { ServerSuccessor } from "./successor"

let restart: ((active: () => Promise<number>) => Promise<void>) | undefined
let pending = false

/** Known process managers must retain ownership of process replacement. */
export function standalone(env: NodeJS.ProcessEnv = process.env) {
  return !env.INVOCATION_ID && env.pm_id === undefined && env.SUPERVISOR_ENABLED !== "1"
}

/**
 * A systemd user service is supervised, so `standalone()` is false for it (`INVOCATION_ID` is set) —
 * but it can still be restarted, through the unit rather than by spawning a child. Reporting
 * `restartSupported: false` there would mean the deployed fork could never restart from the Admin tab,
 * which is exactly where an operator asks for it.
 */
export function restartable(
  env: NodeJS.ProcessEnv = process.env,
  // A detection callback rather than a string: an explicit `undefined` argument is indistinguishable
  // from an absent one in JS, and "detected nothing" has to be expressible by a test.
  findUnit: () => string | undefined = ServerSuccessor.unit,
) {
  return standalone(env) || findUnit() !== undefined
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
