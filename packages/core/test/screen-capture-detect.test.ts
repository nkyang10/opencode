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

  test("detects macOS through osascript and screencapture", () => {
    expect(
      Option.getOrNull(
        ScreenCaptureDetect.detect(
          { platform: "darwin", env: {} },
          lookup({
            osascript: "/usr/bin/osascript",
            screencapture: "/usr/sbin/screencapture",
          }),
        ),
      ),
    ).toEqual({
      kind: "macos",
      osascript: "/usr/bin/osascript",
      screencapture: "/usr/sbin/screencapture",
    })
  })

  test("does not detect macOS without screencapture", () => {
    expect(
      Option.isNone(
        ScreenCaptureDetect.detect(
          { platform: "darwin", env: {} },
          lookup({ osascript: "/usr/bin/osascript" }),
        ),
      ),
    ).toBe(true)
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

  test("detects Sway Wayland through grim and swaymsg", () => {
    expect(
      Option.getOrNull(
        ScreenCaptureDetect.detectWayland(
          { WAYLAND_DISPLAY: "wayland-1", SWAYSOCK: "/run/user/1000/sway-ipc.1000.1.sock" },
          lookup({ grim: "/usr/bin/grim", swaymsg: "/usr/bin/swaymsg" }),
        ),
      ),
    ).toEqual({
      kind: "wayland",
      compositor: "sway",
      program: "/usr/bin/grim",
      lister: "/usr/bin/swaymsg",
      display: "wayland-1",
    })
  })

  test("prefers Wayland over X11 on a Wayland session", () => {
    expect(
      Option.getOrNull(
        ScreenCaptureDetect.detect({
          platform: "linux",
          env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0", XDG_SESSION_TYPE: "wayland", SWAYSOCK: "/tmp/sway.sock" },
        }, lookup({
          xwininfo: "/usr/bin/xwininfo",
          import: "/usr/bin/import",
          grim: "/usr/bin/grim",
          swaymsg: "/usr/bin/swaymsg",
        })),
      ),
    ).toEqual({
      kind: "wayland",
      compositor: "sway",
      program: "/usr/bin/grim",
      lister: "/usr/bin/swaymsg",
      display: "wayland-0",
    })
  })

  test("honors an explicit x_display over Wayland", () => {
    expect(
      Option.getOrNull(
        ScreenCaptureDetect.detect({
          platform: "linux",
          env: { WAYLAND_DISPLAY: "wayland-0", XDG_SESSION_TYPE: "wayland", HYPRLAND_INSTANCE_SIGNATURE: "abc" },
          x_display: ":99",
        }, lookup({
          xwininfo: "/usr/bin/xwininfo",
          import: "/usr/bin/import",
          grim: "/usr/bin/grim",
          hyprctl: "/usr/bin/hyprctl",
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

  test("prefers WSL over Wayland", () => {
    expect(
      Option.getOrNull(
        ScreenCaptureDetect.detect({
          platform: "linux",
          env: { WAYLAND_DISPLAY: "wayland-0", WSL_DISTRO_NAME: "Ubuntu", SWAYSOCK: "/tmp/sway.sock" },
        }, lookup({
          "powershell.exe": "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
          wslpath: "/usr/bin/wslpath",
          grim: "/usr/bin/grim",
          swaymsg: "/usr/bin/swaymsg",
        })),
      ),
    ).toEqual({
      kind: "windows",
      transport: "wsl",
      program: "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
      wslpath: "/usr/bin/wslpath",
    })
  })

  test("does not detect Wayland without a supported compositor", () => {
    expect(
      Option.isNone(
        ScreenCaptureDetect.detectWayland({ WAYLAND_DISPLAY: "wayland-0" }, lookup({ grim: "/usr/bin/grim" })),
      ),
    ).toBe(true)
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
