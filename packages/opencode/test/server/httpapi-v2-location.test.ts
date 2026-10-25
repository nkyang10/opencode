import fs from "node:fs/promises"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { Context, Schema } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-opencode-directory", directory)
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${route}`, {
      ...init,
      headers,
    }),
    context,
  )
}

const Event = Schema.Struct({
  id: EventV2.ID,
  type: Schema.String,
  location: Schema.optional(Location.Ref),
  data: Schema.Unknown,
})

async function* eventStream(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const boundary = buffer.match(/(?:\r\n|\r|\n){2}/)
      if (!boundary || boundary.index === undefined) {
        const value = await reader.read()
        if (value.done) return
        buffer += decoder.decode(value.value, { stream: true })
        continue
      }

      const record = buffer.slice(0, boundary.index)
      buffer = buffer.slice(boundary.index + boundary[0].length)
      const data = record
        .split(/\r\n|\r|\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
      if (data.length) yield Schema.decodeUnknownSync(Event)(JSON.parse(data.join("\n")))
    }
  } finally {
    try {
      await reader.cancel()
    } finally {
      reader.releaseLock()
    }
  }
}

async function readEvent(reader: AsyncIterator<typeof Event.Type>) {
  const value = await reader.next()
  if (value.done) throw new Error("event stream closed")
  return value.value
}

async function readEventType(reader: AsyncIterator<typeof Event.Type>, type: string) {
  for (let index = 0; index < 20; index++) {
    const event = await readEvent(reader)
    if (event.type === type) return event
  }
  throw new Error(`timed out waiting for ${type}`)
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("v2 location HttpApi", () => {
  test("decodes EventV2 location refs without resolved project metadata", () => {
    expect(
      Schema.decodeUnknownSync(Event)({
        id: "evt_test",
        type: "file.watcher.updated",
        location: { directory: "/tmp/project" },
        data: {},
      }),
    ).toMatchObject({ location: { directory: "/tmp/project" } })
  })

  test("returns command and skill snapshots with resolved locations", async () => {
    await using tmp = await tmpdir({ git: true })

    for (const route of ["/api/command", "/api/skill"]) {
      const response = await request(route, tmp.path)
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        location: { directory: string; project: { id: string } }
        data: unknown
      }
      expect(body.data).toBeArray()
      expect(body.location.directory).toBe(tmp.path)
      expect(body.location.project.id).toBeTruthy()
    }
  })

  test("skill management preserves metadata and scopes writes to the selected project", async () => {
    await using first = await tmpdir({ git: true })
    await using second = await tmpdir({ git: true })
    const file = (directory: string) => path.join(directory, ".opencode", "skills", "review", "SKILL.md")
    for (const tmp of [first, second]) {
      await fs.mkdir(path.dirname(file(tmp.path)), { recursive: true })
      await fs.writeFile(
        file(tmp.path),
        "---\nname: review\ndescription: Review code\n# Preserve this comment\ncustom: keep\n---\n# Original",
      )
    }
    const json = { "Content-Type": "application/json" }
    const update = await request("/api/skill/review", first.path, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ content: "# New instructions" }),
    })
    expect(update.status).toBe(200)
    expect(await update.json()).toMatchObject({
      data: { name: "review", description: "Review code", content: "# New instructions" },
    })
    const saved = await fs.readFile(file(first.path), "utf8")
    expect(saved).toContain("# Preserve this comment")
    expect(saved).toContain("custom: keep")
    expect(await fs.readFile(file(second.path), "utf8")).toContain("# Original")
    const disable = await request("/api/skill/review/enabled", first.path, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ enabled: false }),
    })
    expect(disable.status).toBe(200)
    expect(await disable.json()).toMatchObject({ data: { name: "review", enabled: false } })
    const list = await request("/api/skill", first.path)
    expect(await list.json()).toMatchObject({
      data: expect.arrayContaining([expect.objectContaining({ name: "review", enabled: false })]),
    })
    const remove = await request("/api/skill/review", first.path, { method: "DELETE" })
    expect(remove.status).toBe(204)
    expect(await fs.readFile(file(second.path), "utf8")).toContain("# Original")
  })

  test("skill changes invalidate shared skill caches in other project locations", async () => {
    await using first = await tmpdir({ git: true })
    await using second = await tmpdir({ git: true })
    await using shared = await tmpdir()
    await fs.mkdir(path.join(shared.path, "shared-review"), { recursive: true })
    await fs.writeFile(
      path.join(shared.path, "shared-review", "SKILL.md"),
      "---\nname: shared-review\ndescription: Shared review\n---\n# Shared",
    )
    for (const tmp of [first, second]) {
      await fs.writeFile(path.join(tmp.path, "opencode.json"), JSON.stringify({ skills: { paths: [shared.path] } }))
      const response = await request("/api/skill", tmp.path)
      expect(await response.json()).toMatchObject({
        data: expect.arrayContaining([expect.objectContaining({ name: "shared-review", enabled: true })]),
      })
    }
    const disable = await request("/api/skill/shared-review/enabled", first.path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    })
    expect(disable.status).toBe(200)
    const other = await request("/api/skill", second.path)
    expect(await other.json()).toMatchObject({
      data: expect.arrayContaining([expect.objectContaining({ name: "shared-review", enabled: false })]),
    })
  })

  test("streams native EventV2 payloads across locations", async () => {
    await using subscriber = await tmpdir({ git: true })
    await using publisher = await tmpdir({ git: true })
    const response = await request("/api/event", subscriber.path)
    const reader = eventStream(response.body!)
    const connected = await readEvent(reader)
    expect(connected.type).toBe("server.connected")
    expect(connected.location).toBeUndefined()

    const created = await request("/session", publisher.path, { method: "POST" })
    expect(created.status).toBe(200)
    expect(await readEventType(reader, "session.created")).toMatchObject({
      type: "session.created",
      location: { directory: publisher.path },
      data: { sessionID: expect.any(String) },
    })
    await reader.return(undefined)
  })
})
