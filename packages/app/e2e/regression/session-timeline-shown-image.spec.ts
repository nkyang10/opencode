import { expect, test, type Page } from "@playwright/test"
import {
  assistantMessage,
  setupTimeline,
  toolPart,
  userMessage,
  widePng,
} from "../performance/timeline-stability/fixture"

type Attachment = { id: string; type: "file"; mime: string; filename: string; url: string }

const shownID = "prt_shown"

function attachment(id: string, filename: string, url: string, mime = "image/png"): Attachment {
  return { id, type: "file", mime, filename, url }
}

function shownPart() {
  return toolPart(
    shownID,
    "show_image",
    "completed",
    { path: "/tmp/opencode/home.png" },
    {
      title: "show_image",
      output: "Shown to the user: home.png (PNG, 1200x600, 139 KB).",
      metadata: {
        path: "/tmp/opencode/home.png",
        name: "home.png",
        mime: "image/png",
        width: 1200,
        height: 600,
        bytes: 142000,
        caption: "Home page",
        shown: true,
      },
      attachments: [attachment("prt_shown_file", "home.png", widePng)],
    },
  )
}

function messages() {
  return [userMessage(), assistantMessage([shownPart()])]
}

function part(page: Page) {
  return page.locator(`[data-timeline-part-id="${shownID}"]`)
}

function card(page: Page) {
  return part(page).locator('[data-component="shown-image-card"]')
}

function preview(page: Page) {
  return card(page).locator('[data-slot="shown-image-card-image"]')
}

function previewImage(page: Page) {
  return card(page).locator('[data-slot="shown-image-card-image-content"]')
}

function viewer(page: Page) {
  return page.locator('[data-component="image-viewer"]')
}

function menu(page: Page) {
  return page.getByRole("menu")
}

function timelineScroller(page: Page) {
  return page.locator(".scroll-view__viewport").filter({ has: page.locator("[data-timeline-row]") })
}

async function expectNoHorizontalOverflow(page: Page) {
  const scroller = timelineScroller(page)
  await expect(scroller).toBeVisible()
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1)
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1)
}

async function expectTwoToOneRatio(page: Page) {
  const rect = await previewImage(page).evaluate((element) => element.getBoundingClientRect())
  expect(Math.abs(rect.width / rect.height - 2)).toBeLessThan(0.1)
}

test("renders the shown-image card without expanding or grouping the tool row", async ({ page }) => {
  await setupTimeline(page, {
    viewport: { width: 1280, height: 900 },
    messages: messages(),
  })

  const cardRoot = card(page)
  await expect(cardRoot).toBeVisible()
  await expect(part(page).locator('xpath=ancestor::*[@data-component="context-tool-group-list"]')).toHaveCount(0)
  await expect(part(page).locator('[data-component="tool-media"]')).toHaveCount(0)

  await expect(cardRoot.locator('[data-slot="shown-image-card-title"]')).toHaveText("Home page")
  const meta = cardRoot.locator('[data-slot="shown-image-card-meta"]')
  await expect(meta).toContainText("home.png")
  await expect(meta).toContainText("1200 × 600")

  const button = preview(page)
  await expect(button).toHaveAttribute("aria-label", "Open image: Home page")
  await expect(previewImage(page)).toBeVisible()
  await expect(previewImage(page)).toHaveCSS("max-height", "360px")
  await expectTwoToOneRatio(page)
  await expectNoHorizontalOverflow(page)

  await previewImage(page).scrollIntoViewIfNeeded()
  await previewImage(page).evaluate((element) => (element as HTMLImageElement).decode())
  const height = await part(page).evaluate((element) => element.getBoundingClientRect().height)
  await expect.poll(() => part(page).evaluate((element) => element.getBoundingClientRect().height)).toBe(height)

  await button.click()
  await expect(viewer(page)).toBeVisible()
  await expect(viewer(page).locator('[data-slot="image-viewer-title"]')).toHaveText("Home page")
  await expect(viewer(page).locator('[data-slot="image-viewer-dimensions"]')).toContainText("1200 × 600")
  await expect(viewer(page).locator('[data-slot="image-viewer-source"]')).toHaveText(
    "show_image · /tmp/opencode/home.png",
  )
  await page.keyboard.press("Escape")
  await expect(viewer(page)).toHaveCount(0)
  await expect(button).toBeFocused()
})

test("keeps the shown-image card inside the timeline at 390x844", async ({ page }) => {
  await setupTimeline(page, {
    viewport: { width: 390, height: 844 },
    messages: messages(),
  })

  await expect(card(page)).toBeVisible()
  await expect(previewImage(page)).toHaveCSS("max-height", "240px")
  await expectTwoToOneRatio(page)
  await expectNoHorizontalOverflow(page)
})

test("offers image actions and the viewer menu for the shown image", async ({ page, context, baseURL }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: baseURL ?? "http://127.0.0.1:3000",
  })
  await setupTimeline(page, { messages: messages() })

  const actions = card(page).locator('[data-slot="shown-image-card-actions"] [data-action="image-actions-menu"]')
  await actions.click()
  await expect(menu(page)).toBeVisible()
  await expect(menu(page).getByRole("menuitem", { name: "Copy path", exact: true })).toBeVisible()
  await expect(menu(page).getByRole("menuitem", { name: "Copy image", exact: true })).toBeVisible()
  await expect(menu(page).getByRole("menuitem", { name: "Save image", exact: true })).toBeVisible()

  await menu(page).getByRole("menuitem", { name: "Copy path", exact: true }).click()
  await expect(menu(page)).toHaveCount(0)
  const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => undefined)
  if (copied === undefined) test.skip(true, "This browser context cannot read the clipboard")
  expect(copied).toBe("/tmp/opencode/home.png")

  await actions.click()
  const downloadPromise = page.waitForEvent("download")
  await menu(page).getByRole("menuitem", { name: "Save image", exact: true }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^home-page-\d{8}-\d{6}\.png$/)
  await expect(menu(page)).toHaveCount(0)

  await preview(page).click()
  await expect(viewer(page)).toBeVisible()
  await viewer(page).locator('[data-action="image-viewer-actions"]').click()
  await expect(menu(page)).toBeVisible()
  await expect(menu(page).getByRole("menuitem", { name: "Copy path", exact: true })).toBeVisible()
  await expect(menu(page).getByRole("menuitem", { name: "Copy image", exact: true })).toBeVisible()
  await expect(menu(page).getByRole("menuitem", { name: "Save image", exact: true })).toBeVisible()
  await expect(menu(page).getByRole("menuitem", { name: "Go to message", exact: true })).toBeVisible()
})
