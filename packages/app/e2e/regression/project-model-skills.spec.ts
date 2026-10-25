import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/next"
const draftID = "draft_next_enhancements"
const server = `http://127.0.0.1:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const providers = ["opencode", "opencode-go", "custom"].map((id) => ({
  id,
  name: id,
  models: Object.fromEntries(
    ["one", "two"].map((suffix) => {
      const modelID = `${id}-${suffix}`
      return [modelID, { id: modelID, name: modelID, limit: { context: 200000 } }]
    }),
  ),
}))

async function setup(page: Page) {
  await mockOpenCodeServer(page, {
    protocol: "v2",
    directory,
    project: {
      id: "proj_next",
      worktree: directory,
      vcs: "git",
      name: "Next",
      time: { created: 1, updated: 1 },
      sandboxes: [],
    },
    provider: {
      all: providers,
      connected: providers.map((item) => item.id),
      default: { providerID: "custom", modelID: "custom-one" },
    },
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/api/{provider,model,model/default}**", (route) => {
    const path = new URL(route.request().url()).pathname
    const data =
      path === "/api/provider"
        ? providers.map((provider) => ({ id: provider.id, name: provider.name }))
        : path === "/api/model/default"
          ? { id: "custom-one", providerID: "custom" }
          : providers.flatMap((provider) =>
              Object.values(provider.models).map((model) => ({
                ...model,
                providerID: provider.id,
                modelID: model.id,
                family: model.id,
                time: { released: Date.now() },
                cost: [],
                status: "active",
                enabled: true,
                capabilities: { tools: true, input: ["text"], output: ["text"] },
                variants: [],
              })),
            )
    return route.fulfill({ json: { data, location: { directory } } })
  })
  await page.route("**/api/project/current**", (route) => {
    const url = new URL(route.request().url())
    const target =
      url.searchParams.get("location[directory]") ??
      url.searchParams.get("directory") ??
      route.request().headers()["x-opencode-directory"] ??
      directory
    return route.fulfill({
      json: { id: target === directory ? "proj_next" : `proj_${encodeURIComponent(target)}`, directory: target },
    })
  })
  await page.addInitScript(
    ({ directory, draftID, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: {
            local: [
              { worktree: directory, expanded: true, lastUsed: 30 },
              { worktree: "C:/zebra", expanded: true, lastUsed: 20 },
              { worktree: "C:/beta", expanded: true },
              { worktree: "C:/alpha", expanded: true },
            ],
          },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([
          { type: "draft", draftID: "draft_neighbor", server, directory },
          { type: "draft", draftID, server, directory },
        ]),
      )
    },
    { directory, draftID, server },
  )
}

async function openDraft(page: Page) {
  await page.goto(`/new-session?draftId=${draftID}`)
  await expect(page.locator('[data-component="session-new-design"] [data-component="prompt-input"]')).toBeEditable()
}

test("project menu shows recent folders first, then alphabetical names, without duplicates", async ({ page }) => {
  await setup(page)
  await openDraft(page)
  await page.locator('[data-action="prompt-project"]').click()
  const menu = page.locator("#prompt-project-menu")
  await expect(menu.getByRole("menuitemradio").locator('[data-slot="dropdown-menu-item-label"]')).toHaveText([
    "Next",
    "zebra",
    "alpha",
    "beta",
  ])
  const search = menu.getByRole("textbox")
  await search.fill("a")
  await expect(menu.getByRole("menuitemradio").locator('[data-slot="dropdown-menu-item-label"]')).toHaveText([
    "zebra",
    "alpha",
    "beta",
  ])
  await search.press("Enter")
  await expect(menu).toHaveCount(0)
  await expect(page.locator('[data-action="prompt-project"]')).toContainText("zebra")
  await page.locator('[data-action="prompt-project"]').click()
  await expect(menu.getByRole("menuitemradio").nth(0)).toHaveAttribute("data-option-key", "project::C%3A%2Fzebra")
})

test("OpenCode groups start unchecked, while enabling one model survives reload", async ({ page }) => {
  await setup(page)
  await openDraft(page)
  await page.keyboard.press("Control+,")
  const dialog = page.locator(".settings-v2-dialog")
  await dialog.getByRole("tab", { name: "Models", exact: true }).click()
  for (const id of ["opencode", "opencode-go"]) {
    for (const suffix of ["one", "two"]) {
      await expect(dialog.getByRole("switch", { name: `${id}-${suffix}`, exact: true })).not.toBeChecked()
    }
  }
  const selected = dialog.getByRole("switch", { name: "opencode-one", exact: true })
  const control = dialog
    .locator('[data-component="switch"]')
    .filter({ has: page.getByRole("switch", { name: "opencode-one", exact: true }) })
    .locator('[data-slot="switch-control"]')
  await control.click()
  await expect(selected).toBeChecked()
  await control.click()
  await expect(selected).not.toBeChecked()
  await control.click()
  await expect(selected).toBeChecked()
  await expect(dialog.getByRole("switch", { name: "custom-one", exact: true })).toBeChecked()
  await page.reload()
  await expect(page.locator('[data-component="session-new-design"]')).toBeVisible()
  await page.keyboard.press("Control+,")
  await dialog.getByRole("tab", { name: "Models", exact: true }).click()
  await expect(selected).toBeChecked()
  await expect(dialog.getByRole("switch", { name: "opencode-two", exact: true })).not.toBeChecked()
})

test("new-session panel close icon closes only the active draft and selects its neighbor", async ({ page }) => {
  await setup(page)
  await openDraft(page)
  const close = page
    .locator('[data-component="session-new-design"]')
    .getByRole("button", { name: "Close tab", exact: true })
  await expect(close).toBeInViewport()
  await close.click()
  await expect(page).toHaveURL(/new-session\?draftId=draft_neighbor$/)
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem("opencode.window.browser.dat:tabs") ?? "[]").map(
          (item: { draftID: string }) => item.draftID,
        ),
      ),
    )
    .toEqual(["draft_neighbor"])
})

test("Skills lists, edits, toggles and removes real scoped API records", async ({ page }) => {
  await setup(page)
  let content = "# Original instructions"
  let enabled = true
  let removed = false
  let failSave = true
  const writes: string[] = []
  const skill = () => ({
    name: "review",
    description: "Review code",
    location: `${directory}/.opencode/skills/review/SKILL.md`,
    content,
    enabled,
  })
  await page.route("**/api/skill**", async (route) => {
    const url = new URL(route.request().url())
    const target =
      url.searchParams.get("location[directory]") ?? JSON.parse(url.searchParams.get("location") ?? "null")?.directory
    const method = route.request().method()
    if (method !== "GET" || target) expect(target).toBe(directory)
    if (method === "GET") return route.fulfill({ json: { data: removed ? [] : [skill()], location: { directory } } })
    writes.push(`${method} ${url.pathname}`)
    if (url.pathname.endsWith("/enabled")) enabled = route.request().postDataJSON().enabled
    else if (method === "DELETE") {
      removed = true
      return route.fulfill({ status: 204 })
    } else {
      if (failSave) return route.fulfill({ status: 500, json: { message: "Test save failure" } })
      content = route.request().postDataJSON().content
    }
    return route.fulfill({ json: { data: skill(), location: { directory } } })
  })
  await page.goto("/")
  await page.getByRole("button", { name: "Skills", exact: true }).click()
  const row = page.locator('[data-component="home-skill-row"]')
  await expect(row).toContainText("review")
  await row.getByTitle("Edit skill", { exact: true }).click()
  const editor = row.locator("textarea")
  await editor.fill("# Updated instructions")
  await row.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByText("Request failed", { exact: true })).toBeVisible()
  await expect(editor).toHaveValue("# Updated instructions")
  failSave = false
  await row.getByRole("button", { name: "Save", exact: true }).click()
  await expect(editor).toHaveCount(0)
  await row.getByTitle("Edit skill", { exact: true }).click()
  await expect(editor).toHaveValue("# Updated instructions")
  await row.getByRole("button", { name: "Cancel", exact: true }).click()
  await row.getByRole("button", { name: "Disabled", exact: true }).click()
  await expect(row.getByRole("button", { name: "Enabled", exact: true })).toHaveAttribute("aria-pressed", "false")
  await row.getByTitle("Delete skill", { exact: true }).click()
  await row.locator('[data-component="home-skill-delete-confirm"]').click()
  await expect(row).toHaveCount(0)
  await expect(page.getByText("No skills yet", { exact: true })).toBeVisible()
  expect(writes).toEqual([
    "POST /api/skill/review",
    "POST /api/skill/review",
    "POST /api/skill/review/enabled",
    "DELETE /api/skill/review",
  ])
})

test("Skills request failures show an error rather than a misleading empty list", async ({ page }) => {
  await setup(page)
  await page.route("**/api/skill**", (route) => route.fulfill({ status: 500, json: { message: "Unavailable" } }))
  await page.goto("/")
  await page.getByRole("button", { name: "Skills", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Request failed")
  await expect(page.getByText("No skills yet", { exact: true })).toHaveCount(0)
})

test("Skills switches project scope without reusing another project's list", async ({ page }) => {
  await setup(page)
  const other = "C:/OpenCode/other-skills"
  await page.route(
    (url) => url.pathname === "/api/project",
    (route) =>
      route.fulfill({
        json: [
          { id: "proj_next", worktree: directory, name: "Next", time: { created: 1, updated: 1 }, sandboxes: [] },
          {
            id: "proj_other",
            worktree: other,
            name: "Other skills project",
            time: { created: 1, updated: 1 },
            sandboxes: [],
          },
        ],
      }),
  )
  await page.route("**/api/skill**", (route) => {
    const url = new URL(route.request().url())
    const target = url.searchParams.get("location[directory]") ?? directory
    return route.fulfill({
      json: {
        location: { directory: target },
        data: [
          {
            name: target === other ? "other-only-skill" : "next-only-skill",
            location: `${target}/SKILL.md`,
            content: "Instructions",
            enabled: true,
          },
        ],
      },
    })
  })
  await page.goto("/")
  await page.getByRole("button", { name: "Skills", exact: true }).click()
  const rows = page.locator('[data-component="home-skill-row"]')
  await expect(rows).toContainText("next-only-skill")
  await page.getByRole("button", { name: "Projects", exact: true }).click()
  await page.locator('[data-component="home-project-row"]').filter({ hasText: "Other skills project" }).click()
  await page.getByRole("button", { name: "Skills", exact: true }).click()
  await expect(page.locator('[data-component="home-skills-location"]')).toHaveText(other)
  await expect(rows).toContainText("other-only-skill")
  await expect(rows).not.toContainText("next-only-skill")
})
