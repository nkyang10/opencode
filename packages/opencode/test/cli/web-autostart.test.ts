import { describe, expect, test } from "bun:test"
import { WebuiAutostart } from "@/cli/web-autostart"

// FE-024: the auto-start policy is the only part of this feature that can be decided
// wrongly without anyone noticing (a machine that silently exposes an agent to the LAN,
// or one that never serves the web UI at all), so it is pinned here rather than left to
// a manual click-through.
describe("web auto start", () => {
  const base = { autoStart: true, alreadyListening: false, port: 4446, hostname: "0.0.0.0", secured: true }

  test("stays off unless the admin setting opted in", () => {
    expect(WebuiAutostart.resolveAutoStart({ ...base, autoStart: undefined })).toEqual({ listen: false })
    expect(WebuiAutostart.resolveAutoStart({ ...base, autoStart: false })).toEqual({ listen: false })
  })

  test("never starts a second listener", () => {
    expect(WebuiAutostart.resolveAutoStart({ ...base, alreadyListening: true })).toEqual({ listen: false })
  })

  test("binds the wildcard address when a password is configured", () => {
    expect(WebuiAutostart.resolveAutoStart({ ...base, secured: true })).toEqual({
      listen: true,
      port: 4446,
      hostname: "0.0.0.0",
      downgraded: false,
    })
  })

  test("refuses the wildcard address without a password and falls back to loopback", () => {
    expect(WebuiAutostart.resolveAutoStart({ ...base, secured: false })).toEqual({
      listen: true,
      port: 4446,
      hostname: "127.0.0.1",
      downgraded: true,
    })
  })

  test("leaves a loopback request alone even without a password", () => {
    expect(WebuiAutostart.resolveAutoStart({ ...base, hostname: "127.0.0.1", secured: false })).toEqual({
      listen: true,
      port: 4446,
      hostname: "127.0.0.1",
      downgraded: false,
    })
  })

  test("uses the configured port", () => {
    const target = WebuiAutostart.resolveAutoStart({ ...base, port: 4599 })
    expect(target).toEqual({ listen: true, port: 4599, hostname: "0.0.0.0", downgraded: false })
  })

  test("suggests the admin default port when the config sets none", () => {
    expect(WebuiAutostart.suggestedPort).toBe(4446)
  })

  test("reports what it did without binding anything when disabled", async () => {
    const result = await WebuiAutostart.autoStartWebServer({
      ...base,
      autoStart: false,
      listen: () => {
        throw new Error("must not listen")
      },
    })
    expect(result).toEqual({ started: false, reason: "disabled" })
  })

  test("passes the resolved address to the listener and reports network URLs", async () => {
    let seen: { port: number; hostname: string } | undefined
    const result = await WebuiAutostart.autoStartWebServer({
      ...base,
      listen: async (options) => {
        seen = options
        return { url: new URL(`http://${options.hostname}:${options.port}`), port: options.port }
      },
    })
    expect(seen).toEqual({ port: 4446, hostname: "0.0.0.0" })
    expect(result.started).toBe(true)
    if (!result.started) throw new Error("expected the listener to start")
    expect(result.url).toBe("http://0.0.0.0:4446/")
    expect(result.downgraded).toBe(false)
  })
})
