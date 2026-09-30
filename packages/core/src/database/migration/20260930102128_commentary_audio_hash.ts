import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260930102128_commentary_audio_hash",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_commentary\` ADD \`audio\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
