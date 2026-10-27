export * as ScreenCapture from "./index"

import { Context, Duration, Effect, Layer, Option, Semaphore } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { AppProcess } from "../process"
import { ScreenCaptureDetect } from "./detect"
import { CaptureError, type CaptureResult, type Input, type ListResult } from "./schema"
import { ScreenCaptureWindows } from "./windows"
import { ScreenCaptureWsl } from "./wsl"
import { ScreenCaptureX11 } from "./x11"

export interface Interface {
  readonly available: () => Effect.Effect<boolean>
  readonly list: (input: Pick<Input, "x_display">) => Effect.Effect<ListResult, CaptureError>
  readonly capture: (input: Input) => Effect.Effect<CaptureResult, CaptureError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ScreenCapture") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const app = yield* AppProcess.Service
    const mutex = Semaphore.makeUnsafe(1)

    const backend = Effect.fn("ScreenCapture.backend")(function* (input: Pick<Input, "x_display">) {
      if (process.platform !== "linux" && process.platform !== "win32")
        return yield* new CaptureError({
          code: "unsupported",
          reason: `screenshot capture is not implemented on ${process.platform} yet`,
        })
      const option = ScreenCaptureDetect.detect({ x_display: input.x_display })
      if (Option.isNone(option)) return yield* noBackend(input)
      return option.value
    })

    const available = Effect.fn("ScreenCapture.available")(function* () {
      return Option.isSome(ScreenCaptureDetect.detect())
    })

    const list = Effect.fn("ScreenCapture.list")(function* (input: Pick<Input, "x_display">) {
      const selected = yield* backend(input)
      return yield* mutex.withPermit(
        selected.kind === "windows" && selected.transport === "wsl"
          ? ScreenCaptureWsl.list(app, selected)
          : selected.kind === "windows"
            ? ScreenCaptureWindows.list(app, selected)
            : ScreenCaptureX11.list(app, selected, selected.display),
      )
    })

    const capture = Effect.fn("ScreenCapture.capture")(function* (input: Input) {
      if (input.delay_ms) yield* Effect.sleep(Duration.millis(input.delay_ms))
      const selected = yield* backend(input)
      return yield* mutex.withPermit(
        selected.kind === "windows" && selected.transport === "wsl"
          ? ScreenCaptureWsl.capture(app, selected, input)
          : selected.kind === "windows"
            ? ScreenCaptureWindows.capture(app, selected, input)
            : ScreenCaptureX11.capture(app, selected, selected.display, input),
      )
    })

    return Service.of({ available, list, capture })
  }),
)

function noBackend(input: Pick<Input, "x_display">): CaptureError {
  if (process.platform === "win32")
    return new CaptureError({
      code: "missing_dependency",
      reason: "Windows screenshot capture requires Windows PowerShell (powershell.exe) and an interactive desktop session.",
    })
  return new CaptureError({
    code: "no_display",
    reason:
      `No screenshot backend was detected${input.x_display ? ` for DISPLAY=${input.x_display}` : ""}. ` +
      "Linux needs an X server plus xwininfo and import or xwd/convert; WSL needs powershell.exe and wslpath.",
  })
}

export const node = makeGlobalNode({ service: Service, layer, deps: [AppProcess.node] })
