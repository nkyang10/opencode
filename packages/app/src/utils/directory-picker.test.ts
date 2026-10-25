import { expect, test } from "bun:test"
import { createPickerDirectory, fetchDirectoryRoots } from "./directory-picker"

const server = { url: "https://server.example/", username: "tester", password: "test-password" }

test("requests roots from the selected server with its authentication", async () => {
  const result = await fetchDirectoryRoots({
    server,
    fetch: async (url, options) => {
      expect(url).toBe("https://server.example/global/directory/roots")
      expect(new Headers(options?.headers).get("Authorization")).toBe(`Basic ${btoa("tester:test-password")}`)
      return Response.json({ windows: true, roots: ["C:\\", "D:\\"] })
    },
  })
  expect(result?.roots).toEqual(["C:\\", "D:\\"])
})

test("older or unreachable servers do not offer unsupported directory operations", async () => {
  expect(await fetchDirectoryRoots({ server, fetch: async () => new Response(null, { status: 404 }) })).toBeUndefined()
  expect(
    await fetchDirectoryRoots({
      server,
      fetch: async () => {
        throw new TypeError("offline")
      },
    }),
  ).toBeUndefined()
})

test("creation sends one parent/name pair and returns the server's actual path", async () => {
  const directory = await createPickerDirectory({
    server,
    parent: "D:\\Projects",
    name: "new folder",
    fetch: async (url, options) => {
      expect(url).toBe("https://server.example/global/directory")
      expect(options?.method).toBe("POST")
      expect(JSON.parse(String(options?.body))).toEqual({ parent: "D:\\Projects", name: "new folder" })
      return Response.json({ directory: "D:\\Projects\\new folder" })
    },
  })
  expect(directory).toBe("D:\\Projects\\new folder")
})

test("creation failures never return a path to open", async () => {
  await expect(
    createPickerDirectory({
      server,
      parent: "/projects",
      name: "existing",
      fetch: async () => new Response(null, { status: 400 }),
    }),
  ).rejects.toBeDefined()
})
