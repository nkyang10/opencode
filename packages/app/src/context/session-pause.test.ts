import { expect, test } from "bun:test"
import { requestSessionPause } from "./session-pause"

const server = { url: "https://server.example/", password: "test-password" }

test("reads server-owned pause state for the exact session", async () => {
  expect(
    await requestSessionPause({
      server,
      sessionID: "ses_test",
      fetch: async (url, options) => {
        expect(url).toBe("https://server.example/api/session/ses_test/pause")
        expect(options?.method).toBe("GET")
        expect(new Headers(options?.headers).get("Authorization")).toBe(`Basic ${btoa("opencode:test-password")}`)
        return Response.json({ paused: true, waiting: true })
      },
    }),
  ).toEqual({ paused: true, waiting: true })
})

test("sets a desired state rather than a race-prone server toggle", async () => {
  expect(
    await requestSessionPause({
      server,
      sessionID: "ses_test",
      paused: false,
      fetch: async (_url, options) => {
        expect(options?.method).toBe("POST")
        expect(JSON.parse(String(options?.body))).toEqual({ paused: false })
        return Response.json({ paused: false, waiting: false })
      },
    }),
  ).toEqual({ paused: false, waiting: false })
})

test("hides unsupported controls on old servers and propagates real failures", async () => {
  expect(
    await requestSessionPause({
      server,
      sessionID: "ses_test",
      fetch: async () => new Response(null, { status: 404 }),
    }),
  ).toBeUndefined()
  await expect(
    requestSessionPause({ server, sessionID: "ses_test", fetch: async () => new Response(null, { status: 500 }) }),
  ).rejects.toBeDefined()
})
