import { afterEach, describe, expect, test } from "bun:test"
import { testRender, type JSX } from "@opentui/solid"
import { InlineToolRow, showImageLine, toolDisplay } from "../../../src/routes/session"

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

describe("TUI show_image display", () => {
  test("uses the dedicated show_image renderer", () => {
    expect(toolDisplay("show_image")).toBe("show_image")
  })

  test("renders the shown image path and dimensions", async () => {
    const frame = await renderFrame(
      () => (
        <InlineToolRow icon="▨" complete="/tmp/opencode/home.png" pending="Showing image…">
          {showImageLine({ path: "/tmp/opencode/home.png", width: 1200, height: 600 })}
        </InlineToolRow>
      ),
      { width: 96, height: 2 },
    )

    expect(frame).toContain("Image shown: /tmp/opencode/home.png (1200×600)")
  })

  test("omits dimensions when metadata is missing them", () => {
    expect(showImageLine({ path: "/tmp/opencode/home.png" })).toBe("Image shown: /tmp/opencode/home.png")
    expect(showImageLine({ path: "/tmp/opencode/home.png", width: 1200 })).toBe("Image shown: /tmp/opencode/home.png")
  })
})
