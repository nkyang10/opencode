import { describe, expect, test } from "bun:test"
import { disableWebPush, enableWebPush, webPushSupported } from "./web-push"

describe("web-push", () => {
  test("webPushSupported is false outside a secure context", () => {
    // happydom is not a secure context (http://localhost)
    expect(window.isSecureContext).not.toBe(true)
    expect(webPushSupported()).toBe(false)
  })

  test("enableWebPush is a no-op when unsupported", async () => {
    expect(await enableWebPush()).toBe(false)
  })

  test("disableWebPush resolves when unsupported", async () => {
    expect(await disableWebPush()).toBe(true)
  })
})
