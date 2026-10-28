import { describe, expect, test } from "bun:test"
import type { AssistantMessage, FilePart, Message, Part, ToolPart, UserMessage } from "@opencode-ai/sdk/v2"
import type { ImageViewerItem } from "@opencode-ai/ui/image-viewer"
import {
  dataUrlMime,
  dataUrlToBlob,
  imageActionAvailability,
  imageFileName,
  imageMime,
  isCopyableImage,
  pngConversionDecision,
  shouldConvertToPng,
} from "./image-actions-helpers"
import {
  assistantImageViewerItem,
  sessionImageGallery,
  toolImageViewerItem,
  userImageViewerItem,
} from "./image-gallery"

const PNG = "data:image/png;base64,iVBORw0KGgo="
const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRg=="
const SVG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"

function item(partial: Partial<ImageViewerItem> = {}): ImageViewerItem {
  return {
    src: PNG,
    alt: "image",
    mime: "image/png",
    ...partial,
  }
}

function userMessage(id: string, created: number): UserMessage {
  return {
    id,
    sessionID: "ses_1",
    role: "user",
    time: { created },
  } as UserMessage
}

function assistantMessage(id: string, created: number): AssistantMessage {
  return {
    id,
    sessionID: "ses_1",
    role: "assistant",
    time: { created },
  } as AssistantMessage
}

function filePart(partial: Partial<FilePart> = {}): FilePart {
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

function toolPart(partial: Partial<ToolPart> = {}, attachmentUrl = PNG): ToolPart {
  return {
    id: "tool_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "tool",
    callID: "call_1",
    tool: "read",
    state: {
      status: "completed",
      input: { filePath: "/repo/src/logo.png" },
      output: "",
      title: "",
      metadata: { width: 320, height: 180 },
      time: { start: 0, end: 1 },
      attachments: [
        {
          id: "att_1",
          sessionID: "ses_1",
          messageID: "msg_1",
          type: "file",
          mime: "image/png",
          url: attachmentUrl,
          filename: "logo.png",
        },
      ],
    },
    ...partial,
  } as ToolPart
}

describe("dataUrlToBlob", () => {
  test("decodes base64 bytes and preserves the MIME type", async () => {
    const blob = dataUrlToBlob("data:image/png;base64,AQIDBA==")
    expect(blob.type).toBe("image/png")
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3, 4])
  })

  test("decodes percent-encoded payloads", async () => {
    const blob = dataUrlToBlob("data:text/plain;charset=utf-8,hello%20world")
    expect(blob.type.includes("text/plain")).toBe(true)
    expect(await blob.text()).toBe("hello world")
  })

  test("reads the MIME type without decoding", () => {
    expect(dataUrlMime(JPEG)).toBe("image/jpeg")
    expect(dataUrlMime(SVG)).toBe("image/svg+xml")
    expect(dataUrlMime("https://example.com/a.png")).toBeUndefined()
  })
})

describe("PNG conversion decision", () => {
  test("PNG is copied without conversion", () => {
    expect(shouldConvertToPng("image/png")).toBe(false)
    expect(pngConversionDecision(item())).toEqual({ copyable: true, convert: false })
  })

  test("JPEG, GIF and WebP are converted through a canvas", () => {
    for (const mime of ["image/jpeg", "image/gif", "image/webp"]) {
      expect(shouldConvertToPng(mime)).toBe(true)
      expect(pngConversionDecision(item({ mime, src: `data:${mime};base64,AAAA` }))).toEqual({
        copyable: true,
        convert: true,
      })
    }
  })

  test("SVG, PDF and remote URLs are not copyable", () => {
    expect(pngConversionDecision(item({ mime: "image/svg+xml", src: SVG })).copyable).toBe(false)
    expect(pngConversionDecision(item({ mime: "application/pdf", src: SVG })).copyable).toBe(false)
    expect(pngConversionDecision(item({ mime: "image/png", src: "https://example.com/a.png" })).copyable).toBe(false)
  })

  test("resolves MIME from the data URL when metadata is missing", () => {
    expect(imageMime({ src: JPEG })).toBe("image/jpeg")
    expect(isCopyableImage({ src: PNG })).toBe(true)
    expect(isCopyableImage({ src: SVG })).toBe(false)
  })
})

describe("imageFileName", () => {
  const timestamp = Date.UTC(2026, 0, 2, 3, 4, 5)

  test("uses the caption and MIME extension", () => {
    expect(imageFileName(item({ caption: "Login screen", mime: "image/jpeg" }), timestamp)).toBe(
      "login-screen-20260102-030405.jpg",
    )
  })

  test("falls back to the filename without its extension", () => {
    expect(imageFileName(item({ filename: "photo.PNG" }), timestamp)).toBe("photo-20260102-030405.png")
  })

  test("falls back to the tool name from the source", () => {
    expect(imageFileName(item({ source: "read · src/logo.png" }), timestamp)).toBe("read-20260102-030405.png")
  })

  test("sanitizes unsafe characters", () => {
    expect(imageFileName(item({ caption: 'a/b:c*?"<>| d' }), timestamp)).toBe("a-b-c-d-20260102-030405.png")
  })
})

describe("imageActionAvailability", () => {
  test("disables copy image when the page is not a secure context", () => {
    const result = imageActionAvailability({ target: item(), secureContext: false, hasClipboardItem: true })
    expect(result.copyImage).toBe(true)
    expect(result.copyImageDisabledReason).toBe("insecure-context")
  })

  test("disables copy image when ClipboardItem is missing", () => {
    const result = imageActionAvailability({ target: item(), secureContext: true, hasClipboardItem: false })
    expect(result.copyImageDisabledReason).toBe("clipboard-unavailable")
  })

  test("enables copy image in a secure context with ClipboardItem", () => {
    expect(imageActionAvailability({ target: item() }).copyImageDisabledReason).toBeUndefined()
  })

  test("desktop hides open in new tab and enables reveal when the callback exists", () => {
    const result = imageActionAvailability({
      target: item({ path: "/tmp/logo.png" }),
      platform: "desktop",
      canOpenInNewTab: true,
      canRevealPath: true,
    })
    expect(result.openInNewTab).toBe(false)
    expect(result.revealInFileManager).toBe(true)
  })

  test("browser shows open in new tab and hides reveal", () => {
    const result = imageActionAvailability({
      target: item({ path: "/tmp/logo.png" }),
      platform: "browser",
      canOpenInNewTab: true,
      canRevealPath: true,
    })
    expect(result.openInNewTab).toBe(true)
    expect(result.revealInFileManager).toBe(false)
  })

  test("missing callbacks hide their actions", () => {
    const result = imageActionAvailability({ target: item() })
    expect(result.openInNewTab).toBe(false)
    expect(result.revealInFileManager).toBe(false)
    expect(result.attachToMessage).toBe(false)
    expect(result.goToMessage).toBe(false)
  })

  test("unsupported targets disable copy image and save image", () => {
    for (const target of [
      item({ mime: "image/svg+xml", src: SVG }),
      item({ src: "https://example.com/a.png" }),
      item({ mime: "application/pdf", src: "data:application/pdf;base64,AA==" }),
    ]) {
      const result = imageActionAvailability({ target })
      expect(result.copyImage).toBe(false)
      expect(result.saveImage).toBe(false)
      expect(result.copyImageDisabledReason).toBe("unsupported-image")
    }
    const supported = imageActionAvailability({ target: item() })
    expect(supported.copyImage).toBe(true)
    expect(supported.saveImage).toBe(true)
  })

  test("copy path and reveal require an absolute host path that is not a URL", () => {
    expect(imageActionAvailability({ target: item() }).copyPath).toBe(false)
    expect(imageActionAvailability({ target: item({ path: "src/logo.png" }) }).copyPath).toBe(false)
    expect(imageActionAvailability({ target: item({ path: "https://example.com/a.png" }) }).copyPath).toBe(false)
    expect(imageActionAvailability({ target: item({ path: "file:///tmp/shot.png" }) }).copyPath).toBe(false)
    expect(imageActionAvailability({ target: item({ path: "/tmp/shot.png" }) }).copyPath).toBe(true)
    expect(imageActionAvailability({ target: item({ path: "C:\\tmp\\shot.png" }) }).copyPath).toBe(true)
    expect(
      imageActionAvailability({
        target: item({ path: "src/logo.png" }),
        platform: "desktop",
        canRevealPath: true,
      }).revealInFileManager,
    ).toBe(false)
    expect(
      imageActionAvailability({
        target: item({ path: "/tmp/shot.png" }),
        platform: "desktop",
        canRevealPath: true,
      }).revealInFileManager,
    ).toBe(true)
  })

  test("go to message is only available inside the viewer", () => {
    expect(imageActionAvailability({ target: item({ messageID: "msg_1" }) }).goToMessage).toBe(false)
    expect(imageActionAvailability({ target: item({ messageID: "msg_1" }), inViewer: true }).goToMessage).toBe(true)
  })
})

describe("sessionImageGallery", () => {
  const labels = { image: "Image", attachment: "attachment", you: "You" }

  test("returns rendered user and tool images in timeline order", () => {
    const messages: Message[] = [assistantMessage("msg_2", 2), userMessage("msg_1", 1)]
    const parts: Record<string, Part[]> = {
      msg_1: [filePart({ id: "user_file", messageID: "msg_1", filename: "user.png" })],
      msg_2: [
        toolPart({ id: "tool_1", messageID: "msg_2" }, "data:image/png;base64,iVBORw0KGgoAAA=="),
        filePart({
          id: "assistant_file",
          messageID: "msg_2",
          filename: "assistant.png",
          mime: "image/jpeg",
          url: JPEG,
        }),
      ],
    }
    const gallery = sessionImageGallery({ sessionID: "ses_1", messages, parts, labels })
    expect(gallery.map((entry) => entry.partID)).toEqual(["user_file", "tool_1"])
    expect(gallery[0]!.source).toBe("You")
    expect(gallery[1]!.source).toBe("read · /repo/src/logo.png")
    expect(gallery[1]!.width).toBe(320)
    expect(gallery[1]!.height).toBe(180)
    expect(gallery[1]!.path).toBe("/repo/src/logo.png")
  })

  test("keeps multiple images from one tool part", () => {
    const base = toolPart()
    if (base.state.status !== "completed") throw new Error("expected completed tool")
    const attachment = base.state.attachments![0]!
    const part = {
      ...base,
      state: { ...base.state, attachments: [attachment, { ...attachment, id: "att_2", url: JPEG }] },
    } as ToolPart
    const messages: Message[] = [assistantMessage("msg_1", 1)]
    const gallery = sessionImageGallery({ sessionID: "ses_1", messages, parts: { msg_1: [part] }, labels })
    expect(gallery.map((entry) => entry.src)).toEqual([PNG, JPEG])
  })

  test("keeps distinct parts with the same source and ignores non-image files", () => {
    const messages: Message[] = [userMessage("msg_1", 1), userMessage("msg_2", 2)]
    const parts: Record<string, Part[]> = {
      msg_1: [
        filePart({ id: "user_file", messageID: "msg_1" }),
        filePart({
          id: "pdf_file",
          messageID: "msg_1",
          mime: "application/pdf",
          url: "data:application/pdf;base64,AA==",
        }),
      ],
      msg_2: [filePart({ id: "duplicate_file", messageID: "msg_2" })],
    }
    const gallery = sessionImageGallery({ sessionID: "ses_1", messages, parts, labels })
    expect(gallery.map((entry) => entry.partID)).toEqual(["user_file", "duplicate_file"])
  })

  test("excludes user and assistant file parts whose URLs are not inline images", () => {
    const messages: Message[] = [userMessage("msg_1", 1), assistantMessage("msg_2", 2)]
    const parts: Record<string, Part[]> = {
      msg_1: [
        filePart({ id: "remote_user", messageID: "msg_1", url: "https://example.com/a.png" }),
        filePart({ id: "svg_user", messageID: "msg_1", mime: "image/svg+xml", url: SVG }),
      ],
      msg_2: [
        filePart({ id: "remote_assistant", messageID: "msg_2", url: "https://example.com/b.png" }),
        filePart({ id: "non_base64_assistant", messageID: "msg_2", url: "data:image/png,iVBORw0KGgo=" }),
      ],
    }
    expect(sessionImageGallery({ sessionID: "ses_1", messages, parts, labels })).toEqual([])
    expect(userImageViewerItem(parts.msg_1![0]!, "msg_1", labels)).toBeUndefined()
    expect(assistantImageViewerItem(parts.msg_2![0]!, "msg_2", labels)).toBeUndefined()
  })

  test("falls back to the attachment label for users and the image label for assistants", () => {
    const noYou = { image: "Image", attachment: "attachment" }
    const user = userImageViewerItem(filePart({ id: "user_file", messageID: "msg_1" }), "msg_1", noYou)
    const assistant = assistantImageViewerItem(filePart({ id: "assistant_file", messageID: "msg_2" }), "msg_2", noYou)
    expect(user?.source).toBe("attachment")
    expect(assistant?.source).toBe("Image")
  })

  test("does not expose relative tool names as paths", () => {
    const relative = toolPart({
      id: "tool_relative",
      messageID: "msg_1",
      state: {
        status: "completed",
        input: { filePath: "src/logo.png" },
        output: "",
        title: "",
        metadata: {},
        time: { start: 0, end: 1 },
        attachments: [
          {
            id: "att",
            sessionID: "ses_1",
            messageID: "msg_1",
            type: "file",
            mime: "image/png",
            url: PNG,
            filename: "logo.png",
          },
        ],
      },
    })
    const item = toolImageViewerItem(
      relative,
      { kind: "image", key: "att", url: PNG, mime: "image/png", index: 0 },
      labels,
    )
    expect(item.source).toBe("read · src/logo.png")
    expect(item.path).toBeUndefined()
  })
})
