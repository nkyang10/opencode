export * as ScreenCaptureDetect from "./detect"

import { Option } from "effect"
import type { Backend, WindowsBackend, X11Backend } from "./schema"
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

export function detect(
  input: { x_display?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
  lookup: typeof which = which,
): Option.Option<Backend> {
  const platform = input.platform ?? process.platform
  if (platform !== "linux" && platform !== "win32") return Option.none()
  const env = { ...(input.env ?? process.env), ...(input.x_display ? { DISPLAY: input.x_display } : {}) }
  const x11 = detectX11(env, lookup)
  const windows = platform === "win32" ? detectWindows(env, lookup) : detectWsl(env, lookup)
  if (input.x_display && Option.isSome(x11)) return x11
  return Option.isSome(windows) ? windows : x11
}

function isWsl(env: NodeJS.ProcessEnv) {
  return Boolean(env.WSL_DISTRO_NAME?.trim() || env.WSL_INTEROP?.trim())
}
