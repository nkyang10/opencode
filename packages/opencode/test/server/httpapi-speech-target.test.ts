import { describe, expect, test } from "bun:test"
import { DEFAULT_SPEECH_HOST, speechBaseUrl } from "@/server/routes/instance/httpapi/handlers/speech-target"

describe("speechBaseUrl", () => {
  // The feature is a LAN appliance, so these have to keep working.
  test.each([
    ["192.168.1.162:8880", "http://192.168.1.162:8880"],
    ["192.168.1.162", "http://192.168.1.162"],
    ["tts.local:8880", "http://tts.local:8880"],
    ["my-speech-box", "http://my-speech-box"],
    ["10.0.0.7:5000", "http://10.0.0.7:5000"],
  ])("accepts %s", (host, expected) => {
    expect(speechBaseUrl(host)).toBe(expected)
  })

  test("an unset or blank host falls back to the default", () => {
    expect(speechBaseUrl(undefined)).toBe(`http://${DEFAULT_SPEECH_HOST}`)
    expect(speechBaseUrl("")).toBe(`http://${DEFAULT_SPEECH_HOST}`)
    expect(speechBaseUrl("   ")).toBe(`http://${DEFAULT_SPEECH_HOST}`)
  })

  test("tolerates a trailing slash from a pasted URL", () => {
    expect(speechBaseUrl("192.168.1.162:8880/")).toBe("http://192.168.1.162:8880")
  })

  // SSRF: the host is caller-supplied, so each of these is a way to point the proxy somewhere it must not go.
  test.each([
    ["a cloud metadata address", "169.254.169.254"],
    ["any link-local address", "169.254.1.1:80"],
    ["loopback", "127.0.0.1:8880"],
    ["loopback by name", "localhost:8880"],
    ["a .localhost name", "box.localhost:8880"],
    ["the unspecified address", "0.0.0.0:8880"],
    ["port zero", "192.168.1.162:0"],
  ])("refuses %s", (_label, host) => {
    expect(speechBaseUrl(host)).toBeUndefined()
  })

  test.each([
    ["an embedded scheme", "http://169.254.169.254"],
    ["an https scheme", "https://example.com"],
    ["a path", "192.168.1.162:8880/v1/audio/speech"],
    ["a query", "192.168.1.162:8880?x=1"],
    ["credentials", "user:pass@192.168.1.162:8880"],
    ["an IPv6 literal", "[::1]:8880"],
    ["a non-numeric port", "192.168.1.162:http"],
    ["an oversized port", "192.168.1.162:99999"],
    ["whitespace inside", "192.168.1.162 :8880"],
  ])("refuses a host carrying %s", (_label, host) => {
    expect(speechBaseUrl(host)).toBeUndefined()
  })
})