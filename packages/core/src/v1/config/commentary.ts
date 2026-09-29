export * as ConfigCommentaryV1 from "./commentary"

import { Schema } from "effect"
import { PositiveInt } from "../../schema"

/**
 * FE-028: the live commentary narration. Every field is optional and the service owns the defaults, so an
 * empty `commentary: {}` behaves exactly like no section at all.
 *
 * `model` deliberately mirrors the `small_model` convention already used for the title generator: `"session"`
 * narrates on the model the turn is actually using, `"small"` on the provider's small model.
 */
export const Commentary = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Generate a live commentary narration while an agent is working. Defaults to true",
  }),
  interval: Schema.optional(PositiveInt).annotate({
    description: "Milliseconds between commentary checks. Defaults to 10000",
  }),
  model: Schema.optional(Schema.Literals(["session", "small"])).annotate({
    description:
      "Model that writes the commentary: 'session' uses the model the agent is using, 'small' uses the provider's small model. Defaults to 'session'",
  }),
  maxEntriesPerTurn: Schema.optional(PositiveInt).annotate({
    description: "Maximum commentary entries per user turn before the narration pauses. Defaults to 20",
  }),
  minActivityChars: Schema.optional(PositiveInt).annotate({
    description:
      "Minimum new activity, in characters, before the model is called at all. Most idle ticks are skipped by this. Defaults to 120",
  }),
  narrationHistory: Schema.optional(PositiveInt).annotate({
    description: "How many previous commentary entries are shown to the model for continuity. Defaults to 100",
  }),
  minGap: Schema.optional(PositiveInt).annotate({
    description:
      "Minimum milliseconds between two commentary entries for one session. Measured from the newest stored entry, so it survives a restart. Defaults to 10000",
  }),
}).annotate({ identifier: "CommentaryConfig" })
export type Commentary = Schema.Schema.Type<typeof Commentary>
