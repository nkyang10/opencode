import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/PauseV2"
const sessionID = "ses_pause_v2_regression"
const projectID = "proj_pause_v2_regression"

test("pause is server-owned, survives page reload, and resumes from the adjacent control", async ({ page }) => {
  let paused = false
  const updates: boolean[] = []
  await mockOpenCodeServer(page, {
    protocol: "v2",
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "pause-v2",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [
      {
        id: sessionID,
        slug: "pause-v2",
        projectID,
        directory,
        title: "Pause V2 regression",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
    sessionStatus: { [sessionID]: { type: "busy" } },
  })
  await page.route(`**/api/session/${sessionID}/pause`, async (route) => {
    if (route.request().method() === "POST") {
      paused = route.request().postDataJSON().paused
      updates.push(paused)
    }
    await route.fulfill({ json: { paused, waiting: paused } })
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const composer = page.locator('[data-component="prompt-input-v2"]')
  await expectAppVisible(composer)
  const pause = composer.getByRole("button", { name: "Pause", exact: true })
  await expect(pause).toBeEnabled()
  await pause.click()
  const resume = composer.getByRole("button", { name: "Resume", exact: true })
  await expect(resume).toBeEnabled()
  await expect(resume).toHaveAttribute("aria-pressed", "true")
  expect(updates).toEqual([true])
  await page.reload()
  await expect(resume).toBeEnabled()
  await expect(resume).toHaveAttribute("aria-pressed", "true")
  await resume.click()
  await expect(pause).toBeEnabled()
  await expect(pause).toHaveAttribute("aria-pressed", "false")
  expect(updates).toEqual([true, false])
})
