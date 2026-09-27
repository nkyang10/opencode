import { expect, test, type Locator } from "@playwright/test"
import { assistantMessage, setupTimeline, userMessage } from "../performance/timeline-stability/fixture"

const CONTENT = '[data-component="session-turn-diffs-content"]'
const HEADER = '[data-slot="session-turn-diffs-header"]'

// The "N Changed files" group ships collapsed. One flag lives in the per-session layout store, so opening it
// survives a reload and a virtualised remount; a session that never touched it stays collapsed everywhere.
test.describe("regression: session timeline changed-files group", () => {
  test("is collapsed by default and opens on a header click", async ({ page }) => {
    await setup(page)

    const group = page.locator('[data-timeline-row="DiffSummary"]')
    const header = group.locator(HEADER)
    await expect(header).toBeVisible()
    await expect(header).toHaveAttribute("aria-expanded", "false")
    await expect(group.locator(CONTENT)).toHaveCount(0)

    await header.click()

    await expect(header).toHaveAttribute("aria-expanded", "true")
    await expect(group.locator(CONTENT)).toBeVisible()
    await expect(group.locator('[data-slot="session-turn-diff-trigger"]')).toHaveCount(3)
  })

  test("collapses again on a second header click", async ({ page }) => {
    await setup(page)

    const group = page.locator('[data-timeline-row="DiffSummary"]')
    const header = group.locator(HEADER)
    await header.click()
    await expect(group.locator(CONTENT)).toBeVisible()

    await header.click()

    await expect(header).toHaveAttribute("aria-expanded", "false")
    await expect(group.locator(CONTENT)).toHaveCount(0)
  })

  test("toggles from the keyboard and reports the count as its accessible name", async ({ page }) => {
    await setup(page)

    const group = page.locator('[data-timeline-row="DiffSummary"]')
    const header = group.locator(HEADER)
    await expect(header).toHaveAttribute("aria-label", "3 Changed files")

    await header.focus()
    await page.keyboard.press("Enter")
    await expect(group.locator(CONTENT)).toBeVisible()

    await page.keyboard.press(" ")
    await expect(group.locator(CONTENT)).toHaveCount(0)
  })

  test("a collapsed group is one row, and the collapsed row keeps the turn's line totals", async ({ page }) => {
    await setup(page)

    const group = page.locator('[data-timeline-row="DiffSummary"]')
    const height = await group.evaluate((element) => element.getBoundingClientRect().height)

    // The header is 44px; without the collapse the three file rows add hundreds of pixels.
    expect(height).toBeLessThan(80)
    await expect(group.locator('[data-slot="diff-changes-additions"]')).toHaveText("+3")
    await expect(group.locator('[data-slot="diff-changes-deletions"]')).toHaveText("-3")
  })

  test("keeps the group open across a reload", async ({ page }) => {
    await setup(page)

    const group = page.locator('[data-timeline-row="DiffSummary"]')
    await group.locator(HEADER).click()
    await expect(group.locator(CONTENT)).toBeVisible()
    // The store persists asynchronously, so wait for the write rather than racing the reload.
    await expect.poll(() => readPersistedOpen(page)).toBe(true)

    await page.reload()

    const reloaded = page.locator('[data-timeline-row="DiffSummary"]')
    await expect(reloaded.locator(HEADER)).toHaveAttribute("aria-expanded", "true")
    await expect(reloaded.locator(CONTENT)).toBeVisible()
  })

  test("the overflow control lifts the file cap without collapsing the group", async ({ page }) => {
    // 12 files, so the header grows a "Show all" control that lives inside the clickable header.
    await setup(page, 12)

    const group = page.locator('[data-timeline-row="DiffSummary"]')
    const header = group.locator(HEADER)
    await header.click()
    await expect(group.locator('[data-slot="session-turn-diff-trigger"]')).toHaveCount(10)

    const showAll = group.locator('[data-slot="session-turn-diffs-toggle"]')
    await expect(showAll).toBeVisible()
    await showAll.click()

    await expect(group.locator('[data-slot="session-turn-diff-trigger"]')).toHaveCount(12)
    // Regression guard: the control is a child of the header, so it must not bubble into the group toggle.
    await expect(header).toHaveAttribute("aria-expanded", "true")
    await expect(group.locator(CONTENT)).toBeVisible()
  })

  test("the overflow control is reachable by keyboard and visible when focused", async ({ page }) => {
    await setup(page, 12)

    const group = page.locator('[data-timeline-row="DiffSummary"]')
    await group.locator(HEADER).click()
    const showAll = group.locator('[data-slot="session-turn-diffs-toggle"]')

    await showAll.focus()

    await expect(showAll).toBeFocused()
    // The control is opacity: 0 until the group is hovered, so focus has to lift it for a keyboard user.
    await expect.poll(() => opacity(showAll)).toBe(1)
  })

  test("a rename only turn reports no line totals and still toggles", async ({ page }) => {
    await setup(page, 3, true)

    const group = page.locator('[data-timeline-row="DiffSummary"]')
    // DiffChanges renders only when additions + deletions > 0, so a pure rename shows no tally.
    await expect(group.locator('[data-component="diff-changes"]').first()).toHaveCount(0)

    await group.locator(HEADER).click()

    await expect(group.locator(CONTENT)).toBeVisible()
    await expect(group.locator('[data-slot="session-turn-diff-trigger"]')).toHaveCount(3)
  })
})

async function setup(page: Parameters<typeof setupTimeline>[0], count = 3, renameOnly = false) {
  await setupTimeline(page, {
    messages: [
      userMessage(undefined, {
        summary: {
          diffs: Array.from({ length: count }, (_, index) => ({
            file: `src/diff-${index}.ts`,
            additions: renameOnly ? 0 : 1,
            deletions: renameOnly ? 0 : 1,
            patch: `@@ -1 +1 @@\n-export const value = ${index}\n+export const value = ${index + 1}`,
          })),
        },
      }),
      assistantMessage(),
    ],
  })
}

function readPersistedOpen(page: Parameters<typeof setupTimeline>[0]) {
  return page.evaluate(() =>
    Object.entries(localStorage).some(
      ([key, value]) => key.includes("layout") && value.includes('"diffSummaryOpen":true'),
    ),
  )
}

function opacity(locator: Locator) {
  return locator.evaluate((element) => Number(window.getComputedStyle(element).opacity))
}
