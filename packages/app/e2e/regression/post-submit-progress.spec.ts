import { expect, test } from "@playwright/test"
import { setupTimeline, status, userMessage } from "../performance/timeline-stability/fixture"

const progress = '[data-slot="session-turn-thinking"]'

// An upstream retry is the server still working on the turn: the status map omits the session for
// the whole backoff, so the status watchdog used to demote it to idle and blank the progress row in
// the middle of a live turn — indistinguishable from a dropped connection.
test("keeps the progress row on screen while the server retries the turn", async ({ page }) => {
  const timeline = await setupTimeline(page, { messages: [userMessage()] })

  await timeline.send(status("busy"))
  await expect(page.locator(progress)).toBeVisible()

  await timeline.send(status("retry", 2))
  await expect(page.locator('[data-slot="session-turn-retry"]')).toBeVisible()
  await expect(page.locator(progress)).toBeVisible()

  await timeline.send(status("idle"))
  await expect(page.locator(progress)).toHaveCount(0)
})

// The window the user reported: the prompt is sent, the server has not published anything yet, and
// without a client-side record of the submission the timeline looks finished until the first token
// arrives. The label says which side of the handshake we are on.
test("shows the progress row from the submit keystroke while the server is still silent", async ({ page }) => {
  await page.route("**/prompt_async*", (route) => route.fulfill({ status: 204 }))
  const timeline = await setupTimeline(page, { messages: [] })

  await expect(page.locator(progress)).toHaveCount(0)
  const input = page.locator('[data-component="prompt-input-v2"] [contenteditable="true"]')
  await input.click()
  await input.fill("why is the sky blue")
  await input.press("Enter")

  await expect(page.locator(progress)).toBeVisible()
  await expect(page.locator(progress)).toHaveText(/Sending/)
  await expect(page.locator('[data-slot="session-turn-assistant-content"]')).toHaveCount(0)

  // The server acknowledging the turn hands the indicator over to the status it publishes.
  await timeline.send(status("busy"))
  await expect(page.locator(progress)).toBeVisible()
  await expect(page.locator(progress)).toHaveText(/Thinking/)
  await timeline.send(status("idle"))
  await expect(page.locator(progress)).toHaveCount(0)
})

// "Nothing has come back for a while" has to be distinguishable from "the connection is gone": the
// row stops claiming the model is thinking and says it is still waiting, with the elapsed counter.
//
// Only the *simple* half of this is reachable in a browser fixture: the v1 event schema requires
// `time.completed` on an assistant message, so no fixture can express the case that actually matters —
// an open, still-empty assistant message, which is what a slow model looks like. That half is unit
// tested in `turn-activity.test.ts` (`turnStage` + `turnProducedOutput`); this is the smoke that the
// label and the counter render at all once the threshold is passed.
test("says it is still waiting when the turn has produced nothing", async ({ page }) => {
  const timeline = await setupTimeline(page, {
    messages: [userMessage(undefined, { created: Date.now() - 30_000 })],
  })

  await timeline.send(status("busy"))
  await expect(page.locator(progress)).toHaveText(/Waiting for the model/)
  await expect(page.locator('[data-slot="session-turn-thinking-elapsed"]')).toBeVisible()
})
