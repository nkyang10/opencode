export * as ScreenCaptureDetect from "./detect"

import { Option } from "effect"
import type { Backend, MacOSBackend, WaylandBackend, WindowsBackend, X11Backend } from "./schema"
import { which } from "../util/which"

export function detectX11(env: NodeJS.ProcessEnv = process.env, lookup: typeof which = which): Option.Option<X11Backend> {
  const display = env.DISPLAY?.trim()
  if (!display) return Option.none()
  if (!lookup("xwininfo", env)) return Option.none()

  const importPath = lookup("import", env)
  if (importPath)
    return Option.some({
      kind: "x11",
      display,
      capture: "import",
      xrandr: !!lookup("xrandr", env),
      xprop: !!lookup("xprop", env),
      xdotool: !!lookup("xdotool", env),
    })

  const converter = lookup("convert", env) ? "convert" : lookup("magick", env) ? "magick" : undefined
  if (lookup("xwd", env) && converter)
    return Option.some({
      kind: "x11",
      display,
      capture: "xwd",
      converter,
      xrandr: !!lookup("xrandr", env),
      xprop: !!lookup("xprop", env),
      xdotool: !!lookup("xdotool", env),
    })

  return Option.none()
}

export function detectWindows(
  env: NodeJS.ProcessEnv = process.env,
  lookup: typeof which = which,
): Option.Option<WindowsBackend> {
  const program = lookup("powershell.exe", env)
  if (!program) return Option.none()
  return Option.some({ kind: "windows", transport: "native", program })
}

export function detectWsl(
  env: NodeJS.ProcessEnv = process.env,
  lookup: typeof which = which,
): Option.Option<WindowsBackend> {
  if (!isWsl(env)) return Option.none()
  const program = lookup("powershell.exe", env)
  const wslpath = lookup("wslpath", env)
  if (!program || !wslpath) return Option.none()
  return Option.some({ kind: "windows", transport: "wsl", program, wslpath })
}

export function detectWayland(
  env: NodeJS.ProcessEnv = process.env,
  lookup: typeof which = which,
): Option.Option<WaylandBackend> {
  if (!isWaylandSession(env)) return Option.none()
  const program = lookup("grim", env)
  if (!program) return Option.none()

  const display = env.WAYLAND_DISPLAY?.trim() || "wayland-0"
  const swaymsg = lookup("swaymsg", env)
  if (swaymsg && isSway(env)) return Option.some({ kind: "wayland", compositor: "sway", program, lister: swaymsg, display })

  const hyprctl = lookup("hyprctl", env)
  if (hyprctl && isHyprland(env))
    return Option.some({ kind: "wayland", compositor: "hyprland", program, lister: hyprctl, display })

  return Option.none()
}

export function detectMacOS(
  _env: NodeJS.ProcessEnv = process.env,
  lookup: typeof which = which,
): Option.Option<MacOSBackend> {
  const osascript = lookup("osascript", _env)
  const screencapture = lookup("screencapture", _env)
  if (!osascript || !screencapture) return Option.none()
  return Option.some({ kind: "macos", osascript, screencapture })
}

export function detect(
  input: { x_display?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
  lookup: typeof which = which,
): Option.Option<Backend> {
  const platform = input.platform ?? process.platform
  if (platform === "darwin") return detectMacOS(input.env, lookup)
  if (platform !== "linux" && platform !== "win32") return Option.none()
  const env = { ...(input.env ?? process.env), ...(input.x_display ? { DISPLAY: input.x_display } : {}) }
  const x11 = detectX11(env, lookup)
  const windows = platform === "win32" ? detectWindows(env, lookup) : detectWsl(env, lookup)
  const wayland = detectWayland(env, lookup)
  if (input.x_display && Option.isSome(x11)) return x11
  if (Option.isSome(windows)) return windows
  if (isWaylandSession(env) && Option.isSome(wayland)) return wayland
  return x11
}

function isWsl(env: NodeJS.ProcessEnv) {
  return Boolean(env.WSL_DISTRO_NAME?.trim() || env.WSL_INTEROP?.trim())
}

function isWaylandSession(env: NodeJS.ProcessEnv) {
  return Boolean(env.WAYLAND_DISPLAY?.trim() || env.XDG_SESSION_TYPE?.trim().toLowerCase() === "wayland")
}

function desktops(env: NodeJS.ProcessEnv) {
  return (env.XDG_CURRENT_DESKTOP ?? "").toLowerCase()
}

function isSway(env: NodeJS.ProcessEnv) {
  return Boolean(env.SWAYSOCK?.trim() || desktops(env).includes("sway"))
}

function isHyprland(env: NodeJS.ProcessEnv) {
  return Boolean(env.HYPRLAND_INSTANCE_SIGNATURE?.trim() || desktops(env).includes("hyprland"))
}
