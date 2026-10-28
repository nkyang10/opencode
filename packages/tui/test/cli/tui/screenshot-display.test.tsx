import { afterEach, describe, expect, test } from "bun:test"
import { testRender, type JSX } from "@opentui/solid"
import { InlineToolRow, screenshotLine, toolDisplay } from "../../../src/routes/session"

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  testSetup?.renderer.destroy()
  testSetup = undefined
})

async function renderFrame(component: () => JSX.Element, options: { width: number; height: number }) {
  testSetup = await testRender(component, options)
  await testSetup.renderOnce()
  await testSetup.renderOnce()

  return testSetup
    .captureCharFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd()
}

describe("TUI screenshot display", () => {
  test("uses the dedicated screenshot renderer", () => {
    expect(toolDisplay("screenshot")).toBe("screenshot")
  })

  test("renders the captured window app and dimensions", () => {
    expect(
      screenshotLine({
        action: "capture",
        target: "window",
        window: { id: "0x00a", app: "firefox" },
        width: 1280,
        height: 900,
      }),
    ).toBe("Screenshot: firefox (1280×900)")
  })

  test("renders the display when no window is captured", () => {
    expect(screenshotLine({ action: "capture", target: "screen", display: 2, width: 1920, height: 1080 })).toBe(
      "Screenshot: display 2 (1920×1080)",
    )
  })

  test("renders list counts", () => {
    expect(screenshotLine({ action: "list", displays: [{ index: 1 }], windows: [{ id: "0x001" }, { id: "0x002" }] })).toBe(
      "Screenshot list: 1 display, 2 windows",
    )
  })

  test("renders a completed capture line", async () => {
    const line = screenshotLine({ action: "capture", target: "screen", display: "primary", width: 800, height: 600 })
    const frame = await renderFrame(
      () => (
        <InlineToolRow icon="▨" complete={line} pending="Taking screenshot…">
          {line}
        </InlineToolRow>
      ),
      { width: 96, height: 2 },
    )

    expect(frame).toContain("Screenshot: display primary (800×600)")
  })
})
