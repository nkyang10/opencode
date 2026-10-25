import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "./server"

export type DirectoryRoots = { windows: boolean; roots: string[] }

type Request = { server: ServerConnection.HttpBase; fetch?: (url: string, options?: RequestInit) => Promise<Response> }

function headers(server: ServerConnection.HttpBase) {
  return server.password
    ? { Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}` }
    : undefined
}

export async function fetchDirectoryRoots(input: Request): Promise<DirectoryRoots | undefined> {
  const response = await (input.fetch ?? globalThis.fetch)(
    `${input.server.url.replace(/\/+$/, "")}/global/directory/roots`,
    {
      headers: headers(input.server),
    },
  ).catch(() => undefined)
  // Older servers keep the existing single-root picker without offering unsupported creation.
  if (!response?.ok) return
  return (await response.json()) as DirectoryRoots
}

export async function createPickerDirectory(input: Request & { parent: string; name: string }): Promise<string> {
  const response = await (input.fetch ?? globalThis.fetch)(`${input.server.url.replace(/\/+$/, "")}/global/directory`, {
    method: "POST",
    headers: { ...headers(input.server), "Content-Type": "application/json" },
    body: JSON.stringify({ parent: input.parent, name: input.name }),
  })
  if (!response.ok) throw new Error(String(response.status))
  return ((await response.json()) as { directory: string }).directory
}
