import { Effect } from "effect"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions, hasArg } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { WebuiAutostart } from "../web-autostart"
import { ServerLifecycle } from "@/server/lifecycle"
import open from "open"
import { networkInterfaces } from "os"

function getNetworkIPs() {
  const nets = networkInterfaces()
  const results: string[] = []

  for (const name of Object.keys(nets)) {
    const net = nets[name]
    if (!net) continue

    for (const netInfo of net) {
      // Skip internal and non-IPv4 addresses
      if (netInfo.internal || netInfo.family !== "IPv4") continue

      // Skip Docker bridge networks (typically 172.x.x.x)
      if (netInfo.address.startsWith("172.")) continue

      results.push(netInfo.address)
    }
  }

  return results
}

export const WebCommand = effectCmd({
  command: "web",
  builder: (yargs) =>
    withNetworkOptions(yargs).option("autostart", {
      type: "boolean",
      describe: "serve the web interface only when the admin setting server.webui.autoStart asks for it",
      default: false,
      hidden: true,
    }),
  describe: "start opencode server and open web interface",
  // Server loads instances per-request via x-opencode-directory header — no
  // ambient project InstanceContext needed at startup.
  instance: false,
  handler: Effect.fn("Cli.web")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    const opts = yield* resolveNetworkOptions(args)

    // s100: installed BEFORE the autostart branch — the desktop spawns `web --autostart`, and a
    // handler installed only after that branch would never run for those servers. The review that
    // caught this is the point: the unit suite was green while the desktop path stayed a hard kill.
    ServerLifecycle.installSignalDrain("webui")

    // FE-026: the desktop app spawns `opencode web --autostart` so the web interface is reachable from a
    // browser (or a phone) whenever it launches. The decision is the same policy the TUI path uses
    // (`cli/web-autostart.ts`), so there is one rule and it is unit-tested: opt-in only, the configured port,
    // and the wildcard address only when a password makes that safe. Two things are deliberately different from
    // a human-typed `web`: it never opens a browser (a desktop app launching a tab on every start is a
    // regression), and "disabled" is a silent exit rather than a banner.
    if (args.autostart) {
      const { Config } = yield* Effect.promise(() => import("@/config/config"))
      const global = yield* Config.Service.use((cfg) => cfg.getGlobal())
      const result = yield* Effect.promise(() =>
        WebuiAutostart.autoStartWebServer({
          autoStart: global.server?.webui?.autoStart,
          alreadyListening: false,
          // `opts.port` already resolved `server.port` from the global config; the Admin default is the
          // fallback so a bare `--autostart` lands on the port the settings tab shows, not upstream's 4096.
          port: opts.port || WebuiAutostart.suggestedPort,
          hostname: WebuiAutostart.autostartHostname({
            configured: global.server?.hostname,
            explicit: hasArg("--hostname") ? opts.hostname : undefined,
          }),
          // Same source `server/auth.ts` reads, so "secured" means what it means for the routes.
          secured: !!Flag.OPENCODE_SERVER_PASSWORD,
          listen: async (options) => {
            const listener = await Server.listen(options)
            return { url: listener.url, port: listener.port }
          },
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logError("[webui] auto-start failed", cause)
            return { started: false as const, reason: "failed" as const, port: 0, hostname: "" }
          }),
        ),
      )
      if (!result.started) {
        // A port clash must be traceable even though nobody is watching this console.
        if (result.reason === "failed")
          yield* Effect.logError(`[webui] auto-start could not bind port ${result.port} on ${result.hostname}`)
        return
      }
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Web UI:            ", UI.Style.TEXT_NORMAL, result.url)
      for (const url of result.networkURLs)
        UI.println(UI.Style.TEXT_INFO_BOLD + "  Network access:    ", UI.Style.TEXT_NORMAL, url)
      if (result.downgraded)
        UI.println(
          UI.Style.TEXT_WARNING_BOLD + "  !  ",
          UI.Style.TEXT_NORMAL,
          "server is unsecured (no OPENCODE_SERVER_PASSWORD), so the web UI is only reachable on localhost.",
        )
      yield* Effect.never
    }

    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      UI.println(UI.Style.TEXT_WARNING_BOLD + "!  OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const server = yield* Effect.promise(() => Server.listen(opts))
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()

    UI.println(UI.Style.TEXT_INFO_BOLD + "  Logs:             ", UI.Style.TEXT_NORMAL, Global.Path.log)

    if (opts.hostname === "0.0.0.0") {
      // Show localhost for local access
      const localhostUrl = `http://localhost:${server.port}`
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Local access:      ", UI.Style.TEXT_NORMAL, localhostUrl)

      // Show network IPs for remote access
      const networkIPs = getNetworkIPs()
      if (networkIPs.length > 0) {
        for (const ip of networkIPs) {
          UI.println(
            UI.Style.TEXT_INFO_BOLD + "  Network access:    ",
            UI.Style.TEXT_NORMAL,
            `http://${ip}:${server.port}`,
          )
        }
      }

      if (opts.mdns) {
        UI.println(
          UI.Style.TEXT_INFO_BOLD + "  mDNS:              ",
          UI.Style.TEXT_NORMAL,
          `${opts.mdnsDomain}:${server.port}`,
        )
      }

      // Open localhost in browser
      open(localhostUrl).catch(() => {})
    } else {
      const displayUrl = server.url.toString()
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Web interface:    ", UI.Style.TEXT_NORMAL, displayUrl)
      open(displayUrl).catch(() => {})
    }

    yield* Effect.never
  }),
})
