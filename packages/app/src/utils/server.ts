import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { OpenCode, type OpenCodeClient } from "@opencode-ai/client/promise"
import type { ServerConnection } from "@/context/server"
import type { SessionCommentaryEvent } from "@opencode-ai/schema/session-commentary-event"
import { decode64 } from "@/utils/base64"

export function authTokenFromCredentials(input: { username?: string; password: string }) {
  return btoa(`${input.username ?? "opencode"}:${input.password}`)
}

export function authFromToken(token: string | null) {
  const decoded = decode64(token ?? undefined)
  if (!decoded) return
  const separator = decoded.indexOf(":")
  if (separator === -1) return
  return {
    username: decoded.slice(0, separator) || "opencode",
    password: decoded.slice(separator + 1),
  }
}

export function createSdkForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createOpencodeClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
}) {
  const auth = (() => {
    if (!server.password) return
    return {
      Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
    }
  })()

  return createOpencodeClient({
    ...config,
    headers: {
      ...(config.headers instanceof Headers ? Object.fromEntries(config.headers.entries()) : config.headers),
      ...auth,
    },
    baseUrl: server.url,
  })
}

export function createApiForServer(input: {
  server: ServerConnection.HttpBase
  fetch?: typeof globalThis.fetch
}): OpenCodeClient {
  return OpenCode.make({
    baseUrl: input.server.url,
    fetch: input.fetch,
    headers: input.server.password
      ? {
          Authorization: `Basic ${authTokenFromCredentials({
            username: input.server.username,
            password: input.server.password,
          })}`,
        }
      : undefined,
  })
}

export type ServerApi = OpenCodeClient

/**
 * Directories the server recorded for one project.
 *
 * `GET /project/{projectID}/directories` is a server route the generated client does not
 * cover (it is not part of the default protocol API), and the v1 compatibility layer
 * answers `project.directories` with `worktree.list()` — the sandbox worktrees of the
 * *current* instance, a different set. The directories recorded under the shared `global`
 * project are the plain working folders (folders without a git repository) that the Home
 * list has to show, and this route is the only place they are exposed, so it is called
 * directly. Same auth as the SDK clients.
 */
export async function fetchProjectDirectories(input: {
  server: ServerConnection.HttpBase
  projectID: string
  fetch?: typeof globalThis.fetch
}) {
  const response = await (input.fetch ?? globalThis.fetch)(
    `${input.server.url}/project/${encodeURIComponent(input.projectID)}/directories`,
    {
      headers: input.server.password
        ? {
          Authorization: `Basic ${authTokenFromCredentials({
            username: input.server.username,
            password: input.server.password,
          })}`,
        }
        : undefined,
    },
  )
  if (!response.ok) throw new Error(`Failed to load project directories: ${response.status}`)
  const rows = (await response.json()) as { directory?: string }[]
  return rows.map((row) => row.directory).filter((directory): directory is string => !!directory)
}

/** FE-023: what the Admin settings rows need to stay honest about the web UI server. */
export type WebuiStatus = {
  /** `server.port` in the global config, or null when it was never set. */
  configuredPort: number | null
  /** The port the Admin tab offers as the default (the fork's 4446). */
  defaultPort: number
  /** The port the listener actually bound, or null when no socket is bound. */
  runningPort: number | null
  runningHostname: string | null
  autoStart: boolean
  /** A configured port that only differs from the running one — a restart applies it. */
  restartRequired: boolean
}

/**
 * `GET /global/webui` is a declared route on the global API, so it is in the OpenAPI
 * document, but the generated clients the app uses are not regenerated for every server
 * change, so this one is called directly (same precedent as `fetchProjectDirectories`
 * above). Same Basic auth as the SDK clients.
 */
export async function fetchWebuiStatus(input: {
  server: ServerConnection.HttpBase
  fetch?: typeof globalThis.fetch
}): Promise<WebuiStatus | undefined> {
  const response = await (input.fetch ?? globalThis.fetch)(`${input.server.url}/global/webui`, {
    headers: input.server.password
      ? {
          Authorization: `Basic ${authTokenFromCredentials({
            username: input.server.username,
            password: input.server.password,
          })}`,
        }
      : undefined,
  })
  if (!response.ok) return undefined
  return (await response.json()) as WebuiStatus
}

// FE-028: the commentary routes are called with a hand-rolled fetch rather than the generated client, the
// same way `fetchWebuiStatus` does it — the lease has to be refreshable from a timer and released with
// `navigator.sendBeacon` on pagehide, neither of which the generated client makes convenient.
export async function fetchCommentary(input: {
  server: ServerConnection.HttpBase
  sessionID: string
  limit?: number
  fetch?: typeof globalThis.fetch
}): Promise<SessionCommentaryEvent.Entry[]> {
  const query = input.limit === undefined ? "" : `?limit=${input.limit}`
  const response = await (input.fetch ?? globalThis.fetch)(
    `${input.server.url}/session/${input.sessionID}/commentary${query}`,
    {
      headers: input.server.password
        ? {
            Authorization: `Basic ${authTokenFromCredentials({
              username: input.server.username,
              password: input.server.password,
            })}`,
          }
        : undefined,
    },
  )
  if (!response.ok) return []
  return (await response.json()) as SessionCommentaryEvent.Entry[]
}

export async function setCommentaryWatch(input: {
  server: ServerConnection.HttpBase
  sessionID: string
  watching: boolean
  fetch?: typeof globalThis.fetch
}): Promise<void> {
  await (input.fetch ?? globalThis.fetch)(
    `${input.server.url}/session/${input.sessionID}/commentary/${input.watching ? "watch" : "unwatch"}`,
    {
      method: "POST",
      headers: input.server.password
        ? {
            Authorization: `Basic ${authTokenFromCredentials({
              username: input.server.username,
              password: input.server.password,
            })}`,
          }
        : undefined,
    },
  ).catch(() => undefined)
}
