import { expect, test, type Page } from "@playwright/test"
import {
  assistantMessage,
  setupTimeline,
  smallPng,
  textPart,
  toolPart,
  userMessage,
  widePng,
} from "../performance/timeline-stability/fixture"

type Attachment = { id: string; type: "file"; mime: string; filename: string; url: string }

const mcpID = "prt_images_mcp"
const readID = "prt_images_read"
const compactedID = "prt_images_compacted"
const chipsID = "prt_images_chips"
const previewID = "prt_images_preview"
const geometryID = "prt_images_geometry"
const answerID = "prt_images_answer"
const errorID = "prt_images_error"

function attachment(id: string, filename: string, url: string, mime = "image/png"): Attachment {
  return { id, type: "file", mime, filename, url }
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

test("renders v1 MCP and read tool images without expanding the tool rows", async ({ page }) => {
  await setupTimeline(page, {
    viewport: { width: 1280, height: 900 },
    messages: [
      userMessage(),
      assistantMessage([
        toolPart(
          mcpID,
          "mcp__browser__screenshot",
          "completed",
          { url: "https://example.com/shot" },
          {
            output: "Captured two screenshots",
            attachments: [
              attachment("prt_images_mcp_file_a", "screenshot-a.png", smallPng),
              attachment("prt_images_mcp_file_b", "screenshot-b.png", widePng),
            ],
          },
        ),
        toolPart(
          readID,
          "read",
          "completed",
          { filePath: "assets/logo.png" },
          {
            output: "Read image",
            attachments: [attachment("prt_images_read_file", "logo.png", smallPng)],
          },
        ),
      ]),
    ],
  })

  const mcp = page.locator(`[data-timeline-part-id="${mcpID}"]`)
  await expect(mcp).toBeVisible()
  const mcpImages = mcp.locator('[data-slot="tool-media-image"]')
  await expect(mcpImages).toHaveCount(2)
  await expect(mcp.locator('[data-component="tool-media"]')).toBeVisible()

  const labels = await mcpImages.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")))
  expect(labels).toEqual(["Open image: screenshot-a.png", "Open image: screenshot-b.png"])

  const heights = await mcpImages.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height))
  expect(heights.map((height) => Math.round(height))).toEqual([96, 96])

  const wide = await mcpImages.nth(1).evaluate((element) => element.getBoundingClientRect())
  expect(Math.round(wide.height)).toBe(96)
  expect(wide.width).toBeGreaterThan(96)
  expect(Math.abs(wide.width / wide.height - 2)).toBeLessThan(0.1)

  const group = page.locator(`[data-timeline-part-ids="${readID}"]`)
  await expect(group).toBeVisible()
  const groupTrigger = group.locator('[data-slot="collapsible-trigger"]')
  await expect(groupTrigger).toHaveAttribute("aria-expanded", "false")
  await groupTrigger.click()
  await expect(groupTrigger).toHaveAttribute("aria-expanded", "true")

  const readMedia = group.locator('[data-component="tool-media"]')
  await expect(readMedia).toHaveAttribute("data-compact", "true")
  const readImage = readMedia.locator('[data-slot="tool-media-image"]')
  await expect(readImage).toHaveCount(1)
  await expect(readImage).toHaveAttribute("aria-label", "Open image: logo.png")
  const readHeight = await readImage.evaluate((element) => element.getBoundingClientRect().height)
  expect(Math.round(readHeight)).toBe(64)

  await expect(page.locator('[data-component="tool-media"] [data-slot="tool-media-image"]')).toHaveCount(3)
  const allLabels = await page
    .locator('[data-component="tool-media"] [data-slot="tool-media-image"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")))
  expect(allLabels).toEqual(["Open image: screenshot-a.png", "Open image: screenshot-b.png", "Open image: logo.png"])
})

test("renders v2 current-message tool attachments", async ({ page }) => {
  await setupTimeline(page, {
    protocol: "v2",
    messages: [
      userMessage(),
      assistantMessage([
        toolPart(
          mcpID,
          "mcp__browser__screenshot",
          "completed",
          { url: "https://example.com/v2" },
          {
            output: "Captured a screenshot",
            attachments: [attachment("prt_images_v2_file", "v2-shot.png", smallPng)],
          },
        ),
      ]),
    ],
  })

  const part = page.locator(`[data-timeline-part-id="${mcpID}"]`)
  await expect(part).toBeVisible()
  const image = part.locator('[data-slot="tool-media-image"]')
  await expect(image).toHaveCount(1)
  await expect(image).toHaveAttribute("aria-label", "Open image: v2-shot.png")
  await expect(part.locator('[data-slot="tool-media-image-content"]')).toHaveAttribute("src", smallPng)
})

test("opens and closes a tool image viewer by mouse and keyboard", async ({ page }) => {
  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        toolPart(
          previewID,
          "mcp__browser__screenshot",
          "completed",
          { url: "https://example.com/preview" },
          {
            output: "Captured a screenshot",
            attachments: [attachment("prt_images_preview_file", "preview-shot.png", smallPng)],
          },
        ),
      ]),
    ],
  })

  const image = page.getByRole("button", { name: "Open image: preview-shot.png" })
  const viewer = page.locator('[data-component="image-viewer"]')
  await expect(image).toBeVisible()

  await image.click()
  await expect(viewer).toBeVisible()
  await expect(viewer.locator('[data-slot="image-viewer-image"]')).toHaveAttribute("src", smallPng)
  await page.keyboard.press("Escape")
  await expect(viewer).toBeHidden()
  await expect(viewer).toHaveCount(0)
  await expect(image).toBeFocused()

  await image.focus()
  await expect(image).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(viewer).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(viewer).toBeHidden()
  await expect(image).toBeFocused()
})

test("renders images from compacted completed tool parts", async ({ page }) => {
  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        toolPart(
          compactedID,
          "mcp__browser__screenshot",
          "completed",
          { url: "https://example.com/old" },
          {
            output: "Captured before compaction",
            compacted: 1700000002500,
            attachments: [attachment("prt_images_compacted_file", "compacted-shot.png", smallPng)],
          },
        ),
      ]),
    ],
  })

  const part = page.locator(`[data-timeline-part-id="${compactedID}"]`)
  await expect(part).toBeVisible()
  const image = part.locator('[data-slot="tool-media-image"]')
  await expect(image).toHaveCount(1)
  await expect(image).toHaveAttribute("aria-label", "Open image: compacted-shot.png")
})

test("renders PDF, SVG and remote attachments as chips without loading remote images", async ({ page }) => {
  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        toolPart(
          chipsID,
          "mcp__browser__screenshot",
          "completed",
          { url: "https://example.com/chips" },
          {
            output: "Captured mixed attachments",
            attachments: [
              attachment(
                "prt_images_chips_pdf",
                "report.pdf",
                "data:application/pdf;base64,JVBERi0=",
                "application/pdf",
              ),
              attachment(
                "prt_images_chips_svg",
                "diagram.svg",
                "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=",
                "image/svg+xml",
              ),
              attachment("prt_images_chips_remote", "remote-shot.png", "https://example.com/remote-shot.png"),
            ],
          },
        ),
      ]),
    ],
  })

  const part = page.locator(`[data-timeline-part-id="${chipsID}"]`)
  await expect(part).toBeVisible()
  const chips = part.locator('[data-slot="tool-media-chip"]')
  await expect(chips).toHaveCount(3)
  await expect(chips.nth(0)).toHaveAttribute("data-mime", "application/pdf")
  await expect(chips.nth(1)).toHaveAttribute("data-mime", "image/svg+xml")
  await expect(chips.nth(2)).toHaveAttribute("data-mime", "image/png")
  await expect(chips.nth(0).locator('[data-slot="tool-media-chip-name"]')).toHaveText("report.pdf")
  await expect(chips.nth(1).locator('[data-slot="tool-media-chip-name"]')).toHaveText("diagram.svg")
  await expect(chips.nth(2).locator('[data-slot="tool-media-chip-name"]')).toHaveText("remote-shot.png")
  await expect(part.locator('[data-slot="tool-media-image"]')).toHaveCount(0)
  await expect(page.locator('img[src="https://example.com/remote-shot.png"]')).toHaveCount(0)
})

test("keeps the image strip inside the timeline at 1280x900", async ({ page }) => {
  await setupTimeline(page, {
    viewport: { width: 1280, height: 900 },
    messages: [
      userMessage(),
      assistantMessage([
        toolPart(
          mcpID,
          "mcp__browser__screenshot",
          "completed",
          { url: "https://example.com/desktop" },
          {
            output: "Captured screenshots",
            attachments: [
              attachment("prt_images_desktop_a", "wide-a.png", widePng),
              attachment("prt_images_desktop_b", "wide-b.png", widePng),
            ],
          },
        ),
      ]),
    ],
  })

  await expect(page.locator('[data-slot="tool-media-image"]')).toHaveCount(2)
  await expectNoHorizontalOverflow(page)
})

test("keeps the image strip inside the timeline at 390x844 and wraps", async ({ page }) => {
  await setupTimeline(page, {
    viewport: { width: 390, height: 844 },
    messages: [
      userMessage(),
      assistantMessage([
        toolPart(
          mcpID,
          "mcp__browser__screenshot",
          "completed",
          { url: "https://example.com/phone" },
          {
            output: "Captured screenshots",
            attachments: [
              attachment("prt_images_phone_a", "wide-a.png", widePng),
              attachment("prt_images_phone_b", "wide-b.png", widePng),
              attachment("prt_images_phone_c", "wide-c.png", widePng),
              attachment("prt_images_phone_d", "wide-d.png", widePng),
            ],
          },
        ),
      ]),
    ],
  })

  const images = page.locator('[data-slot="tool-media-image"]')
  await expect(images).toHaveCount(4)
  await expectNoHorizontalOverflow(page)
  const tops = await images.evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().top)))
  expect(new Set(tops).size).toBeGreaterThan(1)
})

test("keeps timeline row height stable after the tool image loads", async ({ page }) => {
  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        toolPart(
          geometryID,
          "mcp__browser__screenshot",
          "completed",
          { url: "https://example.com/geometry" },
          {
            output: "Captured a screenshot",
            attachments: [attachment("prt_images_geometry_file", "geometry-wide.png", widePng)],
          },
        ),
      ]),
    ],
  })

  const part = page.locator(`[data-timeline-part-id="${geometryID}"]`)
  const image = part.locator('[data-slot="tool-media-image-content"]')
  await image.scrollIntoViewIfNeeded()
  await expect(image).toBeVisible()
  await image.evaluate((element) => (element as HTMLImageElement).decode())

  const firstHeight = await part.evaluate((element) => element.getBoundingClientRect().height)
  await expect.poll(() => part.evaluate((element) => element.getBoundingClientRect().height)).toBe(firstHeight)
  const secondHeight = await part.evaluate((element) => element.getBoundingClientRect().height)
  expect(secondHeight).toBe(firstHeight)

  const thumbnailHeight = await part
    .locator('[data-slot="tool-media-image"]')
    .evaluate((element) => element.getBoundingClientRect().height)
  expect(Math.round(thumbnailHeight)).toBe(96)
})

test("keeps answer and error typography unchanged beside tool images", async ({ page }) => {
  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        textPart(answerID, "The assistant's final answer stays readable and unchanged."),
        toolPart(errorID, "bash", "error", { command: "exit 1" }, { error: "Command failed visibly" }),
        toolPart(
          mcpID,
          "mcp__browser__screenshot",
          "completed",
          { url: "https://example.com/typography" },
          {
            output: "Captured a screenshot",
            attachments: [attachment("prt_images_typography_file", "typography-shot.png", widePng)],
          },
        ),
      ]),
    ],
  })

  const answer = page.locator(`[data-timeline-part-id="${answerID}"] [data-component="markdown"]`)
  await expect(answer).toBeVisible()
  await expect(answer).toHaveCSS("font-size", "14px")

  const errorCard = page.locator(`[data-timeline-part-id="${errorID}"] [data-kind="tool-error-card"]`)
  await expect(errorCard).toBeVisible()
  await expect(errorCard.locator('[data-slot="basic-tool-tool-title"]')).toHaveCSS("font-size", "14px")
  await errorCard.locator('[data-slot="collapsible-trigger"]').click()
  const errorDescription = errorCard.locator('[data-slot="card-description"]')
  await expect(errorDescription).toBeVisible()
  await expect(errorDescription).toHaveCSS("font-size", "14px")

  const image = page.locator(`[data-timeline-part-id="${mcpID}"] [data-slot="tool-media-image-content"]`)
  await image.scrollIntoViewIfNeeded()
  await expect(image).toBeVisible()
  await image.evaluate((element) => (element as HTMLImageElement).decode())

  await expect(answer).toHaveCSS("font-size", "14px")
  await expect(errorDescription).toHaveCSS("font-size", "14px")
})
