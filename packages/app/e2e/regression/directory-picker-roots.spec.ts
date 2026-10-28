import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

async function openPicker(page: Page, windows: boolean, waitForRoots?: Promise<void>) {
  const directory = windows ? "C:/work" : "/home/work"
  const server = `http://127.0.0.1:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  await mockOpenCodeServer(page, {
    protocol: "v2",
    directory,
    project: {
      id: "proj_roots",
      worktree: directory,
      vcs: "git",
      name: "work",
      time: { created: 1, updated: 1 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/global/directory/roots", async (route) => {
    await waitForRoots
    await route.fulfill({ json: { windows, roots: windows ? ["C:/", "D:/"] : ["/"] } })
  })
  await page.route("**/api/fs/list**", (route) => {
    const url = new URL(route.request().url())
    const target = (url.searchParams.get("location[directory]") ?? directory).replace(/\\/g, "/")
    const name = target === "D:/" ? "D-work" : target === "C:/" ? "C-work" : "mnt"
    const data = ["C:/", "D:/", "/"].includes(target)
      ? [{ name, path: `${target}${name}`, type: "directory", ignored: false }]
      : []
    return route.fulfill({ json: { data, location: { directory: target } } })
  })
  await page.addInitScript(
    ({ directory, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "draft", draftID: "draft_roots", server, directory }]),
      )
    },
    { directory, server },
  )
  await page.goto("/new-session?draftId=draft_roots")
  await expect(page.locator('[data-component="session-new-design"] [data-component="prompt-input"]')).toBeEditable()
  await page.locator('[data-action="prompt-project"]').click()
  await page.locator("#prompt-project-menu").getByRole("menuitem", { name: "Add project", exact: true }).click()
  const picker = page.getByRole("dialog").filter({ has: page.locator(".directory-picker-v2-browser") })
  await expect(picker.getByRole("combobox")).toBeEditable()
  return picker
}

test("Windows keeps This PC and all drives available while browsing C and D", async ({ page }) => {
  const picker = await openPicker(page, true)
  const locations = picker.getByRole("navigation", { name: "Root", exact: true })
  await expect(locations.getByRole("button", { name: "This PC", exact: true })).toBeVisible()
  await expect(picker.getByRole("tree").getByText("C-work", { exact: true })).toBeVisible()
  await locations.getByRole("button", { name: "D:/", exact: true }).click()
  await expect(picker.getByRole("combobox")).toHaveValue("D:\\")
  await expect(picker.getByRole("tree").getByText("D-work", { exact: true })).toBeVisible()
  await expect(locations.getByRole("button", { name: "C:/", exact: true })).toBeVisible()
  await expect(locations.getByRole("button", { name: "D:/", exact: true })).toHaveAttribute("aria-current", "location")
  await picker.getByRole("tree").getByText("D-work", { exact: true }).click()
  await expect(picker.locator(".directory-picker-v2-selection")).toHaveText("D:\\D-work")
  await expect(picker.getByRole("button", { name: "Select folder", exact: true })).toBeEnabled()
  await locations.getByRole("button", { name: "This PC", exact: true }).click()
  await expect(picker.getByRole("button", { name: "Select folder", exact: true })).toBeDisabled()
  await locations.getByRole("button", { name: "C:/", exact: true }).click()
  await expect(picker.getByRole("tree").getByText("C-work", { exact: true })).toBeVisible()
})

test("delayed drive discovery initializes the current root and all drive choices", async ({ page }) => {
  const roots = Promise.withResolvers<void>()
  const picker = await openPicker(page, true, roots.promise)
  await expect(picker.locator('[data-root-path="D:/"]')).toHaveCount(0)
  roots.resolve()
  const locations = picker.getByRole("navigation", { name: "Root", exact: true })
  await expect(locations.getByRole("button", { name: "D:/", exact: true })).toBeVisible()
  await expect(picker.getByRole("tree").getByText("C-work", { exact: true })).toBeVisible()
})

test("Linux exposes its filesystem root below the same top-level navigation", async ({ page }) => {
  const picker = await openPicker(page, false)
  const locations = picker.getByRole("navigation", { name: "Root", exact: true })
  await expect(locations.getByRole("button", { name: "Root", exact: true })).toBeVisible()
  await expect(locations.getByRole("button", { name: "/", exact: true })).toBeVisible()
  await expect(picker.getByRole("tree").getByText("mnt", { exact: true })).toBeVisible()
  await locations.getByRole("button", { name: "Root", exact: true }).click()
  await expect(picker.getByRole("tree")).toHaveCount(0)
  await locations.getByRole("button", { name: "/", exact: true }).click()
  await expect(picker.getByRole("tree").getByText("mnt", { exact: true })).toBeVisible()
})
