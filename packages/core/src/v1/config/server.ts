export * as ConfigServerV1 from "./server"

import { Schema } from "effect"
import { PositiveInt } from "../../schema"

// FE-023: rows edited in Settings > Admin, persisted in the global config file.
export const Webui = Schema.Struct({
  autoStart: Schema.optional(Schema.Boolean).annotate({
    description: "Start the web interface server when opencode starts",
  }),
}).annotate({ identifier: "ServerWebuiConfig" })
export type Webui = Schema.Schema.Type<typeof Webui>

export const Server = Schema.Struct({
  port: Schema.optional(PositiveInt).annotate({
    description: "Port to listen on",
  }),
  hostname: Schema.optional(Schema.String).annotate({ description: "Hostname to listen on" }),
  mdns: Schema.optional(Schema.Boolean).annotate({ description: "Enable mDNS service discovery" }),
  mdnsDomain: Schema.optional(Schema.String).annotate({
    description: "Custom domain name for mDNS service (default: opencode.local)",
  }),
  cors: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Additional domains to allow for CORS",
  }),
  webui: Schema.optional(Webui).annotate({ description: "Web interface server settings" }),
}).annotate({ identifier: "ServerConfig" })
export type Server = Schema.Schema.Type<typeof Server>
