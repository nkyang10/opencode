export * as ScreenCapture from "./index"

import { Context, Duration, Effect, Layer, Option, Semaphore } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { AppProcess } from "../process"
import { ScreenCaptureDetect } from "./detect"
import { CaptureError, type CaptureResult, type Input, type ListResult } from "./schema"
import { ScreenCaptureX11 } from "./x11"

export interface Interface {
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
      if (process.platform !== "linux")
        return yield* new CaptureError({
          code: "unsupported",
          reason: `screenshot capture is not implemented on ${process.platform} yet`,
        })
      const option = ScreenCaptureDetect.detect({ x_display: input.x_display })
      if (Option.isNone(option)) return yield* noDisplay(input)
      return option.value
    })

    const list = Effect.fn("ScreenCapture.list")(function* (input: Pick<Input, "x_display">) {
      const selected = yield* backend(input)
      return yield* mutex.withPermit(ScreenCaptureX11.list(app, selected, selected.display))
    })

    const capture = Effect.fn("ScreenCapture.capture")(function* (input: Input) {
      if (input.delay_ms) yield* Effect.sleep(Duration.millis(input.delay_ms))
      const selected = yield* backend(input)
      return yield* mutex.withPermit(ScreenCaptureX11.capture(app, selected, selected.display, input))
    })

    return Service.of({ list, capture })
  }),
)

function noDisplay(input: Pick<Input, "x_display">): CaptureError {
  return new CaptureError({
    code: "no_display",
    reason:
      `No X11 display was detected${input.x_display ? ` for DISPLAY=${input.x_display}` : ""}. ` +
      "Start an X server, set DISPLAY, pass x_display, or install xwininfo plus import or xwd/convert.",
  })
}

export const node = makeGlobalNode({ service: Service, layer, deps: [AppProcess.node] })
