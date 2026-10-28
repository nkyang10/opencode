export * as ScreenCaptureWsl from "./wsl"

import { Effect } from "effect"
import { AppProcess } from "../process"
import { type CaptureError, type CaptureResult, type Input, type ListResult, type WindowsBackend } from "./schema"
import { ScreenCaptureWindows } from "./windows"

export function list(process: AppProcess.Interface, backend: WindowsBackend): Effect.Effect<ListResult, CaptureError> {
  return ScreenCaptureWindows.list(process, backend)
}

export function capture(
  process: AppProcess.Interface,
  backend: WindowsBackend,
  input: Input,
): Effect.Effect<CaptureResult, CaptureError> {
  return ScreenCaptureWindows.capture(process, backend, input)
}
