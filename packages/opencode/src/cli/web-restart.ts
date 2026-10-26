export * as WebRestart from "./web-restart"

import { spawn } from "node:child_process"
import type { Server } from "@/server/server"
import { ServerMaintenance } from "@/server/maintenance"
import { ServerLifecycle } from "@/server/lifecycle"
import { ServerSuccessor } from "@/server/successor"

/** How long a restarted server gets to answer before the predecessor decides the restart failed. */
const SuccessorTimeoutMs = 30_000

/**
 * The `web` command owns its own process, so it is the only host that arranges a replacement when it
 * drains. The note is written to stderr because a `systemd`-managed or `nohup`-ed server has no
 * terminal: before this existed, the only trace of a deploy that left the port dead was the absence of
 * a server.
 */
export function installSuccessor() {
  return ServerLifecycle.installSuccessor(() => {
    const result = ServerSuccessor.handoff()
    process.stderr.write(`[webui] ${result.note}\n`)
  })
}

/** The standalone CLI entrypoint owns process replacement, not an HTTP handler or browser. */
export function install(
  initial: Awaited<ReturnType<typeof Server.listen>>,
  options: Parameters<typeof Server.listen>[0],
) {
  if (!ServerMaintenance.restartable()) return () => {}
  let listener = initial
  return ServerMaintenance.install(async (active) => {
    while (ServerLifecycle.remainingMs() > 0 && (await active()) > 0)
      await new Promise((resolve) => setTimeout(resolve, 250))
    await listener.stop(true)
    const unit = ServerSuccessor.unit()
    if (unit) {
      // A unit must restart itself through its service manager. Spawning a child here would be killed
      // with this process (`KillMode=control-group`), which is what made self-restart look broken on a
      // systemd host, and the queued job cannot be waited on: its start phase waits for this exit.
      if (!ServerSuccessor.queue(unit)) {
        listener = await relisten(options, listener.port)
        throw new Error(`Could not ask systemd to restart ${unit}; listener restored`)
      }
      process.stderr.write(`[webui] restart queued for ${unit}; exiting so the job can start the new server\n`)
      process.exit(0)
    }
    const child = spawn(
      process.execPath,
      ServerMaintenance.argumentsForRestart(process.argv, Bun.main.startsWith("/$bunfs/"), listener.port),
      {
        cwd: process.cwd(),
        env: { ...process.env, OPENCODE_MAINTENANCE_RESTART: "1" },
        stdio: "inherit",
        detached: true,
      },
    )
    const started = await new Promise<boolean>((resolve) => {
      child.once("spawn", () => resolve(true))
      child.once("error", () => resolve(false))
    })
    if (!started) {
      listener = await relisten(options, listener.port)
      throw new Error("Could not start the replacement server; listener restored")
    }
    child.unref()
    // A spawned child that exits immediately is still "spawned", so this is the only check that
    // distinguishes a restart from a bad binary. The predecessor holds nothing after `stop(true)`, but
    // it must not walk away from a port nobody is serving: on timeout it takes the port back.
    if (!(await ServerSuccessor.listening(listener.port, listener.hostname, SuccessorTimeoutMs))) {
      child.kill("SIGKILL")
      listener = await relisten(options, listener.port)
      throw new Error(`Replacement server never answered on port ${listener.port}; listener restored`)
    }
    process.exit(0)
  })
}

/** The server module is heavy and only needed when a restart failed, so it stays a dynamic import. */
async function relisten(options: Parameters<typeof Server.listen>[0], port: number) {
  const { Server } = await import("@/server/server")
  return Server.listen({ ...options, port })
}
