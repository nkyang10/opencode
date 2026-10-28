import { describe, expect, test } from "bun:test"
import { authFromToken, authTokenFromCredentials, fetchWithImagePreviews } from "./server"

describe("authFromToken", () => {
  test("decodes basic auth credentials from auth_token", () => {
    expect(authFromToken(btoa("kit:secret"))).toEqual({ username: "kit", password: "secret" })
  })

  test("defaults blank username to opencode", () => {
    expect(authFromToken(btoa(":secret"))).toEqual({ username: "opencode", password: "secret" })
  })

  test("ignores malformed tokens", () => {
    expect(authFromToken("not base64")).toBeUndefined()
    expect(authFromToken(btoa("missing-separator"))).toBeUndefined()
  })
})

describe("authTokenFromCredentials", () => {
  test("encodes credentials with the default username", () => {
    expect(authTokenFromCredentials({ password: "secret" })).toBe(btoa("opencode:secret"))
  })
})

describe("fetchWithImagePreviews", () => {
  function capture() {
    const requests: { url: string; init?: RequestInit; request?: Request }[] = []
    const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        init,
        request: input instanceof Request ? input : undefined,
      })
      return new Response("{}")
    }) as unknown as typeof globalThis.fetch
    return { requests, wrapped: fetchWithImagePreviews(base) }
  }

  test("tags the routes that can swap a shown image for its preview", async () => {
    const { requests, wrapped } = capture()
    await wrapped("http://127.0.0.1:4446/api/event")
    await wrapped("http://127.0.0.1:4446/api/session/ses_1/message?limit=2")
    await wrapped("http://127.0.0.1:4446/global/event")
    await wrapped("http://127.0.0.1:4446/session/ses_1/message")

    expect(requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:4446/api/event?imagePreviews=thumbnail",
      "http://127.0.0.1:4446/api/session/ses_1/message?limit=2&imagePreviews=thumbnail",
      "http://127.0.0.1:4446/global/event?imagePreviews=thumbnail",
      "http://127.0.0.1:4446/session/ses_1/message?imagePreviews=thumbnail",
    ])
  })

  test("leaves routes the server does not project and requests that already chose a value alone", async () => {
    const { requests, wrapped } = capture()
    await wrapped("http://127.0.0.1:4446/api/session/ses_1")
    await wrapped("http://127.0.0.1:4446/api/session/ses_1/message/msg_1")
    await wrapped("http://127.0.0.1:4446/api/event?imagePreviews=full")

    expect(requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:4446/api/session/ses_1",
      "http://127.0.0.1:4446/api/session/ses_1/message/msg_1",
      "http://127.0.0.1:4446/api/event?imagePreviews=full",
    ])
  })

  test("passes the request init through", async () => {
    const { requests, wrapped } = capture()
    const signal = new AbortController().signal
    await wrapped("http://127.0.0.1:4446/api/event", { signal })

    expect(requests[0]?.init?.signal).toBe(signal)
  })

  test("keeps the fields of a Request input while tagging its url", async () => {
    const { requests, wrapped } = capture()
    const signal = new AbortController().signal
    const input = new Request("http://127.0.0.1:4446/api/event?limit=1", {
      method: "POST",
      headers: { "x-test": "1" },
      body: "payload",
      signal,
    })

    await wrapped(input)

    const sent = requests[0]?.request
    expect(requests[0]?.url).toBe("http://127.0.0.1:4446/api/event?limit=1&imagePreviews=thumbnail")
    expect(sent?.method).toBe("POST")
    expect(sent?.headers.get("x-test")).toBe("1")
    expect(sent?.signal).toBe(signal)
    expect(await sent?.clone().text()).toBe("payload")
  })
})
