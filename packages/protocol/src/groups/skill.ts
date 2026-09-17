import { Skill } from "@opencode-ai/schema/skill"
import { Location } from "@opencode-ai/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"
import { InvalidRequestError, UnknownError } from "../errors"

const SkillName = Schema.NonEmptyString

export const SkillGroup = HttpApiGroup.make("server.skill")
  .add(
    HttpApiEndpoint.get("skill.list", "/api/skill", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Skill.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.skill.list",
          summary: "List skills",
          description: "Retrieve currently registered skills.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("skill.update", "/api/skill/:name", {
      params: { name: SkillName },
      query: LocationQuery,
      payload: Schema.Struct({ content: Schema.String }),
      success: Location.response(Skill.Info),
      error: [InvalidRequestError, UnknownError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.skill.update",
          summary: "Update skill",
          description: "Overwrite a skill's SKILL.md content. Re-enables a disabled skill.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("skill.setEnabled", "/api/skill/:name/enabled", {
      params: { name: SkillName },
      query: LocationQuery,
      payload: Schema.Struct({ enabled: Schema.Boolean }),
      success: Location.response(Skill.Info),
      error: [InvalidRequestError, UnknownError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.skill.setEnabled",
          summary: "Enable or disable a skill",
          description: "Toggle a skill's enabled state via marker-file rename.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("skill.remove", "/api/skill/:name", {
      params: { name: SkillName },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
      error: [InvalidRequestError, UnknownError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.skill.remove",
          summary: "Remove skill",
          description: "Delete a skill's SKILL.md file from disk.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "skills",
      description: "Skill management routes.",
    }),
  )
