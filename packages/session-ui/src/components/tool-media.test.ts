import { describe, expect, test } from "bun:test"
import type { FilePart, ToolPart } from "@opencode-ai/sdk/v2"
import { toolMedia } from "./tool-media"

const PNG = "data:image/png;base64,iVBORw0KGgo="
const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRg=="
const GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
const WEBP = "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vuUAAA="
const SVG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"

function attachment(partial: Partial<FilePart> = {}): FilePart {
  return {
    id: "file_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "file",
    mime: "image/png",
    url: PNG,
    ...partial,
  }
}

function partWithState(state: ToolPart["state"]): ToolPart {
  return {
    id: "prt_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "tool",
    callID: "call_1",
    tool: "read",
    state,
  }
}

function completed(
  attachments?: FilePart[],
  time: { start: number; end: number; compacted?: number } = { start: 0, end: 1 },
): ToolPart {
  return partWithState({
    status: "completed",
    input: {},
    output: "",
    title: "read",
    metadata: {},
    time,
    attachments,
  })
}

describe("toolMedia", () => {
  test("preserves provider attachment order across images and chips", () => {
    const items = toolMedia(
      completed([
        attachment({ id: "file_a", filename: "a.png" }),
        attachment({
          id: "file_b",
          mime: "application/pdf",
          url: "data:application/pdf;base64,JVBERi0=",
          filename: "b.pdf",
        }),
        attachment({ id: "file_c", mime: "image/jpeg", url: JPEG, filename: "c.jpg" }),
      ]),
    )

    expect(items.map((item) => item.kind)).toEqual(["image", "chip", "image"])
    expect(items.map((item) => item.key)).toEqual(["file_a", "file_b", "file_c"])
    expect(items.map((item) => item.filename)).toEqual(["a.png", "b.pdf", "c.jpg"])
  })

  test("renders png, jpeg, gif and webp base64 data urls inline", () => {
    const formats = [
      ["image/png", PNG],
      ["image/jpeg", JPEG],
      ["image/gif", GIF],
      ["image/webp", WEBP],
    ] as const

    for (const [mime, url] of formats) {
      const items = toolMedia(completed([attachment({ mime, url })]))
      expect(items).toHaveLength(1)
      expect(items[0].kind).toBe("image")
    }
  })

  test("downgrades unsafe and non-inline media to chips", () => {
    const urls = [
      ["image/svg+xml", SVG],
      ["image/png", "data:image/png,iVBORw0KGgo="],
      ["image/png", "https://example.com/a.png"],
      ["image/png", "http://example.com/a.png"],
      ["image/png", "blob:https://example.com/123"],
      ["application/pdf", "data:application/pdf;base64,JVBERi0="],
      ["image/png", "file:///tmp/a.png"],
      ["application/octet-stream", "data:application/octet-stream;base64,AAAA"],
    ] as const

    for (const [mime, url] of urls) {
      const items = toolMedia(completed([attachment({ mime, url })]))
      expect(items).toHaveLength(1)
      expect(items[0].kind).toBe("chip")
    }
  })

  test("keeps attachments of compacted parts", () => {
    const items = toolMedia(completed([attachment({ filename: "kept.png" })], { start: 0, end: 1, compacted: 2 }))

    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe("image")
    expect(items[0].filename).toBe("kept.png")
  })

  test("falls back to the attachment index when the file id is empty", () => {
    const items = toolMedia(
      completed([attachment({ id: "", filename: "one.png" }), attachment({ id: "", filename: "two.png" })]),
    )

    expect(items.map((item) => item.key)).toEqual(["0", "1"])
  })

  test("returns nothing for a missing part, empty attachments or missing attachments", () => {
    expect(toolMedia(undefined)).toEqual([])
    expect(toolMedia(completed([]))).toEqual([])
    expect(toolMedia(completed())).toEqual([])
  })

  test("returns nothing for non-completed states", () => {
    const states = [
      { status: "pending", input: {}, raw: "" },
      { status: "running", input: {}, time: { start: 0 } },
      { status: "error", input: {}, error: "failed", time: { start: 0, end: 1 } },
    ] satisfies ToolPart["state"][]

    for (const state of states) {
      expect(toolMedia(partWithState(state))).toEqual([])
    }
  })
})
