import { describe, expect, test } from "bun:test"
import type { FilePart, ToolPart } from "@opencode-ai/sdk/v2"
import { shownImage } from "./shown-image"

const PNG = "data:image/png;base64,iVBORw0KGgo="
const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRg=="
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

function partWithState(state: ToolPart["state"], tool = "show_image"): ToolPart {
  return {
    id: "prt_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "tool",
    callID: "call_1",
    tool,
    state,
  }
}

function completed(metadata: Record<string, unknown>, attachments?: FilePart[], tool = "show_image"): ToolPart {
  return partWithState(
    {
      status: "completed",
      input: {},
      output: "",
      title: tool,
      metadata,
      time: { start: 0, end: 1 },
      attachments,
    },
    tool,
  )
}

describe("shownImage", () => {
  test("returns the first inline image for a completed shown part", () => {
    const part = completed(
      {
        path: "/tmp/opencode/home.png",
        name: "home.png",
        mime: "image/png",
        width: 1200,
        height: 600,
        bytes: 142000,
        caption: "Home page",
        shown: true,
      },
      [attachment({ filename: "home.png" })],
    )

    expect(shownImage(part)).toEqual({
      key: "file_1",
      url: PNG,
      mime: "image/png",
      filename: "home.png",
      name: "home.png",
      caption: "Home page",
      path: "/tmp/opencode/home.png",
      width: 1200,
      height: 600,
      bytes: 142000,
    })
  })

  test("requires metadata.shown to be true", () => {
    expect(shownImage(completed({}, [attachment()]))).toBeUndefined()
    expect(shownImage(completed({ shown: false }, [attachment()]))).toBeUndefined()
    expect(shownImage(completed({ shown: "true" }, [attachment()]))).toBeUndefined()
  })

  test("requires a completed state", () => {
    const state = {
      status: "running",
      input: {},
      time: { start: 0 },
      metadata: { shown: true },
    } satisfies ToolPart["state"]

    expect(shownImage(partWithState(state))).toBeUndefined()
  })

  test("excludes screenshots that never opted into the shown card", () => {
    const part = completed({ path: "/tmp/shot.png" }, [attachment()], "mcp__browser__screenshot")

    expect(shownImage(part)).toBeUndefined()
  })

  test("excludes remote, SVG and PDF attachments", () => {
    const attachments = [
      attachment({ mime: "image/png", url: "https://example.com/a.png" }),
      attachment({ mime: "image/svg+xml", url: SVG }),
      attachment({ mime: "application/pdf", url: "data:application/pdf;base64,JVBERi0=" }),
    ]

    for (const file of attachments) {
      expect(shownImage(completed({ shown: true }, [file]))).toBeUndefined()
    }
  })

  test("uses the attachment filename when metadata has no name", () => {
    const image = shownImage(completed({ shown: true }, [attachment({ filename: "attachment.png" })]))
    expect(image?.name).toBe("attachment.png")
    expect(image?.filename).toBe("attachment.png")
  })

  test("falls back to the basename of the metadata path", () => {
    expect(shownImage(completed({ shown: true, path: "/tmp/opencode/home.png" }, [attachment()]))?.name).toBe(
      "home.png",
    )
    expect(shownImage(completed({ shown: true, path: "C:\\shots\\home.png" }, [attachment()]))?.name).toBe("home.png")
    expect(shownImage(completed({ shown: true, path: "/tmp/opencode/" }, [attachment()]))?.name).toBe("opencode")
  })

  test("prefers a non-empty metadata name and caption", () => {
    const image = shownImage(
      completed({ shown: true, name: "Home page.png", caption: "Home page" }, [
        attachment({ filename: "attachment.png" }),
      ]),
    )

    expect(image?.name).toBe("Home page.png")
    expect(image?.caption).toBe("Home page")
  })

  test("ignores empty names, captions, paths and invalid numbers", () => {
    const image = shownImage(
      completed(
        {
          shown: true,
          name: "",
          caption: "",
          path: 42,
          width: 0,
          height: -1,
          bytes: -1,
        },
        [attachment({ filename: "" })],
      ),
    )

    expect(image).toEqual({
      key: "file_1",
      url: PNG,
      mime: "image/png",
      filename: undefined,
      name: undefined,
      caption: undefined,
      path: undefined,
      width: undefined,
      height: undefined,
      bytes: undefined,
    })
  })

  test("accepts finite positive dimensions and non-negative bytes", () => {
    const image = shownImage(
      completed({ shown: true, width: 1, height: 1, bytes: 0 }, [attachment({ mime: "image/jpeg", url: JPEG })]),
    )

    expect(image?.width).toBe(1)
    expect(image?.height).toBe(1)
    expect(image?.bytes).toBe(0)
    expect(image?.mime).toBe("image/jpeg")
  })

  test("uses the first inline image when earlier attachments are chips", () => {
    const image = shownImage(
      completed({ shown: true }, [
        attachment({
          id: "file_pdf",
          mime: "application/pdf",
          url: "data:application/pdf;base64,JVBERi0=",
          filename: "report.pdf",
        }),
        attachment({ id: "file_first", filename: "first.png" }),
        attachment({ id: "file_second", filename: "second.png" }),
      ]),
    )

    expect(image?.key).toBe("file_first")
    expect(image?.filename).toBe("first.png")
  })
})
