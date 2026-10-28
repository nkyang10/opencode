import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/PauseV2"
const sessionID = "ses_pause_v2_regression"
const projectID = "proj_pause_v2_regression"

for (const width of [1280, 390]) {
  test(`stacked pause icons preserve server state and submission at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 })
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
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({ general: { newLayoutDesigns: true, shouldDisplayTabsToast: false } }),
      )
    })
    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
    const composer = page.locator('[data-component="prompt-input-v2"]')
    await expectAppVisible(composer)
    const pause = composer.getByRole("button", { name: "Pause", exact: true })
    await expect(pause).toBeEnabled()
    await expect(pause.locator("use")).toHaveAttribute("href", "#opencode-v2-icon-pause")
    const actions = composer.locator('[data-slot="prompt-actions"]')
    const submit = actions.locator('[data-action="prompt-submit"]')
    await expect(actions.getByRole("button")).toHaveCount(2)
    const boxes = await Promise.all([
      submit.boundingBox(),
      pause.boundingBox(),
      composer.getByRole("textbox").boundingBox(),
    ])
    const [sendBox, pauseBox, editorBox] = boxes
    if (!sendBox || !pauseBox || !editorBox) throw new Error("Composer controls have no bounds")
    expect(Math.abs(sendBox.x - pauseBox.x)).toBeLessThan(1)
    expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(pauseBox.y)
    expect(editorBox.x + editorBox.width).toBeLessThanOrEqual(sendBox.x)
    expect(sendBox.width).toBe(pauseBox.width)
    await expect(pause).toBeInViewport()
    await pause.click()
    const resume = composer.getByRole("button", { name: "Resume", exact: true })
    await expect(resume).toBeEnabled()
    await expect(resume).toHaveAttribute("aria-pressed", "true")
    expect(updates).toEqual([true])
    await expect(resume.locator("use")).toHaveAttribute("href", "#opencode-v2-icon-play")
    await composer.getByRole("textbox").fill("A new instruction remains available while paused")
    await expect(submit).toBeEnabled()
    await expect(submit).toHaveAccessibleName("Send")
    await page.screenshot({ path: testInfo.outputPath(`composer-stacked-${width}.png`) })
    await page.reload()
    await expect(resume).toBeEnabled()
    await expect(resume).toHaveAttribute("aria-pressed", "true")
    await resume.click()
    await expect(pause).toBeEnabled()
    await expect(pause).toHaveAttribute("aria-pressed", "false")
    expect(updates).toEqual([true, false])
  })
}
