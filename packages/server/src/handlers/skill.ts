import { SkillV2 } from "@opencode-ai/core/skill"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { InvalidRequestError, UnknownError } from "@opencode-ai/protocol/errors"
import { response } from "../location"
import { Effect } from "effect"

const toHttpError = (error: SkillV2.InvalidError | Error) => {
  if (error instanceof SkillV2.InvalidError) {
    return new InvalidRequestError({ message: `${error.name}: ${error.reason}` })
  }
  return new UnknownError({ message: error.message })
}

const guarded = <A, R>(effect: Effect.Effect<A, SkillV2.InvalidError | Error, R>) =>
  effect.pipe(Effect.mapError(toHttpError))

export const SkillHandler = HttpApiBuilder.group(Api, "server.skill", (handlers) =>
  handlers
    .handle("skill.list", () => response(SkillV2.Service.use((skill) => skill.list())))
    .handle("skill.update", ({ payload, params }) =>
      response(
        guarded(SkillV2.Service.use((skill) => skill.update(params.name, payload.content))),
      ),
    )
    .handle("skill.setEnabled", ({ payload, params }) =>
      response(
        guarded(SkillV2.Service.use((skill) => skill.setEnabled(params.name, payload.enabled))),
      ),
    )
    .handle(
      "skill.remove",
      Effect.fn(function* ({ params }) {
        yield* guarded(SkillV2.Service.use((skill) => skill.remove(params.name)))
        return HttpApiSchema.NoContent.make()
      }),
    ),
)
