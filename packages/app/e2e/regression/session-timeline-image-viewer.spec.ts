import { expect, test, type Locator, type Page } from "@playwright/test"
import { deflateSync } from "node:zlib"
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

const userImageID = "prt_viewer_user_image"
const toolImageID = "prt_viewer_tool_image"
const answerID = "prt_viewer_answer"

const largePng = pngDataUrl(1200, 800)

function attachment(id: string, filename: string, url: string, mime = "image/png"): Attachment {
  return { id, type: "file", mime, filename, url }
}

function userFile(id: string, filename: string, url: string, mime = "image/png") {
  return { id, type: "file" as const, mime, filename, url }
}

function viewer(page: Page) {
  return page.locator('[data-component="image-viewer"]')
}

function viewerImage(page: Page) {
  return viewer(page).locator('[data-slot="image-viewer-image"]')
}

function menu(page: Page) {
  return page.getByRole("menu")
}

async function zoomPercent(page: Page) {
  const text = await viewer(page).locator('[data-slot="image-viewer-zoom"]').textContent()
  const match = text?.match(/(\d+)/)
  return match ? Number(match[1]) : Number.NaN
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1)
}

async function timelineScroller(page: Page) {
  return page.locator(".scroll-view__viewport").filter({ has: page.locator("[data-timeline-row]") })
}

async function seedMessages() {
  return [
    userMessage([userFile(userImageID, "user-photo.png", smallPng)]),
    assistantMessage([
      toolPart(
        toolImageID,
        "mcp__browser__screenshot",
        "completed",
        { url: "https://example.com/viewer" },
        {
          output: "Captured a screenshot",
          attachments: [attachment("prt_viewer_tool_file", "tool-shot.png", widePng)],
        },
      ),
      textPart(answerID, "The answer stays in place while the viewer opens and closes."),
    ]),
  ]
}

function crc32(input: Buffer) {
  let value = 0xffffffff
  for (const byte of input) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
  }
  return (value ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const name = Buffer.from(type)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, checksum])
}

function pngDataUrl(width: number, height: number) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const stride = width * 3 + 1
  const rows = Buffer.alloc(stride * height, 200)
  for (let row = 0; row < height; row++) rows[row * stride] = 0
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
  return `data:image/png;base64,${png.toString("base64")}`
}

for (const protocol of ["v1", "v2"] as const) {
  test(`opens the viewer by click and Enter with a title, counter and zoom (${protocol})`, async ({ page }) => {
    await setupTimeline(page, { protocol, messages: await seedMessages() })

    const toolImage = page.getByRole("button", { name: "Open image: tool-shot.png" })
    await expect(toolImage).toBeVisible()

    await toolImage.click()
    await expect(viewer(page)).toBeVisible()
    await expect(viewer(page).locator('[data-slot="image-viewer-title"]')).toContainText("tool-shot.png")
    await expect(viewer(page).locator('[data-slot="image-viewer-counter"]')).toContainText("/ 2")
    await expect(viewer(page).locator('[data-slot="image-viewer-zoom"]')).toContainText("%")
    await expect(viewerImage(page)).toHaveAttribute("src", widePng)

    await page.keyboard.press("Escape")
    await expect(viewer(page)).toHaveCount(0)
    await expect(toolImage).toBeFocused()

    await toolImage.focus()
    await expect(toolImage).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(viewer(page)).toBeVisible()
    await expect(viewer(page).locator('[data-slot="image-viewer-title"]')).toContainText("tool-shot.png")
    await expect(viewer(page).locator('[data-slot="image-viewer-counter"]')).toContainText("2 / 2")
    await expect(viewerImage(page)).toHaveAttribute("src", widePng)

    await page.keyboard.press("Escape")
    await expect(viewer(page)).toHaveCount(0)
    await expect(toolImage).toBeFocused()
  })
}

test("zooms with toolbar buttons and keys and pans with arrow keys", async ({ page }) => {
  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        toolPart(
          toolImageID,
          "mcp__browser__screenshot",
          "completed",
          { url: "https://example.com/large" },
          {
            output: "Captured a screenshot",
            attachments: [attachment("prt_viewer_large_file", "large-shot.png", largePng)],
          },
        ),
      ]),
    ],
  })

  await page.getByRole("button", { name: "Open image: large-shot.png" }).click()
  const image = viewerImage(page)
  await expect(image).toBeVisible()
  await expect(image).toHaveAttribute("data-zoom")
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)

  const initialZoom = await zoomPercent(page)
  const initialBox = await image.boundingBox()
  expect(initialBox).not.toBeNull()

  await viewer(page).locator('[data-action="image-viewer-zoom-in"]').click()
  await expect.poll(() => zoomPercent(page)).toBeGreaterThan(initialZoom)
  const zoomedValue = await zoomPercent(page)
  await expect
    .poll(async () => (await image.boundingBox())?.width ?? 0)
    .toBeGreaterThan(initialBox!.width)

  await viewer(page).locator('[data-action="image-viewer-zoom-out"]').click()
  await expect.poll(() => zoomPercent(page)).toBeLessThan(zoomedValue)

  await page.keyboard.press("Shift+=")
  const afterPlus = await zoomPercent(page)
  await page.keyboard.press("Minus")
  await expect.poll(() => zoomPercent(page)).toBeLessThan(afterPlus)

  await page.keyboard.press("1")
  await expect.poll(() => zoomPercent(page)).toBe(100)

  await page.keyboard.press("0")
  await expect.poll(() => zoomPercent(page)).toBeGreaterThanOrEqual(10)
  await expect.poll(() => zoomPercent(page)).toBeLessThanOrEqual(800)

  await page.keyboard.press("1")
  await page.keyboard.press("Shift+=")
  await page.keyboard.press("Shift+=")
  await expect.poll(() => zoomPercent(page)).toBeGreaterThan(100)
  const beforePan = await image.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return `${getComputedStyle(element).transform}|${Math.round(rect.left)}|${Math.round(rect.top)}`
  })
  await page.keyboard.press("ArrowRight")
  await expect
    .poll(() =>
      image.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return `${getComputedStyle(element).transform}|${Math.round(rect.left)}|${Math.round(rect.top)}`
      }),
    )
    .not.toBe(beforePan)
})

test("moves previous and next across user and tool images in timeline order", async ({ page }) => {
  await setupTimeline(page, { messages: await seedMessages() })

  await page.getByRole("button", { name: "Open image: user-photo.png" }).click()
  await expect(viewer(page).locator('[data-slot="image-viewer-counter"]')).toContainText("1 / 2")
  await expect(viewer(page).locator('[data-slot="image-viewer-title"]')).toContainText("user-photo.png")
  await expect(viewerImage(page)).toHaveAttribute("src", smallPng)

  await viewer(page).locator('[data-action="image-viewer-next"]').click()
  await expect(viewer(page).locator('[data-slot="image-viewer-counter"]')).toContainText("2 / 2")
  await expect(viewer(page).locator('[data-slot="image-viewer-title"]')).toContainText("tool-shot.png")
  await expect(viewerImage(page)).toHaveAttribute("src", widePng)

  await viewer(page).locator('[data-action="image-viewer-previous"]').click()
  await expect(viewer(page).locator('[data-slot="image-viewer-counter"]')).toContainText("1 / 2")
  await expect(viewer(page).locator('[data-slot="image-viewer-title"]')).toContainText("user-photo.png")
  await expect(viewerImage(page)).toHaveAttribute("src", smallPng)
})

test("opens the actions menu by right-click, the actions button and Shift+F10", async ({ page }) => {
  await setupTimeline(page, {
    messages: [
      userMessage([userFile(userImageID, "user-photo.png", smallPng)]),
      assistantMessage([
        toolPart(
          toolImageID,
          "mcp__browser__screenshot",
          "completed",
          { filePath: "/tmp/opencode/viewer-photo.png" },
          {
            output: "Captured a screenshot",
            attachments: [attachment("prt_viewer_actions_file", "tool-shot.png", widePng)],
          },
        ),
      ]),
    ],
  })

  const toolImage = page.getByRole("button", { name: "Open image: tool-shot.png" })
  const toolPartRow = page.locator(`[data-timeline-part-id="${toolImageID}"]`)

  await toolImage.click({ button: "right" })
  await expect(menu(page)).toBeVisible()
  await expect(menu(page).getByRole("menuitem", { name: "Open", exact: true })).toBeVisible()
  await expect(menu(page).getByRole("menuitem", { name: "Open in new tab", exact: true })).toBeVisible()
  await expect(menu(page).getByRole("menuitem", { name: "Copy image", exact: true })).toBeVisible()
  await expect(menu(page).getByRole("menuitem", { name: "Save image", exact: true })).toBeVisible()
  await expect(menu(page).getByRole("menuitem", { name: "Copy path", exact: true })).toBeVisible()
  await expect(menu(page).getByRole("menuitem", { name: "Attach to message", exact: true })).toBeVisible()
  await expect(menu(page).getByRole("menuitem", { name: "Reveal in file manager", exact: true })).toHaveCount(0)
  await expect(menu(page).getByRole("menuitem", { name: "Go to message", exact: true })).toHaveCount(0)

  await page.keyboard.press("Escape")
  await expect(menu(page)).toHaveCount(0)
  await expect(toolImage).toBeFocused()

  const actionsMenuButton = toolPartRow.locator('[data-action="image-actions-menu"]')
  await actionsMenuButton.click()
  await expect(menu(page)).toBeVisible()
  await expect(menu(page).getByRole("menuitem", { name: "Open", exact: true })).toBeVisible()
  await expect(menu(page).getByRole("menuitem", { name: "Copy image", exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(menu(page)).toHaveCount(0)
  await expect(actionsMenuButton).toBeFocused()

  await toolImage.focus()
  await expect(toolImage).toBeFocused()
  await page.keyboard.press("Shift+F10")
  await expect(menu(page)).toBeVisible()
  await expect(menu(page).getByRole("menuitem", { name: "Open", exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(menu(page)).toHaveCount(0)
  await expect(toolImage).toBeFocused()

  await toolImage.click()
  await expect(viewer(page)).toBeVisible()
  await viewer(page).locator('[data-action="image-viewer-actions"]').click()
  await expect(menu(page)).toBeVisible()
  await expect(menu(page).getByRole("menuitem", { name: "Go to message", exact: true })).toBeVisible()
  await expect(menu(page).getByRole("menuitem", { name: "Open", exact: true })).toHaveCount(0)
  const counter = viewer(page).locator('[data-slot="image-viewer-counter"]')
  const counterText = await counter.textContent()
  await page.keyboard.press("ArrowLeft")
  await expect(counter).toHaveText(counterText ?? "")
  await page.keyboard.press("Escape")
  await expect(menu(page)).toHaveCount(0)
  await expect(viewer(page)).toBeVisible()
  await expect(viewer(page).locator('[data-action="image-viewer-actions"]')).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(viewer(page)).toHaveCount(0)
  await expect(toolImage).toBeFocused()
})

test("copies the image to the clipboard as image/png", async ({ page, context, baseURL }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: baseURL ?? "http://127.0.0.1:3000",
  })
  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        toolPart(
          toolImageID,
          "mcp__browser__screenshot",
          "completed",
          { url: "https://example.com/copy" },
          {
            output: "Captured a screenshot",
            attachments: [attachment("prt_viewer_copy_file", "copy-shot.png", widePng)],
          },
        ),
      ]),
    ],
  })

  const image = page.getByRole("button", { name: "Open image: copy-shot.png" })
  await image.click({ button: "right" })
  await expect(menu(page)).toBeVisible()
  await menu(page).getByRole("menuitem", { name: "Copy image", exact: true }).click()
  await expect(menu(page)).toHaveCount(0)
  await expect(page.locator('[data-component="toast"]').filter({ hasText: "Image copied" })).toBeVisible()

  const types = await page
    .evaluate(async () => {
      const items = await navigator.clipboard.read()
      return items.flatMap((item) => item.types)
    })
    .catch(() => undefined)
  if (!types) test.skip(true, "This browser context cannot read the clipboard")
  expect(types).toContain("image/png")
})

test("saves the image with a download named after the image", async ({ page }) => {
  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        toolPart(
          toolImageID,
          "mcp__browser__screenshot",
          "completed",
          { url: "https://example.com/save" },
          {
            output: "Captured a screenshot",
            attachments: [attachment("prt_viewer_save_file", "save-shot.png", widePng)],
          },
        ),
      ]),
    ],
  })

  const image = page.getByRole("button", { name: "Open image: save-shot.png" })
  await image.click({ button: "right" })
  await expect(menu(page)).toBeVisible()
  const downloadPromise = page.waitForEvent("download")
  await menu(page).getByRole("menuitem", { name: "Save image", exact: true }).click()
  const download = await downloadPromise
  const suggested = download.suggestedFilename()
  expect(suggested).toMatch(/^(save-shot|mcp__browser__screenshot)/)
  expect(suggested.endsWith(".png")).toBe(true)
})

test("attaches the image to the active composer and focuses it", async ({ page }) => {
  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        toolPart(
          toolImageID,
          "mcp__browser__screenshot",
          "completed",
          { url: "https://example.com/attach" },
          {
            output: "Captured a screenshot",
            attachments: [attachment("prt_viewer_attach_file", "attach-shot.png", widePng)],
          },
        ),
      ]),
    ],
  })

  const image = page.getByRole("button", { name: "Open image: attach-shot.png" })
  await image.click()
  await expect(viewer(page)).toBeVisible()
  await viewer(page).locator('[data-action="image-viewer-actions"]').click()
  await expect(menu(page)).toBeVisible()
  await menu(page).getByRole("menuitem", { name: "Attach to message", exact: true }).click()
  await expect(menu(page)).toHaveCount(0)
  await expect(viewer(page)).toHaveCount(0)

  const attachments = page.locator('[data-slot="prompt-attachments"]')
  await expect(attachments.locator('img[alt="attach-shot.png"]')).toBeVisible()
  await expect(page.locator('[data-component="prompt-input-v2"] [data-component="prompt-input"]')).toBeFocused()
})

test("keeps the viewer and its actions menu inside 390x844 without overflow", async ({ page }) => {
  await setupTimeline(page, {
    viewport: { width: 390, height: 844 },
    messages: await seedMessages(),
  })

  await page.getByRole("button", { name: "Open image: user-photo.png" }).click()
  const root = viewer(page)
  await expect(root).toBeVisible()
  await expect(root.locator('[data-slot="image-viewer-title"]')).toBeVisible()
  await expect(root.locator('[data-slot="image-viewer-dimensions"]')).toBeHidden()
  await expect(root.locator('[data-slot="image-viewer-source"]')).toBeHidden()
  await expect(root.locator('[data-action="image-viewer-actions"]')).toBeVisible()
  await expect(root.locator('[data-action="image-viewer-close"]')).toBeVisible()
  await expect(root.locator('[data-action="image-viewer-zoom-in"]')).toBeHidden()
  await expect(root.locator('[data-action="image-viewer-zoom-out"]')).toBeHidden()
  await expect(root.locator('[data-action="image-viewer-fit"]')).toBeHidden()
  await expect(root.locator('[data-action="image-viewer-actual-size"]')).toBeHidden()
  await expect(root.locator('[data-action="image-viewer-save"]')).toBeHidden()
  await expect(root.locator('[data-action="image-viewer-copy"]')).toBeHidden()
  await expectNoHorizontalOverflow(page)

  await root.locator('[data-action="image-viewer-actions"]').click()
  await expect(menu(page)).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await page.keyboard.press("Escape")
  await expect(menu(page)).toHaveCount(0)
})

test("overlays the user image actions button and labels the viewer source You (v2)", async ({ page }) => {
  await setupTimeline(page, {
    protocol: "v2",
    settings: { newLayoutDesigns: true },
    messages: await seedMessages(),
  })

  const userImage = page.getByRole("button", { name: "Open image: user-photo.png" })
  await expect(userImage).toBeVisible()
  const group = page.locator('[data-slot="user-message-attachment-image-group"]').filter({ has: userImage })
  await expect(group).toBeVisible()
  await expect(group.locator('[data-action="image-actions-menu"]')).toBeVisible()

  const heights = await group.evaluate((element) => {
    const image = element.querySelector('[data-slot="user-message-attachment"]')
    return {
      group: Math.round(element.getBoundingClientRect().height),
      image: Math.round(image?.getBoundingClientRect().height ?? 0),
    }
  })
  expect(heights.image).toBe(46)
  expect(heights.group).toBe(heights.image)

  await userImage.click({ position: { x: 10, y: 30 } })
  await expect(viewer(page)).toBeVisible()
  await expect(viewer(page).locator('[data-slot="image-viewer-source"]')).toBeVisible()
  await expect(viewer(page).locator('[data-slot="image-viewer-source"]')).toHaveText("You")
})

test("keeps timeline geometry unchanged when the viewer opens and closes", async ({ page }) => {
  await setupTimeline(page, { messages: await seedMessages() })

  const toolImage = page.getByRole("button", { name: "Open image: tool-shot.png" })
  await toolImage.scrollIntoViewIfNeeded()
  await expect(toolImage).toBeVisible()
  const row = page.locator(`[data-timeline-part-id="${toolImageID}"]`)
  const scroller = await timelineScroller(page)
  await expect(scroller).toBeVisible()

  const geometry = () =>
    row.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)].join(",")
    })
  const before = await geometry()

  await toolImage.click()
  await expect(viewer(page)).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(viewer(page)).toHaveCount(0)

  await expect.poll(geometry).toBe(before)
})
