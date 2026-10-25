export * as WebRestart from "./web-restart"

import { spawn } from "node:child_process"
import type { Server } from "@/server/server"
import { ServerMaintenance } from "@/server/maintenance"
import { ServerLifecycle } from "@/server/lifecycle"

/** The standalone CLI entrypoint owns process replacement, not an HTTP handler or browser. */
export function install(
  initial: Awaited<ReturnType<typeof Server.listen>>,
  options: Parameters<typeof Server.listen>[0],
) {
  if (!ServerMaintenance.standalone()) return () => {}
  let listener = initial
  return ServerMaintenance.install(async (active) => {
    while (ServerLifecycle.remainingMs() > 0 && (await active()) > 0)
      await new Promise((resolve) => setTimeout(resolve, 250))
    await listener.stop(true)
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
      const { Server } = await import("@/server/server")
      listener = await Server.listen({ ...options, port: listener.port })
      throw new Error("Could not start the replacement server; listener restored")
    }
    child.unref()
    process.exit(0)
  })
}
