// FE-026: the desktop app starts the web interface alongside itself, so the same UI the window shows is
// reachable from a browser — including a phone on the LAN — without launching a terminal.
//
// The installer already ships a portable `opencode.exe` **with** the web UI embedded
// (`script/build-windows-installer.ps1` puts it in the app's `resources/`, and that is the binary
// `launch-web.cmd` runs). So this module does not build anything, embed anything, or read the config: it
// spawns that binary with `web --autostart` and the **CLI** applies the auto-start policy
// (`packages/opencode/src/cli/web-autostart.ts`, already unit-tested). The Electron process only owns a
// path and a lifetime. Keeping the decision in the CLI is deliberate: reading `opencode.json(c)` here would
// mean reimplementing the config file order and JSONC parsing, and then drifting from it.
//
// Two environment details are the whole reason this file exists:
//
// - `OPENCODE_DISABLE_EMBEDDED_WEB_UI` is set by the desktop main process (`index.ts`) because Electron
//   serves its own renderer. A child process inherits it, so the child would answer `/` with a 404. It must
//   be removed for the child, or there is no page to show.
// - `OPENCODE_CLIENT=desktop` marks the renderer; the child should behave like a terminal run.
//
// `XDG_STATE_HOME` is deliberately **kept**, so both processes share one database and the phone shows the
// sessions the desktop window shows. `OPENCODE_SERVER_PASSWORD` is inherited untouched: that is the password
// the user authenticates with (ide s080 decision), and its absence is what makes the CLI fall back to
// loopback instead of exposing an unauthenticated agent to the network.

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { MainLogger } from "electron-log"

const mainDir = dirname(fileURLToPath(import.meta.url))

export type WebuiAutostartHandle = { stop: () => Promise<void> }

export type WebuiAutostartContext = {
  isPackaged: boolean
  resourcesPath: string
  platform: NodeJS.Platform
}

/** The portable CLI that ships next to the app; the same lookup `background-cli.ts` already does. */
export function webuiCommandPath(input: WebuiAutostartContext & { dir?: string }) {
  const name = input.platform === "win32" ? "opencode.exe" : "opencode"
  return input.isPackaged
    ? join(input.resourcesPath, name)
    : join(input.dir ?? mainDir, "../../resources", name)
}

/** The child's environment: desktop-only variables removed, everything else inherited. */
export function webuiChildEnv(env: Record<string, string | undefined>) {
  const child = { ...env }
  delete child.OPENCODE_DISABLE_EMBEDDED_WEB_UI
  delete child.OPENCODE_CLIENT
  return child
}

export async function startWebuiAutostart(
  logger: MainLogger,
  context: WebuiAutostartContext,
): Promise<WebuiAutostartHandle | undefined> {
  const exe = webuiCommandPath(context)
  if (!existsSync(exe)) {
    // A missing portable CLI is a packaging problem, not a reason to fail the app. Say where it was looked
    // for, so the report is actionable instead of mysterious.
    logger.warn("web ui auto-start skipped: portable CLI not found", { exe })
    return undefined
  }

  logger.log("starting web ui auto-start", { exe })
  const child = spawn(exe, ["web", "--autostart"], {
    env: webuiChildEnv(process.env),
    stdio: "pipe",
  })
  child.stdout?.on("data", (chunk: Buffer) => logger.log("web ui", { stdout: chunk.toString("utf8").trimEnd() }))
  child.stderr?.on("data", (chunk: Buffer) =>
    logger.warn("web ui", { stderr: chunk.toString("utf8").trimEnd() }),
  )
  // The child runs until the app quits, so an exit that early is a failure to report, not routine cleanup.
  let expected = false
  child.on("error", (error) => logger.error("web ui auto-start failed to spawn", { error: error.message }))
  child.on("exit", (code, signal) => {
    if (expected) return
    logger.warn("web ui auto-start exited early", { code, signal })
  })

  return {
    stop: async () => {
      expected = true
      if (child.exitCode !== null || child.signalCode !== null) return
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve())
        child.kill()
      })
    },
  }
}
