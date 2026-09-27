// FE-023: the web-interface server, as configured by the Admin settings section
// (`Settings > Admin`), which persists into the global config file
// (`~/.config/opencode/opencode.json(c)` under `server`).
//
// Two facts live here so the settings surface and the runtime agree:
//
// - `DefaultPort` is the port the Admin tab offers as the default. It is a
//   *suggestion stored in the config file*, not a compiled-in listen default: the
//   upstream listener still resolves an unconfigured port through
//   `Server.startWithPortFallback`, and an explicit `--port` always wins over both.
//   See `notes/plan-admin-settings.md` (D1 / DEC-050) in the ide control folder.
// - A port change only takes effect on the next start, so the status route reports
//   the configured port next to the port the listener actually bound, and the UI
//   turns the difference into a "restart to apply" hint.

export const DefaultPort = 4446

export * as Webui from "./webui"
