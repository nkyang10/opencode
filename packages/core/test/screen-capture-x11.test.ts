import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/core/process"
import { ScreenCaptureX11 } from "@opencode-ai/core/screen-capture/x11"
import { ScreenCaptureSelect } from "@opencode-ai/core/screen-capture/select"
import { CaptureError, type Input, type Window, type X11Backend } from "@opencode-ai/core/screen-capture/schema"
import { createPng } from "./fixture/png"

const backend = (capture: "import" | "xwd" = "import"): X11Backend => ({
  kind: "x11",
  display: ":99",
  capture,
  ...(capture === "xwd" ? { converter: "convert" } : {}),
  xrandr: true,
  xprop: true,
  xdotool: true,
})

const input = (overrides: Partial<Input> = {}): Input => ({
  action: "capture",
  target: "screen",
  display: "primary",
  restore_minimized: true,
  delay_ms: 0,
  ...overrides,
})

type Call = { readonly command: string; readonly args: readonly string[] }

const fakeProcess = (calls: Call[], respond: (command: string, args: readonly string[]) => Buffer) =>
  AppProcess.Service.of({
    run: (command: ChildProcess.Command) =>
      Effect.sync(() => {
        if (command._tag !== "StandardCommand") throw new Error("unexpected command tag " + command._tag)
        const args = command.args
        calls.push({ command: command.command, args })
        return processResult(command.command, args, respond(command.command, args))
      }),
  } as unknown as AppProcess.Interface)

function processResult(command: string, args: readonly string[], data: Buffer) {
  void args
  return {
    command,
    exitCode: 0,
    output: data,
    stdout: data,
    stderr: Buffer.alloc(0),
    outputTruncated: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  }
}

function stdout(command: string, args: readonly string[]) {
  if (command === "xrandr") return Buffer.from(RANDR)
  if (command === "xwininfo") return Buffer.from(TREE)
  if (command === "xprop") {
    if (args.includes("-root")) return Buffer.from("_NET_ACTIVE_WINDOW: window id: 0x0000b\n")
    const id = args[1]
    return Buffer.from(PROPS[id] ?? "_NET_WM_STATE: 0x0\n")
  }
  if (command === "import" || command === "xwd" || command === "convert" || command === "magick")
    return createPng(2, 1, [
    [255, 0, 0, 255],
    [0, 255, 0, 255],
  ])
  return Buffer.alloc(0)
}

const RANDR = `Screen 0: minimum 320 x 200, current 3120 x 1080, maximum 16384 x 16384
eDP-1 connected primary 1920x1080+0+0 (normal left inverted right x axis y axis) 309mm x 174mm
DP-1 connected 1200x800+1920+0 (normal left inverted right x axis y axis) 310mm x 180mm
`

const TREE = `xwininfo: Window id: 0x247 (the root window) (has no name)

  Absolute upper-left X:  0
  Absolute upper-left Y:  0
  Width: 1920
  Height: 1080
  Depth: 24
  Visual: VVisual id# 0x21
  Corner: NorthWest
  Window id: 0x247 (the root window) (has no name)
  Window mode: IsViewable
  Window gravity: NorthWest
  Window width (including borders): 1920
  Window height (including borders): 1080
  Window border width: 0
  Window corner: NorthWest
  WindowManager hint:
    Hint flags: USPosition
    Window gravity: NorthWest
    X, Y position: 0, 0

Tree for window 0x247:
  0x247: ("nautilus-desktop" "Nautilus-desktop")  1920x1080+0+0  +0+0
  0x00a: ("firefox" "Firefox")  1000x600+0+0  +0+0
  0x00b: ("gnome-terminal-server" "Gnome-terminal")  800x600+100+100  +100+100
`

const PROPS: Record<string, string> = {
  "0x00a": `WM_CLASS(STRING) = "firefox", "Firefox"
_NET_WM_STATE(ATOM) = _NET_WM_STATE_FOCUSED
_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_NORMAL
_NET_WM_PID(CARDINAL) = 111
_NET_WM_DESKTOP(CARDINAL) = 0
WM_NAME(STRING) = "Alpha Project - Mozilla Firefox"
`,
  "0x00b": `WM_CLASS(STRING) = "gnome-terminal-server", "Gnome-terminal"
_NET_WM_STATE(ATOM) =
_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_NORMAL
_NET_WM_PID(CARDINAL) = 222
_NET_WM_DESKTOP(CARDINAL) = 0
WM_NAME(STRING) = "Beta Project Terminal"
`,
}

describe("ScreenCapture X11 parsers", () => {
  test("parses connected displays and marks the first one primary when no primary is reported", () => {
    const displays = ScreenCaptureX11.parseDisplays(RANDR)
    expect(displays).toEqual([
      { index: 1, name: "eDP-1", primary: true, bounds: { width: 1920, height: 1080, x: 0, y: 0 } },
      { index: 2, name: "DP-1", primary: false, bounds: { width: 1200, height: 800, x: 1920, y: 0 } },
    ])

    const fallback = ScreenCaptureX11.parseDisplays("VGA-1 connected 1024x768+0+0\n")
    expect(fallback[0]).toMatchObject({ index: 1, name: "VGA-1", primary: true })
  })

  test("parses xwininfo tree window ids, titles, and bounds", () => {
    const windows = ScreenCaptureX11.parseWindows(TREE)
    expect(windows.map((window) => window.id)).toEqual(["0x247", "0x00a", "0x00b"])
    expect(windows[1]).toMatchObject({ id: "0x00a", title: "Firefox", bounds: { width: 1000, height: 600, x: 0, y: 0 } })
    expect(windows[2]).toMatchObject({ id: "0x00b", title: "Gnome-terminal", bounds: { width: 800, height: 600, x: 100, y: 100 } })
  })

  test("parses xprop metadata used for app names and minimized windows", () => {
    expect(ScreenCaptureX11.parseWindowProps("0x00a", PROPS["0x00a"]!)).toMatchObject({
      app: "Firefox",
      title: "Alpha Project - Mozilla Firefox",
      pid: 111,
      currentDesktop: true,
      windowType: "_NET_WM_WINDOW_TYPE_NORMAL",
    })
    expect(
      ScreenCaptureX11.parseWindowProps(
        "0xdead",
        `WM_CLASS(STRING) = "code", "Code"
_NET_WM_STATE(ATOM) = _NET_WM_STATE_HIDDEN, _NET_WM_STATE_FOCUSED
_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_NORMAL
_NET_WM_PID(CARDINAL) = 42
_NET_WM_DESKTOP(CARDINAL) = 0
WM_NAME(STRING) = "plan.md - workspace"
`,
      ),
    ).toMatchObject({ app: "Code", pid: 42, minimized: true, currentDesktop: true })
  })
})

describe("ScreenCapture select helpers", () => {
  test("prefers exact ids, then app names, then case-insensitive title substrings", () => {
    const windows: Window[] = [
      { id: "0x001", app: "firefox", title: "Alpha", minimized: false },
      { id: "0x002", app: "terminal", title: "Firefox Terminal", minimized: false },
      { id: "0x003", app: "Code", title: "code.md", minimized: false },
    ]

    expect(ScreenCaptureSelect.matchWindows(windows, "0x002").map((window) => window.id)).toEqual(["0x002"])
    expect(ScreenCaptureSelect.matchWindows(windows, "firefox").map((window) => window.id)).toEqual(["0x001"])
    expect(ScreenCaptureSelect.matchWindows(windows, "firefox").map((window) => window.id)).toEqual(["0x001"])
    expect(ScreenCaptureSelect.matchWindows(windows, "terminal").map((window) => window.id)).toEqual(["0x002"])
    expect(ScreenCaptureSelect.matchWindows(windows, "code").map((window) => window.id)).toEqual(["0x003"])
    expect(ScreenCaptureSelect.matchWindows(windows, "missing")).toEqual([])
  })

  test("frontmost selected match reports other matches and active id", () => {
    const windows: Window[] = [
      { id: "0x001", app: "firefox", title: "Alpha", minimized: false },
      { id: "0x002", app: "firefox", title: "Beta", minimized: false },
    ]
    const selected = ScreenCaptureSelect.selectWindow(windows, "firefox", "0x002")
    expect(selected.ok).toBe(true)
    if (!selected.ok) return
    expect(selected.match.selected.id).toBe("0x002")
    expect(selected.match.others.map((window) => window.id)).toEqual(["0x001"])
    expect(ScreenCaptureSelect.summarize(selected.match.others[0]!)).toBe('0x001 firefox "Alpha"')
  })
})

describe("ScreenCaptureX11 process integration", () => {
  test("lists displays and front-to-back windows with xprop metadata", async () => {
    const calls: Call[] = []
    const result = await Effect.runPromise(
      ScreenCaptureX11.list(fakeProcess(calls, stdout) as never, backend(), ":99"),
    )

    expect(result.displays.map((display) => display.name)).toEqual(["eDP-1", "DP-1"])
    expect(result.windows.map((window) => window.id)).toEqual(["0x00b", "0x247", "0x00a"])
    expect(result.windows[0]).toMatchObject({ app: "Gnome-terminal", pid: 222, title: "Beta Project Terminal", display: 1 })
    expect(result.windows[2]).toMatchObject({ app: "Firefox", pid: 111, title: "Alpha Project - Mozilla Firefox" })
    expect(result.text).toContain("0x00b  Gnome-terminal  pid 222")
    expect(calls.map((call) => call.command)).toEqual([
      "xrandr",
      "xwininfo",
      "xprop",
      "xprop",
      "xprop",
      "xprop",
    ])
    expect(calls[1]).toMatchObject({ command: "xwininfo", args: ["-root", "-tree", "-display", ":99"] })
  })

  test("captures the root window through ImageMagick import with display crop", async () => {
    const calls: Call[] = []
    const result = await Effect.runPromise(
      ScreenCaptureX11.capture(fakeProcess(calls, stdout) as never, backend(), ":99", input()),
    )

    expect(result).toMatchObject({
      mime: "image/png",
      width: 2,
      height: 1,
      target: "screen",
      display: 1,
      backend: "x11",
      platform: "linux",
    })
    const importCall = calls.find((call) => call.command === "import")
    expect(importCall?.args).toEqual([
      "-silent",
      "-window",
      "root",
      "-crop",
      "1920x1080+0+0",
      "+repage",
      "png:-",
    ])
  })

  test("falls back to xwd and ImageMagick when import is unavailable", async () => {
    const calls: Call[] = []
    const result = await Effect.runPromise(
      ScreenCaptureX11.capture(fakeProcess(calls, stdout) as never, backend("xwd"), ":99", input()),
    )

    expect(result.width).toBe(2)
    expect(calls.map((call) => call.command)).toContain("xwd")
    expect(calls.map((call) => call.command)).toContain("convert")
  })

  test("selects windows by id, app, and title substring", async () => {
    const cases = [
      { selector: "0x00a", id: "0x00a" },
      { selector: "Firefox", id: "0x00a" },
      { selector: "terminal", id: "0x00b" },
      { selector: "Alpha Project", id: "0x00a" },
    ] as const

    for (const testCase of cases) {
      const calls: Call[] = []
      const result = await Effect.runPromise(
        ScreenCaptureX11.capture(fakeProcess(calls, stdout) as never, backend(), ":99", input({ target: "window", window: testCase.selector })),
      )
      expect(result.window?.id).toBe(testCase.id)
      expect(calls.some((call) => call.command === "import" && call.args.includes(testCase.id))).toBe(true)
    }
  })

  test("fails window_not_found with candidate summaries when no window matches", async () => {
    const calls: Call[] = []
    const error = await Effect.runPromise(
      ScreenCaptureX11.capture(
        fakeProcess(calls, stdout) as never,
        backend(),
        ":99",
        input({ target: "window", window: "missing-app" }),
      ).pipe(Effect.catch((error) => Effect.succeed(error))),
    )
    expect(error).toBeInstanceOf(CaptureError)
    if (!(error instanceof CaptureError)) return
    expect(error.code).toBe("window_not_found")
    expect(error.candidates).toEqual([
      '0x247 "Nautilus-desktop"',
      "0x00a Firefox pid 111 \"Alpha Project - Mozilla Firefox\"",
      "0x00b Gnome-terminal pid 222 \"Beta Project Terminal\"",
    ])
  })

  test("reports other matches when a selector is ambiguous", async () => {
    const calls: Call[] = []
    const result = await Effect.runPromise(
      ScreenCaptureX11.capture(
        fakeProcess(calls, stdout) as never,
        backend(),
        ":99",
        input({ target: "window", window: "Project" }),
      ),
    )

    expect(result.window?.id).toBe("0x00b")
    expect(result.others).toEqual(['0x00a Firefox pid 111 "Alpha Project - Mozilla Firefox"'])
  })

  test("restores minimized windows, captures them, then re-minimizes them", async () => {
    const calls: Call[] = []
    const props: Record<string, string> = {
      ...PROPS,
      "0x00a": `WM_CLASS(STRING) = "firefox", "Firefox"
_NET_WM_STATE(ATOM) = _NET_WM_STATE_HIDDEN
_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_NORMAL
_NET_WM_PID(CARDINAL) = 111
_NET_WM_DESKTOP(CARDINAL) = 0
WM_NAME(STRING) = "Alpha Project - Mozilla Firefox"
`,
    }
    const result = await Effect.runPromise(
      ScreenCaptureX11.capture(
        AppProcess.Service.of({
          run: (command: ChildProcess.Command) =>
            Effect.sync(() => {
              if (command._tag !== "StandardCommand") throw new Error("unexpected command tag " + command._tag)
              calls.push({ command: command.command, args: command.args })
              if (command.command === "xprop") {
                const id = command.args[1]
                return processResult(command.command, command.args, Buffer.from(props[id] ?? "_NET_WM_STATE: 0x0\n"))
              }
              return processResult(command.command, command.args, stdout(command.command, command.args))
            }),
        } as unknown as AppProcess.Interface) as never,
        backend(),
        ":99",
        input({ target: "window", window: "0x00a" }),
      ),
    )

    expect(result.restored).toBe(true)
    expect(result.focusChanged).toBe(false)
    const restoreIndex = calls.findIndex((call) => call.command === "xdotool")
    const captureIndex = calls.findIndex((call) => call.command === "import")
    const minimizeIndex = calls.reduce((last, call, index) => (call.command === "xdotool" ? index : last), -1)
    expect(restoreIndex).toBeGreaterThanOrEqual(0)
    expect(captureIndex).toBeGreaterThan(restoreIndex)
    expect(minimizeIndex).toBeGreaterThan(captureIndex)
    expect(calls[restoreIndex]?.args).toEqual([
      "windowstate",
      "--remove",
      "_NET_WM_STATE_HIDDEN",
      "0x00a",
    ])
    expect(calls[minimizeIndex]?.args).toEqual(["windowminimize", "0x00a"])
  })

  test("does not restore minimized windows when restore_minimized is false", async () => {
    const calls: Call[] = []
    const error = await Effect.runPromise(
      ScreenCaptureX11.capture(
        AppProcess.Service.of({
          run: (command: ChildProcess.Command) =>
            Effect.sync(() => {
              if (command._tag !== "StandardCommand") throw new Error("unexpected command tag " + command._tag)
              calls.push({ command: command.command, args: command.args })
              if (command.command === "xprop") {
                const id = command.args[1]
                const text =
                  id === "0x00a"
                    ? `WM_CLASS(STRING) = "firefox", "Firefox"
_NET_WM_STATE(ATOM) = _NET_WM_STATE_HIDDEN
_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_NORMAL
_NET_WM_PID(CARDINAL) = 111
_NET_WM_DESKTOP(CARDINAL) = 0
WM_NAME(STRING) = "Alpha Project - Mozilla Firefox"
`
                    : ""
                return processResult(command.command, command.args, Buffer.from(text))
              }
              return processResult(command.command, command.args, stdout(command.command, command.args))
            }),
        } as unknown as AppProcess.Interface) as never,
        backend(),
        ":99",
        input({ target: "window", window: "0x00a", restore_minimized: false }),
      ).pipe(Effect.catch((error) => Effect.succeed(error))),
    )

    expect(error).toBeInstanceOf(CaptureError)
    if (!(error instanceof CaptureError)) return
    expect(error.code).toBe("window_not_capturable")
    expect(calls.some((call) => call.command === "xdotool")).toBe(false)
  })
})
