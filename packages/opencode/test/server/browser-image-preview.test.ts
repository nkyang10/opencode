import { describe, expect, it } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BrowserImagePreview } from "@/server/browser-image-preview"

const full = "data:image/png;base64,QUJD"
const thumb = "data:image/jpeg;base64,WFla"

function shown(metadata: Record<string, unknown> = {}, attachments?: unknown[]) {
  return {
    id: "part_1",
    messageID: "msg_1",
    sessionID: "ses_1",
    type: "tool",
    callID: "call_1",
    tool: "show_image",
    state: {
      status: "completed",
      input: {},
      output: "Shown to the user: shot.png (PNG, 1200x900, 400000 B).",
      title: "shot.png",
      time: { start: 0, end: 1 },
      metadata: {
        mime: "image/jpeg",
        width: 1200,
        height: 900,
        bytes: 300_000,
        preview: { uri: thumb, mime: "image/jpeg", width: 320, height: 240, bytes: 40_000 },
        shown: true,
        truncated: false,
        ...metadata,
      },
      attachments: attachments ?? [
        { id: "part_2", messageID: "msg_1", sessionID: "ses_1", type: "file", mime: "image/jpeg", url: full },
      ],
    },
  } as unknown as SessionV1.ToolPart
}

const completed = (part: SessionV1.ToolPart) => part.state as SessionV1.ToolStateCompleted

const project = (part: unknown) =>
  BrowserImagePreview.previewMessages([
    { info: { id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 0 } }, parts: [part] } as never,
  ])[0].parts[0] as SessionV1.ToolPart

describe("BrowserImagePreview (v1)", () => {
  it("serves the preview url in place of the full attachment", () => {
    expect(completed(project(shown())).attachments?.[0]).toMatchObject({ url: thumb, mime: "image/jpeg" })
  })

  it("keeps the preview description but drops its uri so the bytes travel once", () => {
    expect(completed(project(shown())).metadata.preview).toEqual({
      mime: "image/jpeg",
      width: 320,
      height: 240,
      bytes: 40_000,
    })
  })

  it("leaves a tool part without a preview untouched", () => {
    const part = shown()
    delete completed(part).metadata.preview
    expect(project(part)).toBe(part)
  })

  it("leaves non-image attachments untouched", () => {
    const part = shown({}, [
      { id: "part_3", messageID: "msg_1", sessionID: "ses_1", type: "file", mime: "application/pdf", url: full },
    ])
    expect(project(part)).toBe(part)
  })

  it("leaves parts that are not tools untouched", () => {
    const part = { id: "part_4", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "hello" }
    expect(project(part) as unknown).toBe(part)
  })

  it("ignores a preview without a usable inline uri", () => {
    const part = shown({ preview: { uri: "https://example.test/thumb.jpg", mime: "image/jpeg" } })
    expect(project(part)).toBe(part)
  })

  it("projects the part carried by a message.part.updated event", () => {
    const event: { id: string; type: string; properties: unknown } = {
      id: "evt_1",
      type: "message.part.updated",
      properties: { sessionID: "ses_1", part: shown() },
    }
    const projected = BrowserImagePreview.previewEvent(event) as typeof event

    expect(projected).not.toBe(event)
    expect(projected.properties).not.toBe(event.properties)
    expect(completed((projected.properties as { part: SessionV1.ToolPart }).part).attachments?.[0]).toMatchObject({
      url: thumb,
    })
  })

  it("projects the payload inside a global stream envelope", () => {
    const envelope = {
      directory: "/tmp/one",
      payload: { id: "evt_2", type: "message.part.updated", properties: { sessionID: "ses_1", part: shown() } },
    }
    const projected = BrowserImagePreview.previewGlobalEvent(envelope) as typeof envelope

    expect(projected).not.toBe(envelope)
    expect(projected.payload).toMatchObject({ id: "evt_2", type: "message.part.updated" })
    expect(
      completed(
        ((projected.payload as { properties: { part: SessionV1.ToolPart } }).properties.part) as SessionV1.ToolPart,
      ).attachments?.[0],
    ).toMatchObject({ url: thumb })
  })

  it("leaves a global envelope without a previewed part alone", () => {
    const envelope = { directory: "/tmp/one", payload: { id: "evt_3", type: "server.heartbeat", properties: {} } }
    expect(BrowserImagePreview.previewGlobalEvent(envelope)).toBe(envelope)
  })

  it("does not touch the stored part", () => {
    const part = shown()

    project(part)

    expect(completed(part).attachments?.[0]).toMatchObject({ url: full })
    expect(completed(part).metadata.preview).toMatchObject({ uri: thumb })
  })
})
