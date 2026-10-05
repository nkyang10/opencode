import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { EventV2 } from "@opencode-ai/core/event"
import { EventManifest } from "@/event-manifest"
import { InstanceDisposed } from "@/server/event"
import "@opencode-ai/core/account"
import "@/server/event"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import semver from "semver"
import { described } from "./metadata"

const GlobalHealth = Schema.Struct({
  healthy: Schema.Literal(true),
  version: Schema.String,
})

// FE-023: what the Admin settings section needs to render honest rows — the port
// stored in the global config, the port the listener actually bound, and whether
// those two disagree (which only a restart can fix).
const GlobalWebui = Schema.Struct({
  configuredPort: Schema.NullOr(Schema.Number),
  defaultPort: Schema.Number,
  runningPort: Schema.NullOr(Schema.Number),
  runningHostname: Schema.NullOr(Schema.String),
  autoStart: Schema.Boolean,
  restartRequired: Schema.Boolean,
})

const SyncEventSchemas = EventManifest.Latest.values()
  .flatMap((definition) => {
    if (!definition.durable) return []
    return [
      Schema.Struct({
        type: Schema.Literal("sync"),
        id: EventV2.ID,
        syncEvent: Schema.Struct({
          type: Schema.Literal(EventV2.versionedType(definition.type, definition.durable.version)),
          id: EventV2.ID,
          seq: Schema.Finite,
          aggregateID: Schema.String,
          data: definition.data,
        }),
      }).annotate({ identifier: `SyncEvent.${definition.type}` }),
    ]
  })
  .toArray()

const GlobalEventSchema = Schema.Struct({
  directory: Schema.String,
  project: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
  payload: Schema.Union([
    ...EventManifest.Latest.values()
      .map((definition) =>
        Schema.Struct({ id: EventV2.ID, type: Schema.Literal(definition.type), properties: definition.data }),
      )
      .toArray(),
    InstanceDisposed,
    ...SyncEventSchemas,
  ]),
}).annotate({ identifier: "GlobalEvent" })

export const GlobalUpgradeInput = Schema.Struct({
  target: Schema.String.check(
    Schema.makeFilter((value) => (semver.valid(value) === null ? "Expected a semantic version" : undefined)),
  ),
})

const GlobalUpgradeResult = Schema.Union([
  Schema.Struct({
    success: Schema.Literal(true),
    version: Schema.String,
  }),
  Schema.Struct({
    success: Schema.Literal(false),
    error: Schema.String,
  }),
])

export const GlobalPaths = {
  health: "/global/health",
  event: "/global/event",
  config: "/global/config",
  webui: "/global/webui",
  dispose: "/global/dispose",
  upgrade: "/global/upgrade",
  lifecycle: "/global/lifecycle",
} as const

// s100: the restart window. `remainingMs` is a duration rather than a timestamp so a client with a
// skewed clock can still count the right seconds — see `server/lifecycle.ts`.
const GlobalLifecycle = Schema.Struct({
  draining: Schema.Boolean,
  remainingMs: Schema.NullOr(Schema.Number),
  reason: Schema.NullOr(Schema.String),
}).annotate({ identifier: "GlobalLifecycle" })

const GlobalLifecycleInput = Schema.Struct({
  timeoutMs: Schema.optional(Schema.Finite),
  reason: Schema.optional(Schema.String),
})

export const GlobalApi = HttpApi.make("global").add(
  HttpApiGroup.make("global")
    .add(
      HttpApiEndpoint.get("health", GlobalPaths.health, {
        success: described(GlobalHealth, "Health information"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.health",
          summary: "Get health",
          description: "Get health information about the OpenCode server.",
        }),
      ),
      HttpApiEndpoint.get("event", GlobalPaths.event, {
        success: GlobalEventSchema,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.event",
          summary: "Get global events",
          description: "Subscribe to global events from the OpenCode system using server-sent events.",
        }),
      ),
      HttpApiEndpoint.get("configGet", GlobalPaths.config, {
        success: described(ConfigV1.Info, "Get global config info"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.get",
          summary: "Get global configuration",
          description: "Retrieve the current global OpenCode configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.patch("configUpdate", GlobalPaths.config, {
        payload: ConfigV1.Info,
        success: described(ConfigV1.Info, "Successfully updated global config"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.update",
          summary: "Update global configuration",
          description: "Update global OpenCode configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.get("webui", GlobalPaths.webui, {
        success: described(GlobalWebui, "Web interface server status"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.webui",
          summary: "Get web interface server status",
          description:
            "Get the configured web interface port and auto-start setting, the port the server is actually listening on, and whether a restart is needed to apply a port change.",
        }),
      ),
      HttpApiEndpoint.post("dispose", GlobalPaths.dispose, {
        success: described(Schema.Boolean, "Global disposed"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.dispose",
          summary: "Dispose instance",
          description: "Clean up and dispose all OpenCode instances, releasing all resources.",
        }),
      ),
      HttpApiEndpoint.get("lifecycle", GlobalPaths.lifecycle, {
        success: described(GlobalLifecycle, "Restart window status"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.lifecycle",
          summary: "Get restart window status",
          description:
            "Report whether the server has announced a restart, and how many milliseconds of the drain window are left. A client polls this to show a countdown that keeps running locally once the server stops answering.",
        }),
      ),
      HttpApiEndpoint.post("lifecycleArm", GlobalPaths.lifecycle, {
        payload: GlobalLifecycleInput,
        success: described(GlobalLifecycle, "Restart window status"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.lifecycle.arm",
          summary: "Announce a restart window",
          description:
            "Arm the drain window before stopping the server, so connected clients can count down, stop sending new prompts, and hold what the reader was trying to send.",
        }),
      ),
      HttpApiEndpoint.post("upgrade", GlobalPaths.upgrade, {
        payload: GlobalUpgradeInput,
        success: described(GlobalUpgradeResult, "Upgrade result"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.upgrade",
          summary: "Upgrade opencode",
          description: "Upgrade opencode to the specified version.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "global", description: "Global server routes." })),
)
