export * as ConfigSearch from "./search"

import { Schema } from "effect"

export const Info = Schema.Struct({
  serper: Schema.optional(
    Schema.Struct({
      key: Schema.optional(Schema.String.check(Schema.isPattern(/\S/))).annotate({
        description: "Server-side Serper API key. Enables built-in websearch for every model provider.",
      }),
    }),
  ),
})
