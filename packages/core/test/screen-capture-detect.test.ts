import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { ScreenCaptureDetect } from "@opencode-ai/core/screen-capture/detect"
import type { which } from "@opencode-ai/core/util/which"

const lookup = (files: Record<string, string>) => ((command: string) => files[command] ?? null) as typeof which

describe("ScreenCaptureDetect", () => {
  test("detects Windows through powershell.exe", () => {
    expect(
      Option.getOrNull(
        ScreenCaptureDetect.detect({
          platform: "win32",
          env: {},
        }, lookup({ "powershell.exe": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" })),
      ),
    ).toEqual({
      kind: "windows",
      transport: "native",
      program: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    })
  })

  test("prefers WSL PowerShell over an available X11 display", () => {
    expect(
      Option.getOrNull(
        ScreenCaptureDetect.detect({
          platform: "linux",
          env: { DISPLAY: ":0", WSL_DISTRO_NAME: "Ubuntu" },
        }, lookup({
          xwininfo: "/usr/bin/xwininfo",
          import: "/usr/bin/import",
          "powershell.exe": "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
          wslpath: "/usr/bin/wslpath",
        })),
      ),
    ).toEqual({
      kind: "windows",
      transport: "wsl",
      program: "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
      wslpath: "/usr/bin/wslpath",
    })
  })

  test("honors an explicit x_display on WSL", () => {
    expect(
      Option.getOrNull(
        ScreenCaptureDetect.detect({
          platform: "linux",
          env: { WSL_DISTRO_NAME: "Ubuntu" },
          x_display: ":99",
        }, lookup({
          xwininfo: "/usr/bin/xwininfo",
          import: "/usr/bin/import",
          "powershell.exe": "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
          wslpath: "/usr/bin/wslpath",
        })),
      ),
    ).toEqual({
      kind: "x11",
      display: ":99",
      capture: "import",
      xrandr: false,
      xprop: false,
      xdotool: false,
    })
  })

  test("keeps native Linux on X11 when WSL tools are absent", () => {
    expect(
      Option.getOrNull(
        ScreenCaptureDetect.detect({ platform: "linux", env: { DISPLAY: ":99" } }, lookup({
          xwininfo: "/usr/bin/xwininfo",
          import: "/usr/bin/import",
        })),
      ),
    ).toEqual({
      kind: "x11",
      display: ":99",
      capture: "import",
      xrandr: false,
      xprop: false,
      xdotool: false,
    })
  })
})
