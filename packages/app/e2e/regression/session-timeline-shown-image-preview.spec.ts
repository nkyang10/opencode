import { expect, test, type Page } from "@playwright/test"
import {
  assistantID,
  assistantMessage,
  sessionID,
  setupTimeline,
  smallPng,
  toolPart,
  userMessage,
  widePng,
} from "../performance/timeline-stability/fixture"

type Attachment = { id: string; type: "file"; mime: string; filename: string; url: string }
type ImageRequest = { sessionID: string; messageID: string; callID: string; index: number; source?: string }

const previewID = "prt_shown_preview"
const storedID = "prt_shown_stored"
const previewCallID = `call_${previewID}`

function shot(id: string, url: string, preview?: Record<string, unknown>) {
  return toolPart(
    id,
    "show_image",
    "completed",
    { path: "/tmp/opencode/shot.png" },
    {
      title: "show_image",
      output: "Shown to the user: shot.png (PNG, 1200x600, 139 KB).",
      metadata: {
        path: "/tmp/opencode/shot.png",
        name: "shot.png",
        mime: "image/png",
        width: 1200,
        height: 600,
        bytes: 142000,
        caption: "Shot",
        shown: true,
        ...(preview ? { preview } : {}),
      },
      attachments: [
        { id: `${id}_file`, type: "file", mime: "image/png", filename: "shot.png", url } satisfies Attachment,
      ],
    },
  )
}

// The server's browser projection swaps the frame for a thumbnail and strips `uri` from `preview`.
function previewedPart() {
  return shot(previewID, smallPng, { mime: "image/png", width: 120, height: 60, bytes: 4096 })
}

function storedPart() {
  return shot(storedID, widePng)
}

function card(page: Page, partID: string) {
  return page.locator(`[data-timeline-part-id="${partID}"] [data-component="shown-image-card"]`)
}

function previewImage(page: Page, partID: string) {
  return card(page, partID).locator('[data-slot="shown-image-card-image-content"]')
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

test("paints the preview and asks for the full frame only when the viewer opens", async ({ page }) => {
  const requests: ImageRequest[] = []
  const messageQueries: string[] = []
  await setupTimeline(page, {
    viewport: { width: 1280, height: 900 },
    messages: [userMessage(), assistantMessage([previewedPart()])],
    mock: {
      onMessages: ({ phase, query }) => {
        if (phase === "start") messageQueries.push(query.toString())
      },
      sessionImage: (input) => {
        requests.push(input)
        return { body: { uri: widePng, mime: "image/png" } }
      },
    },
  })

  await expect(previewImage(page, previewID)).toBeVisible()
  await expect(previewImage(page, previewID)).toHaveAttribute("src", smallPng)
  await expect.poll(() => messageQueries.length).toBeGreaterThan(0)
  expect(messageQueries.every((query) => query.includes("imagePreviews=thumbnail"))).toBe(true)
  expect(requests).toEqual([])

  await card(page, previewID).locator('[data-slot="shown-image-card-image"]').click()
  await expect(viewerImage(page)).toHaveAttribute("src", widePng)
  expect(requests).toEqual([{ sessionID, messageID: assistantID, callID: previewCallID, index: 0 }])

  const download = page.waitForEvent("download")
  await viewer(page).locator('[data-action="image-viewer-actions"]').click()
  await expect(menu(page)).toBeVisible()
  await menu(page).getByRole("menuitem", { name: "Save image", exact: true }).click()
  expect((await download).suggestedFilename()).toMatch(/\.png$/)
  await expect(menu(page)).toHaveCount(0)
  expect(requests).toHaveLength(1)
})

test("paints the stored frame directly when the tool result carries no preview", async ({ page }) => {
  const requests: ImageRequest[] = []
  await setupTimeline(page, {
    viewport: { width: 1280, height: 900 },
    messages: [userMessage(), assistantMessage([storedPart()])],
    mock: {
      sessionImage: (input) => {
        requests.push(input)
        return { body: { uri: smallPng, mime: "image/png" } }
      },
    },
  })

  await expect(previewImage(page, storedID)).toBeVisible()
  await expect(previewImage(page, storedID)).toHaveAttribute("src", widePng)

  await card(page, storedID).locator('[data-slot="shown-image-card-image"]').click()
  await expect(viewer(page)).toBeVisible()
  await expect(viewerImage(page)).toHaveAttribute("src", widePng)
  expect(requests).toEqual([])
})

test("keeps the preview and reports it when the full frame cannot be loaded", async ({ page }) => {
  const requests: ImageRequest[] = []
  await setupTimeline(page, {
    viewport: { width: 1280, height: 900 },
    messages: [userMessage(), assistantMessage([previewedPart()])],
    mock: {
      sessionImage: (input) => {
        requests.push(input)
        return { status: 503, body: { error: "Upstream is gone" } }
      },
    },
  })

  await expect(previewImage(page, previewID)).toHaveAttribute("src", smallPng)
  await card(page, previewID).locator('[data-slot="shown-image-card-image"]').click()
  await expect(viewer(page)).toBeVisible()
  await expect(
    page.locator('[data-component="toast"]').filter({ hasText: "Could not load the full image" }),
  ).toBeVisible()
  expect(requests).toHaveLength(1)
  await expect(viewerImage(page)).toHaveAttribute("src", smallPng)
  await expect(previewImage(page, previewID)).toHaveAttribute("src", smallPng)
})
