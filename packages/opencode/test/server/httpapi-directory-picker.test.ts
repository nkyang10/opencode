import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Layer } from "effect"
import path from "path"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, request } from "./httpapi-layer"

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
