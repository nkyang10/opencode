import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260930170517_commentary_special_kind",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_commentary\` ADD \`kind\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
