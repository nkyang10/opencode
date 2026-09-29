import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260929034850_nice_micromax",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_commentary\` (
          \`session_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`time\` integer NOT NULL,
          \`text\` text NOT NULL,
          \`anchor\` text NOT NULL,
          CONSTRAINT \`session_commentary_pk\` PRIMARY KEY(\`session_id\`, \`seq\`),
          CONSTRAINT \`fk_session_commentary_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
