import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { webuiChildEnv, webuiCommandPath } from "./webui-autostart"

describe("web ui auto-start", () => {
  test("resolves the portable CLI the installer ships", () => {
    // Packaged: the app's own resources directory, where build-windows-installer.ps1 puts the embedded CLI.
    expect(webuiCommandPath({ isPackaged: true, resourcesPath: "C:/app/resources", platform: "win32" })).toBe(
      join("C:/app/resources", "opencode.exe"),
    )
    expect(webuiCommandPath({ isPackaged: true, resourcesPath: "/app/resources", platform: "linux" })).toBe(
      "/app/resources/opencode",
    )
    // Unpackaged: the same lookup background-cli.ts does from out/main.
    expect(webuiCommandPath({ isPackaged: false, resourcesPath: "", platform: "darwin", dir: "/repo/out/main" })).toBe(
      "/repo/resources/opencode",
    )
  })

  test("removes the desktop-only variables the child must not inherit", () => {
    // OPENCODE_DISABLE_EMBEDDED_WEB_UI would make the child answer / with a 404 instead of the web UI.
    const child = webuiChildEnv({
      OPENCODE_DISABLE_EMBEDDED_WEB_UI: "true",
      OPENCODE_CLIENT: "desktop",
      OPENCODE_SERVER_PASSWORD: "secret",
      XDG_STATE_HOME: "/state",
      PATH: "/bin",
    })
    expect(child.OPENCODE_DISABLE_EMBEDDED_WEB_UI).toBeUndefined()
    expect(child.OPENCODE_CLIENT).toBeUndefined()
    // The password the user authenticates with, and the state directory that keeps the phone and the desktop
    // window on the same sessions, are inherited on purpose.
    expect(child.OPENCODE_SERVER_PASSWORD).toBe("secret")
    expect(child.XDG_STATE_HOME).toBe("/state")
    expect(child.PATH).toBe("/bin")
  })

  test("does not mutate the environment it was given", () => {
    const env = { OPENCODE_DISABLE_EMBEDDED_WEB_UI: "true" }
    webuiChildEnv(env)
    expect(env.OPENCODE_DISABLE_EMBEDDED_WEB_UI).toBe("true")
  })
})
