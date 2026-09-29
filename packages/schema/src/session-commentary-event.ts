export * as SessionCommentaryEvent from "./session-commentary-event"

import { Schema } from "effect"
import { Event } from "./event"
import { SessionID } from "./session-id"

/**
 * One narration line about what the agent is doing. `anchor` is the last message the entry describes; the
 * next digest is everything strictly after it, so the cursor is read off the newest row rather than stored.
 */
export const Entry = Schema.Struct({
  seq: Schema.Finite.annotate({ description: "Per-session monotonically increasing entry number" }),
  time: Schema.Finite.annotate({ description: "Creation time of the entry, in epoch milliseconds" }),
  text: Schema.NonEmptyString.annotate({ description: "The narration line itself" }),
  anchor: Schema.String.annotate({ description: "Last message id this entry describes" }),
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
