import { describe, expect, test } from "bun:test"
import { BrowserImagePreview } from "../src/browser-image-preview"
import { SessionMessage } from "@opencode-ai/core/session/message"

const full = "data:image/png;base64,AAAAAAAA"
const thumb = "data:image/jpeg;base64,/9j/4AAQ"

type ToolState = {
  content: Record<string, unknown>[]
  attachments?: Record<string, unknown>[]
  structured: Record<string, unknown>
}

function shownTool(overrides: Record<string, unknown> = {}) {
  return {
    type: "tool" as const,
    id: "call_1",
    name: "show_image",
    state: {
      status: "completed" as const,
      input: { path: "/tmp/shot.png" },
      content: [{ type: "file" as const, uri: full, mime: "image/png", name: "shot.png" }],
      attachments: [{ uri: full, mime: "image/png", name: "shot.png" }],
      structured: { shown: true, width: 3000, height: 2000, preview: { uri: thumb, mime: "image/jpeg", width: 768, height: 512, bytes: 30_000 } },
      ...overrides,
    },
    time: { created: new Date(0) },
  }
}

function assistant(content: readonly Record<string, unknown>[]) {
  return {
    id: SessionMessage.ID.make("msg_test"),
    type: "assistant" as const,
    agent: "build",
    model: { providerID: "test", modelID: "test" },
    content,
    time: { created: new Date(0) },
  } as unknown as SessionMessage.Message
}

describe("BrowserImagePreview.previewMessages", () => {
  test("substitutes the preview and keeps its description", () => {
    const tool = shownTool()
    const [message] = BrowserImagePreview.previewMessages([assistant([tool])])
    const state = (message as unknown as { content: { state: ToolState }[] }).content[0].state

    expect(state.content[0]).toEqual({ type: "file", uri: thumb, mime: "image/jpeg", name: "shot.png" })
    expect(state.attachments?.[0]).toEqual({ uri: thumb, mime: "image/jpeg", name: "shot.png" })
    expect(state.structured.preview).toEqual({ mime: "image/jpeg", width: 768, height: 512, bytes: 30_000 })
    expect(state.structured.shown).toBe(true)
    expect(state.structured.width).toBe(3000)
    expect(JSON.stringify(message)).not.toContain(full)
  })

  test("does not rewrite the stored message", () => {
    const tool = shownTool()
    BrowserImagePreview.previewMessages([assistant([tool])])

    expect(tool.state.content[0].uri).toBe(full)
    expect(tool.state.structured.preview.uri).toBe(thumb)
  })

  test("keeps identity when there is nothing to substitute", () => {
    const message = assistant([{ ...shownTool(), state: { ...shownTool().state, structured: { shown: true } } }])

    expect(BrowserImagePreview.previewMessages([message])[0]).toBe(message)
  })

  test("ignores previews that are not inline images", () => {
    const message = assistant([shownTool({ structured: { shown: true, preview: { uri: "http://host/preview.jpg", mime: "image/jpeg" } } })])

    expect(BrowserImagePreview.previewMessages([message])[0]).toBe(message)
  })

  test("leaves non-image files and unfinished tools alone", () => {
    const document = assistant([
      {
        type: "tool",
        id: "call_2",
        name: "show_image",
        state: {
          status: "completed",
          input: {},
          content: [{ type: "file", uri: full, mime: "application/pdf" }],
          structured: { preview: { uri: thumb, mime: "image/jpeg" } },
        },
        time: { created: new Date(0) },
      },
    ])
    const running = assistant([{ ...shownTool(), state: { status: "running", input: {}, content: [], structured: {} } }])

    expect(BrowserImagePreview.previewMessages([document, running])).toEqual([document, running])
  })

  test("passes non-assistant messages through", () => {
    const message = { id: "msg_x", type: "user", content: [], time: { created: new Date(0) } } as unknown as SessionMessage.Message

    expect(BrowserImagePreview.previewMessages([message])[0]).toBe(message)
  })
})

describe("BrowserImagePreview.previewEvent", () => {
  const event = {
    id: "evt_1",
    type: "session.next.tool.success",
    data: {
      sessionID: "ses_1",
      callID: "call_1",
      content: [{ type: "file", uri: full, mime: "image/png" }],
      structured: { shown: true, preview: { uri: thumb, mime: "image/jpeg", bytes: 30_000 } },
    },
  }

  test("substitutes the preview in a tool event", () => {
    expect(BrowserImagePreview.previewEvent(event)).toEqual({
      ...event,
      data: {
        ...event.data,
        content: [{ type: "file", uri: thumb, mime: "image/jpeg" }],
        structured: { shown: true, preview: { mime: "image/jpeg", bytes: 30_000 } },
      },
    })
    expect(event.data.content[0].uri).toBe(full)
  })

  test("leaves events without a preview alone", () => {
    const plain = {
      id: "evt_2",
      type: "session.next.tool.success",
      data: { callID: "call_1", content: [{ type: "file", uri: full, mime: "image/png" }], structured: { shown: true } },
    }
    const idle = { type: "session.idle", data: { sessionID: "ses_1" } }

    expect(BrowserImagePreview.previewEvent(plain)).toBe(plain)
    expect(BrowserImagePreview.previewEvent(idle)).toBe(idle)
    expect(BrowserImagePreview.previewEvent(undefined)).toBe(undefined)
  })
})
