import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/core/process"
import { CaptureError, type Input, type WaylandBackend } from "@opencode-ai/core/screen-capture/schema"
import { ScreenCaptureWayland } from "@opencode-ai/core/screen-capture/wayland"
import { createPng } from "./fixture/png"

const GRIM = "/usr/bin/grim"
const SWAYMSG = "/usr/bin/swaymsg"
const HYPRCTL = "/usr/bin/hyprctl"

const swayBackend = (): WaylandBackend => ({
  kind: "wayland",
  compositor: "sway",
  program: GRIM,
  lister: SWAYMSG,
  display: "wayland-1",
})

const hyprlandBackend = (): WaylandBackend => ({
  kind: "wayland",
  compositor: "hyprland",
  program: GRIM,
  lister: HYPRCTL,
  display: "wayland-0",
})

const input = (overrides: Partial<Input> = {}): Input => ({
  action: "capture",
  target: "screen",
  display: "primary",
  restore_minimized: true,
  delay_ms: 0,
  ...overrides,
})

const PNG = createPng(2, 1, [
  [255, 0, 0, 255],
  [0, 255, 0, 255],
])

const SWAY_OUTPUTS = [
  { name: "eDP-1", primary: true, active: true, rect: { x: 0, y: 0, width: 1920, height: 1080 }, scale: 1 },
  { name: "DP-1", primary: false, active: false, rect: { x: 1920, y: 0, width: 1200, height: 800 }, scale: 2 },
]

const SWAY_TREE = {
  name: "root",
  nodes: [
    {
      id: 11,
      type: "con",
      app_id: "firefox",
      name: "Alpha Project",
      pid: 101,
      focused: true,
      rect: { x: 0, y: 0, width: 800, height: 600 },
    },
    {
      name: "container",
      nodes: [
        {
          id: 22,
          type: "con",
          app_id: "terminal",
          name: "Terminal",
          pid: 102,
          rect: { x: 2000, y: 100, width: 800, height: 600 },
        },
      ],
    },
  ],
  floating_nodes: [
    {
      id: 33,
      type: "floating_con",
      app_id: "Code",
      name: "Beta Project",
      pid: 103,
      rect: { x: 500, y: 100, width: 700, height: 500 },
    },
  ],
}

const HYPRLAND_MONITORS = [
  { name: "eDP-1", focused: true, primary: true, x: 0, y: 0, width: 1920, height: 1080, scale: 1 },
  { name: "HDMI-A-1", focused: false, primary: false, x: 1920, y: 0, width: 1200, height: 800, scale: 1.5 },
]

const HYPRLAND_CLIENTS = [
  {
    address: "0x1",
    class: "firefox",
    title: "Alpha Project",
    pid: 101,
    at: [0, 0],
    size: [800, 600],
    mapped: true,
    focused: true,
  },
  { address: "0x2", class: "terminal", title: "Terminal", pid: 102, at: [2000, 100], size: [800, 600], mapped: true },
  { address: "0x3", class: "Code", title: "Beta Project", pid: 103, at: [500, 100], size: [700, 500], mapped: false },
]

type Call = { readonly command: string; readonly args: readonly string[] }
type Response = { stdout: Buffer; stderr?: Buffer; exitCode?: number }

const jsonResponse = (value: unknown): Response => ({ stdout: Buffer.from(JSON.stringify(value), "utf8") })
const errorResponse = (stderr: string): Response => ({
  stdout: Buffer.alloc(0),
  stderr: Buffer.from(stderr, "utf8"),
  exitCode: 1,
})

const fakeProcess = (calls: Call[], respond: (command: string, args: readonly string[]) => Response) =>
  AppProcess.Service.of({
    run: (command: ChildProcess.Command) =>
      Effect.sync(() => {
        if (command._tag !== "StandardCommand") throw new Error("unexpected command tag " + command._tag)
        calls.push({ command: command.command, args: command.args })
        return processResult(command.command, command.args, respond(command.command, command.args))
      }),
  } as unknown as AppProcess.Interface)

function processResult(command: string, args: readonly string[], response: Response) {
  const stdout = response.stdout
  const stderr = response.stderr ?? Buffer.alloc(0)
  return {
    command,
    args,
    exitCode: response.exitCode ?? 0,
    output: stdout,
    stdout,
    stderr,
    outputTruncated: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  }
}

describe("ScreenCapture Wayland backend", () => {
  test("lists Sway outputs and windows through swaymsg", async () => {
    const calls: Call[] = []
    const result = await Effect.runPromise(
      ScreenCaptureWayland.list(
        fakeProcess(calls, (command, args) => {
          if (args.includes("get_outputs")) return jsonResponse(SWAY_OUTPUTS)
          if (args.includes("get_tree")) return jsonResponse(SWAY_TREE)
          throw new Error(`unexpected command ${command} ${args.join(" ")}`)
        }),
        swayBackend(),
      ),
    )

    expect(calls.map((call) => call.args)).toEqual([
      ["-t", "get_outputs"],
      ["-t", "get_tree"],
    ])
    expect(result.displays.map((display) => display.name)).toEqual(["eDP-1", "DP-1"])
    expect(result.windows.map((window) => window.id)).toEqual(["11", "22", "33"])
    expect(result.windows[0]).toMatchObject({ app: "firefox", pid: 101, title: "Alpha Project", display: 1 })
    expect(result.windows[1]).toMatchObject({ app: "terminal", pid: 102, display: 2 })
    expect(result.text).toContain("11  firefox  pid 101")
  })

  test("lists Hyprland monitors and clients through hyprctl", async () => {
    const calls: Call[] = []
    const result = await Effect.runPromise(
      ScreenCaptureWayland.list(
        fakeProcess(calls, (command, args) => {
          if (args.includes("monitors")) return jsonResponse(HYPRLAND_MONITORS)
          if (args.includes("clients")) return jsonResponse(HYPRLAND_CLIENTS)
          throw new Error(`unexpected command ${command} ${args.join(" ")}`)
        }),
        hyprlandBackend(),
      ),
    )

    expect(calls.map((call) => call.args)).toEqual([
      ["monitors", "-j"],
      ["clients", "-j"],
    ])
    expect(result.displays.map((display) => display.name)).toEqual(["eDP-1", "HDMI-A-1"])
    expect(result.windows.map((window) => window.id)).toEqual(["0x1", "0x2", "0x3"])
    expect(result.windows[2]).toMatchObject({ app: "Code", title: "Beta Project", minimized: true, display: 1 })
  })

  test("captures the primary Sway output with grim -o", async () => {
    const calls: Call[] = []
    const result = await Effect.runPromise(
      ScreenCaptureWayland.capture(
        fakeProcess(calls, (command, args) => {
          if (args.includes("get_outputs")) return jsonResponse(SWAY_OUTPUTS)
          if (command === GRIM) return { stdout: PNG }
          throw new Error(`unexpected command ${command} ${args.join(" ")}`)
        }),
        swayBackend(),
        input(),
      ),
    )

    expect(calls.map((call) => call.args)).toEqual([
      ["-t", "get_outputs"],
      ["-o", "eDP-1", "-"],
    ])
    expect(result).toMatchObject({
      mime: "image/png",
      width: 2,
      height: 1,
      target: "screen",
      display: 1,
      backend: "wayland",
      platform: "linux",
      focusChanged: false,
    })
  })

  test("uses the active Sway output when primary is false", async () => {
    const calls: Call[] = []
    const outputs = [
      { name: "eDP-1", primary: false, active: false, rect: { x: 0, y: 0, width: 1920, height: 1080 } },
      { name: "DP-1", primary: false, active: true, rect: { x: 1920, y: 0, width: 1200, height: 800 } },
    ]
    await Effect.runPromise(
      ScreenCaptureWayland.capture(
        fakeProcess(calls, (command, args) => {
          if (args.includes("get_outputs")) return jsonResponse(outputs)
          if (command === GRIM) return { stdout: PNG }
          throw new Error(`unexpected command ${command} ${args.join(" ")}`)
        }),
        swayBackend(),
        input(),
      ),
    )

    expect(calls.at(-1)?.args).toEqual(["-o", "DP-1", "-"])
  })

  test("ignores Sway split containers without a view", async () => {
    const result = await Effect.runPromise(
      ScreenCaptureWayland.list(
        fakeProcess([], (command, args) => {
          if (args.includes("get_outputs")) return jsonResponse(SWAY_OUTPUTS)
          if (args.includes("get_tree"))
            return jsonResponse({
              nodes: [
                {
                  id: 44,
                  type: "con",
                  name: "split",
                  rect: { x: 0, y: 0, width: 800, height: 600 },
                  nodes: [],
                },
              ],
            })
          throw new Error(`unexpected command ${command} ${args.join(" ")}`)
        }),
        swayBackend(),
      ),
    )

    expect(result.windows).toEqual([])
  })

  test("captures numeric Hyprland outputs with grim -o", async () => {
    const calls: Call[] = []
    await Effect.runPromise(
      ScreenCaptureWayland.capture(
        fakeProcess(calls, (command, args) => {
          if (args.includes("monitors")) return jsonResponse(HYPRLAND_MONITORS)
          if (command === GRIM) return { stdout: PNG }
          throw new Error(`unexpected command ${command} ${args.join(" ")}`)
        }),
        hyprlandBackend(),
        input({ display: 2 }),
      ),
    )

    expect(calls.at(-1)?.args).toEqual(["-o", "HDMI-A-1", "-"])
  })

  test("captures all outputs with the union geometry", async () => {
    const calls: Call[] = []
    await Effect.runPromise(
      ScreenCaptureWayland.capture(
        fakeProcess(calls, (command, args) => {
          if (args.includes("get_outputs")) return jsonResponse(SWAY_OUTPUTS)
          if (command === GRIM) return { stdout: PNG }
          throw new Error(`unexpected command ${command} ${args.join(" ")}`)
        }),
        swayBackend(),
        input({ display: "all" }),
      ),
    )

    expect(calls.at(-1)?.args).toEqual(["-g", "0,0 3120x1080", "-"])
  })

  test("fails window capture without invoking grim", async () => {
    const calls: Call[] = []
    const error = await Effect.runPromise(
      ScreenCaptureWayland.capture(
        fakeProcess(calls, (command, args) => {
          if (args.includes("get_outputs")) return jsonResponse(SWAY_OUTPUTS)
          if (args.includes("get_tree")) return jsonResponse(SWAY_TREE)
          throw new Error(`unexpected command ${command} ${args.join(" ")}`)
        }),
        swayBackend(),
        input({ target: "window", window: "firefox" }),
      ).pipe(Effect.catch((failure) => Effect.succeed(failure))),
    )

    expect(error).toBeInstanceOf(CaptureError)
    if (!(error instanceof CaptureError)) return
    expect(error.code).toBe("window_not_capturable")
    expect(error.reason).toContain("Wayland does not expose a generic protocol")
    expect(error.candidates).toContain('11 firefox pid 101 "Alpha Project"')
    expect(calls.at(-1)?.command).toBe(SWAYMSG)
  })

  test("requires a selector for window capture", async () => {
    const calls: Call[] = []
    const error = await Effect.runPromise(
      ScreenCaptureWayland.capture(
        fakeProcess(calls, (command, args) => {
          if (args.includes("get_outputs")) return jsonResponse(SWAY_OUTPUTS)
          if (args.includes("get_tree")) return jsonResponse(SWAY_TREE)
          throw new Error(`unexpected command ${command} ${args.join(" ")}`)
        }),
        swayBackend(),
        input({ target: "window" }),
      ).pipe(Effect.catch((failure) => Effect.succeed(failure))),
    )

    expect(error).toBeInstanceOf(CaptureError)
    if (!(error instanceof CaptureError)) return
    expect(error.code).toBe("window_not_found")
    expect(error.reason).toBe("target window requires a window selector")
  })

  test("maps grim permission failures", async () => {
    const calls: Call[] = []
    const error = await Effect.runPromise(
      ScreenCaptureWayland.capture(
        fakeProcess(calls, (command, args) => {
          if (args.includes("get_outputs")) return jsonResponse(SWAY_OUTPUTS)
          if (command === GRIM) return errorResponse("compositor denied access")
          throw new Error(`unexpected command ${command} ${args.join(" ")}`)
        }),
        swayBackend(),
        input(),
      ).pipe(Effect.catch((failure) => Effect.succeed(failure))),
    )

    expect(error).toBeInstanceOf(CaptureError)
    if (!(error instanceof CaptureError)) return
    expect(error.code).toBe("permission_required")
  })
})
