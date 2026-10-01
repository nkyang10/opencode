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
  // Where the spoken narration is rendered. Server-side and config-file only: the client is told the content
  // hash of a file that already exists and never chooses where it came from, so this cannot be steered by a
  // request. An absent section means the shipped defaults, so the feature works with no configuration at all.
  speech: Schema.optional(
    Schema.Struct({
      host: Schema.optional(Schema.String).annotate({
        description: "host:port of the text-to-speech service. Defaults to 192.168.1.162:8880",
      }),
      voice: Schema.optional(Schema.String).annotate({
        description: "Voice name or alias passed to the speech service. Defaults to cantonese",
      }),
      retention: Schema.optional(PositiveInt).annotate({
        description: "Stored audio files to keep per session. Defaults to 100",
      }),
      maxBytes: Schema.optional(PositiveInt).annotate({
        description: "Total bytes of stored narration to keep across all sessions. Defaults to 536870912",
      }),
    }),
  ).annotate({ description: "Where and how the commentary narration is spoken" }),
  // The two lines that are not narration: one when the agent stops, one when it is blocked on a decision.
  // Both are worth a model call because the alternative is a panel that simply stops, which reads as a crash.
  special: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean).annotate({
        description: "Produce a closing line when the agent stops and a prompt line when it needs a decision. Defaults to true",
      }),
      minGap: Schema.optional(PositiveInt).annotate({
        description: "Minimum milliseconds between two special lines. Defaults to 30000",
      }),
    }),
  ).annotate({ description: "The non-narration commentary lines" }),
}).annotate({ identifier: "CommentaryConfig" })
export type Commentary = Schema.Schema.Type<typeof Commentary>
