// FE-024: start the web-interface server when opencode starts.
//
// Enabled by the Admin settings row `server.webui.autoStart` in the global config
// (`~/.config/opencode/opencode.json(c)`), which is why the flag is opt-in: an
// existing install must not start growing a listening socket just because it was
// upgraded. The port comes from `server.port` (the same value the Admin port row
// writes), and an explicit `--port` still wins, because `resolveNetworkOptionsNoConfig`
// already applied it before this runs.
//
// Reachability policy: the admin row is about serving the UI to other devices, so the
// default hostname is the wildcard address — but only when a server password is
// configured. `opencode web --hostname 0.0.0.0` without one prints "server is
// unsecured" and exposes an unauthenticated agent to the whole network
// (`cli/cmd/web.ts`), and auto-start must not do that behind the user's back: without a
// password it falls back to loopback and says so.

import { Webui } from "@/server/webui"
import { networkInterfaces } from "node:os"

const WILDCARD = new Set(["0.0.0.0", "::", "[::]", "*"])

export type AutoStartResult =
  | { started: false; reason: "disabled" | "already-listening" }
  | {
      started: true
      url: string
      port: number
      hostname: string
      /** True when the requested wildcard address was refused because no password is set. */
      downgraded: boolean
      networkURLs: string[]
    }

/** Addresses other devices on the LAN can use, skipping loopback and Docker bridges. */
export function networkURLs(port: number) {
  const urls: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.internal) continue
      if (info.family !== "IPv4") continue
      if (info.address.startsWith("172.")) continue
      urls.push(`http://${info.address}:${port}`)
    }
  }
  return urls
}

/**
 * Decide whether to listen, and where, without binding anything. Split out from
 * {@link autoStartWebServer} so the policy (opt-in, password-gated wildcard) is
 * unit-testable without opening a socket.
 */
export function resolveAutoStart(input: {
  autoStart: boolean | undefined
  alreadyListening: boolean
  port: number
  hostname: string
  secured: boolean
}): { listen: false } | { listen: true; port: number; hostname: string; downgraded: boolean } {
  if (input.alreadyListening) return { listen: false }
  if (input.autoStart !== true) return { listen: false }
  const wildcard = WILDCARD.has(input.hostname)
  if (wildcard && !input.secured) return { listen: true, port: input.port, hostname: "127.0.0.1", downgraded: true }
  return { listen: true, port: input.port, hostname: input.hostname, downgraded: false }
}

/** The suggested port for auto-start when the config sets none. */
export const suggestedPort = Webui.DefaultPort

export async function autoStartWebServer(input: {
  autoStart: boolean | undefined
  alreadyListening: boolean
  port: number
  hostname: string
  secured: boolean
  listen: (options: { port: number; hostname: string }) => Promise<{ url: URL; port: number }>
}): Promise<AutoStartResult> {
  const target = resolveAutoStart(input)
  if (!target.listen) {
    return { started: false, reason: input.alreadyListening ? "already-listening" : "disabled" }
  }
  const listener = await input.listen({ port: target.port, hostname: target.hostname })
  return {
    started: true,
    url: listener.url.toString(),
    port: listener.port,
    hostname: target.hostname,
    downgraded: target.downgraded,
    networkURLs: WILDCARD.has(target.hostname) ? networkURLs(listener.port) : [],
  }
}

export * as WebuiAutostart from "./web-autostart"
