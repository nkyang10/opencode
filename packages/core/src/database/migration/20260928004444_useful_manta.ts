import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260928004444_useful_manta",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE INDEX \`session_time_updated_id_idx\` ON \`session\` (\`time_updated\`,\`id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
