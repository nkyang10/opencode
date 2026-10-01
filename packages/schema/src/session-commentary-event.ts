export * as SessionCommentaryEvent from "./session-commentary-event"

import { Schema } from "effect"
import { Event } from "./event"
import { optional } from "./schema"
import { SessionID } from "./session-id"

/**
 * One narration line about what the agent is doing. `anchor` is the last message the entry describes; the
 * next digest is everything strictly after it, so the cursor is read off the newest row rather than stored.
 *
 * `audio` is the content hash of a pre-rendered MP3 of this line, or absent when there is none. The server
 * synthesizes the audio when the line is written and publishes the line again once the file exists, so a
 * client has to be able to tell "no audio for this line" from "audio not ready yet" — hence a real optional
 * field rather than something the client derives.
 *
 * `kind` separates the running narration from the two lines that are not narration: `closing` when the agent
 * stops, `prompt` when it is blocked on a decision. They are worth telling apart in the panel because one of
 * them is a request to the reader, not a statement about the work.
 */
export const Entry = Schema.Struct({
  seq: Schema.Finite.annotate({ description: "Per-session monotonically increasing entry number" }),
  time: Schema.Finite.annotate({ description: "Creation time of the entry, in epoch milliseconds" }),
  text: Schema.NonEmptyString.annotate({ description: "The narration line itself" }),
  anchor: Schema.String.annotate({ description: "Last message id this entry describes" }),
  kind: optional(
    Schema.Literals(["closing", "prompt"]).annotate({
      description:
        "What this line is: absent for ordinary narration, 'closing' when the agent finished, 'prompt' when it is blocked on a decision",
    }),
  ),
  audio: optional(
    Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/)).annotate({
      description: "Content hash of the pre-rendered audio for this line, or absent when none was rendered",
    }),
  ),
}).annotate({ identifier: "SessionCommentaryEntry" })
export interface Entry extends Schema.Schema.Type<typeof Entry> {}

export const Posted = Event.define({
  type: "session.commentary",
  schema: {
    sessionID: SessionID,
    entry: Entry,
  },
})

export const Definitions = Event.inventory(Posted)
