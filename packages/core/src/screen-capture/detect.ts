export * as ScreenCaptureDetect from "./detect"

import { Option } from "effect"
import type { Backend } from "./schema"
import { which } from "../util/which"

export function detectX11(env: NodeJS.ProcessEnv = process.env, lookup: typeof which = which): Option.Option<Backend> {
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

export function detect(
  input: { x_display?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
  lookup: typeof which = which,
): Option.Option<Backend> {
  const platform = input.platform ?? process.platform
  if (platform !== "linux") return Option.none()
  const env = { ...(input.env ?? process.env), ...(input.x_display ? { DISPLAY: input.x_display } : {}) }
  return detectX11(env, lookup)
}
