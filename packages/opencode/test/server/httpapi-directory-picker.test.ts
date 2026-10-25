import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Layer } from "effect"
import path from "path"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, request, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(LayerNode.compile(FSUtil.node), httpApiLayer))

it.effect("serves actual directory roots through the declared global endpoint", () =>
  Effect.gen(function* () {
    const response = yield* request("/global/directory/roots")
    expect(response.status).toBe(200)
    if (process.platform !== "win32") expect(yield* response.json).toEqual({ windows: false, roots: ["/"] })
  }),
)

it.effect("creates a single selected child and returns typed failures for invalid or existing names", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const create = (name: string) =>
      request("/global/directory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parent: directory, name }),
      })
    const created = yield* create("new project")
    expect(created.status).toBe(200)
    expect(yield* created.json).toEqual({ directory: path.join(directory, "new project") })
    expect((yield* create("new project")).status).toBe(400)
    expect((yield* create("../escape")).status).toBe(400)
  }),
)

it.effect("reports the current directory's loaded configuration through HTTP", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const file = path.join(directory, "opencode.json")
    yield* FSUtil.use.writeWithDirs(file, JSON.stringify({ username: "config-source-test" }))
    const response = yield* requestInDirectory("/config/sources", directory)
    expect(response.status).toBe(200)
    expect(yield* response.json).toContain(file)
  }),
)

it.effect("advertises unsupported restart honestly and returns a declared error without stopping the host", () =>
  Effect.gen(function* () {
    const status = yield* request("/global/maintenance")
    expect(status.status).toBe(200)
    expect(yield* status.json).toEqual({ restartSupported: false, restarting: false })
    const restart = yield* request("/global/restart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
    expect(restart.status).toBe(409)
    expect(yield* restart.json).toMatchObject({ _tag: "ServerRestartUnavailable" })
  }),
)
