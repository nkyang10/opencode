import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/NoticeRegression"
const sessionID = "ses_notice_regression"
const projectID = "proj_notice_regression"

async function setup(page: Page, permission = false, question = false, tools = false, activity = false) {
  await mockOpenCodeServer(page, {
    protocol: "v2",
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "notices",
      time: { created: 1, updated: 1 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: { "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200000 } } },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [
      {
        id: sessionID,
        projectID,
        directory,
        slug: "notices",
        title: "Notice regression",
        version: "dev",
        model: { providerID: "opencode", id: "claude-opus-4-6" },
        time: { created: 1, updated: 1 },
      },
    ],
    pageMessages: () => ({
      items: tools
        ? [
            {
              info: { id: "msg_notice_user", sessionID, role: "user", time: { created: 1 } },
              parts: [{ id: "prt_notice_user", type: "text", text: "Run two shell commands" }],
            },
            {
              info: {
                id: "msg_notice_assistant",
                sessionID,
                role: "assistant",
                parentID: "msg_notice_user",
                agent: "build",
                providerID: "opencode",
                modelID: "claude-opus-4-6",
                time: { created: 2, completed: 5 },
                tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
                cost: 0,
              },
              parts: [
                ...["one", "two"].map((value, index) => ({
                  id: `prt_shell_${index}`,
                  sessionID,
                  messageID: "msg_notice_assistant",
                  type: "tool",
                  tool: "shell",
                  state: {
                    status: "completed",
                    input: { command: `echo ${value}` },
                    output: value,
                    metadata: {},
                    time: { start: 2, end: 4 },
                  },
                })),
                ...(activity
                  ? [
                      ...["read", "glob", "grep", "list"].map((tool, index) => ({
                        id: `prt_context_${index}`,
                        sessionID,
                        messageID: "msg_notice_assistant",
                        type: "tool",
                        tool,
                        state: {
                          status: "completed",
                          input: { filePath: `${directory}/README.md`, path: directory, pattern: "needle" },
                          output: "Found context",
                          metadata: {},
                          time: { start: 4, end: 5 },
                        },
                      })),
                      {
                        id: "prt_error",
                        sessionID,
                        messageID: "msg_notice_assistant",
                        type: "tool",
                        tool: "shell",
                        state: {
                          status: "error",
                          input: { command: "denied" },
                          error: "Permission denied: preserved error emphasis",
                          time: { start: 4, end: 5 },
                        },
                      },
                      {
                        id: "prt_final_answer",
                        sessionID,
                        messageID: "msg_notice_assistant",
                        type: "text",
                        text: "The assistant's final answer stays readable and unchanged.",
                      },
                    ]
                  : []),
              ],
            },
          ]
        : [],
    }),
    questions: question
      ? [
          {
            id: "que_notice",
            sessionID,
            questions: [
              {
                header: "Notice question",
                question: "Which plan?",
                options: [{ label: "Continue", description: "Proceed" }],
              },
            ],
          },
        ]
      : [],
    permissions: permission
      ? [{ id: "perm_notice", sessionID, permission: "bash", patterns: ["echo safe"], always: ["*"], metadata: {} }]
      : [],
  })
  await page.route("**/global/lifecycle", (route) =>
    route.fulfill({ json: { draining: true, remainingMs: 60000, reason: "maintenance", activeTurns: 1 } }),
  )
  await page.route("**/global/maintenance", (route) =>
    route.fulfill({ json: { restartSupported: true, restarting: false } }),
  )
  await page.addInitScript(() =>
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({ general: { newLayoutDesigns: true, shellToolPartsExpanded: true } }),
    ),
  )
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expect(page.locator('[data-component="prompt-input-v2"]')).toBeVisible()
}

test("restart and permission notices can be dismissed without hiding or disabling the composer", async ({ page }) => {
  let decisions = 0
  await setup(page, true)
  await page.route("**/api/session/*/permission/*/reply", (route) => {
    decisions++
    return route.fulfill({ status: 204 })
  })
  const banner = page.getByRole("status").filter({ hasText: /restart|restarting/i })
  await expect(banner).toBeVisible()
  const permission = page
    .locator('[data-component="dismissible-dock"]')
    .filter({ has: page.locator('[data-kind="permission"]') })
  await expect(permission).toBeVisible()
  const composer = page.locator('[data-component="prompt-input-v2"]')
  const input = composer.locator('[data-component="prompt-input"]')
  await input.fill("Let me keep working")
  await expect(input).toHaveText("Let me keep working")
  await banner.getByRole("button", { name: "Dismiss", exact: true }).click()
  await expect(banner).toHaveCount(0)
  await permission.locator('[data-action="dismiss-dock"]').click()
  await expect(permission).toHaveCount(0)
  await expect(input).toBeEditable()
  await expect(input).toHaveText("Let me keep working")
  expect(decisions).toBe(0)
})

test("maintenance confirms a host restart and sends one server-side request", async ({ page }) => {
  await setup(page)
  let restarts = 0
  await page.route("**/global/restart", (route) => {
    restarts++
    expect(route.request().method()).toBe("POST")
    return route.fulfill({ json: { accepted: true } })
  })
  await page.locator('[data-action="application-menu"]').click()
  await page.getByRole("menuitem", { name: "Maintenance", exact: true }).hover()
  await page.getByRole("menuitem", { name: "Restart host server", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Restart host server", exact: true })
  await expect(dialog).toBeVisible()
  expect(restarts).toBe(0)
  await dialog.getByRole("button", { name: "Restart host server", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(restarts).toBe(1)
  await expect(page.locator('[data-component="prompt-input-v2"] [data-component="prompt-input"]')).toBeEditable()
})

test("question docks can be hidden without answering and leave the draft editable", async ({ page }) => {
  await setup(page, false, true)
  let decisions = 0
  await page.route("**/api/session/*/question/*/{reply,reject}", (route) => {
    decisions++
    return route.fulfill({ status: 204 })
  })
  const dock = page
    .locator('[data-component="dismissible-dock"]')
    .filter({ has: page.locator('[data-kind="question"]') })
  await expect(dock).toBeVisible()
  await dock.locator('[data-action="dismiss-dock"]').click()
  await expect(dock).toHaveCount(0)
  const input = page.locator('[data-component="prompt-input-v2"] [data-component="prompt-input"]')
  await input.fill("A new instruction")
  await expect(input).toHaveText("A new instruction")
  expect(decisions).toBe(0)
})

test("consecutive shell calls have no row or output padding in V2", async ({ page }) => {
  await setup(page, false, false, true)
  const tools = page.locator('[data-component="tool-part-wrapper"][data-tool="shell"]')
  await expect(tools).toHaveCount(2)
  for (let index = 0; index < 2; index++) {
    const tool = tools.nth(index)
    await expect(tool).toBeVisible()
    await expect(tool).toHaveCSS("margin-top", "0px")
    const row = page
      .locator('[data-timeline-row="AssistantPart"]')
      .filter({ has: page.locator(`[data-timeline-part-id="prt_shell_${index}"]`) })
    await expect(row).toHaveCSS("padding-top", "0px")
    await expect(tool.locator('[data-slot="bash-pre"]')).toHaveCSS("padding-left", "0px")
    await expect(tool.locator('[data-slot="bash-pre"]')).toContainText(index === 0 ? "echo one" : "echo two")
  }
  await page.screenshot({ path: "/data/opencode-compact-tools.png" })
})

test("secondary tools and exploration are compact and muted without shrinking answers or errors", async ({
  page,
}, testInfo) => {
  await setup(page, false, false, true, true)
  const shell = page.locator('[data-component="tool-part-wrapper"][data-timeline-part-id="prt_shell_0"]')
  const shellTitle = shell.locator('[data-slot="basic-tool-tool-title"]')
  await expect(shellTitle).toHaveCSS("font-size", "12px")
  await expect(shell.locator('[data-slot="bash-pre"] code')).toHaveCSS("font-size", "11px")
  await expect(shell.locator('[data-slot="bash-pre"] code')).toHaveCSS("line-height", "16px")
  const trigger = page.locator('[data-component="context-tool-group-trigger"]')
  await expect(trigger).toHaveCount(1)
  await expect(trigger.locator('[data-slot="context-tool-group-title"]')).toHaveCSS("font-size", "12px")
  const row = page.locator('[data-timeline-row="AssistantPart"]').filter({ has: trigger })
  await expect(row).toHaveCSS("padding-top", "0px")
  await trigger.click()
  const list = page.locator('[data-component="context-tool-group-list"]')
  await expect(list).toBeVisible()
  await expect(list).toHaveCSS("gap", "0px")
  await expect(list).toHaveCSS("padding-left", "0px")
  const titles = list.locator('[data-slot="basic-tool-tool-title"]')
  await expect(titles).toHaveCount(4)
  for (let index = 0; index < 4; index++) await expect(titles.nth(index)).toHaveCSS("font-size", "12px")
  const muted = await shellTitle.evaluate((element) => getComputedStyle(element).color)
  await expect(trigger.locator('[data-slot="context-tool-group-summary"]')).toHaveCSS("color", muted)
  await expect(trigger.locator('[data-slot="tool-status-done"]')).toHaveCSS("color", muted)
  const answer = page
    .locator('[data-component="markdown"]')
    .filter({ hasText: "The assistant's final answer stays readable and unchanged." })
  await expect(answer).toBeVisible()
  expect(await answer.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThan(12)
  expect(await answer.evaluate((element) => getComputedStyle(element).color)).not.toBe(muted)
  const errorTitle = page.locator('[data-kind="tool-error-card"] [data-slot="basic-tool-tool-title"]')
  await expect(errorTitle).toHaveCSS("font-size", "14px")
  expect(await errorTitle.evaluate((element) => getComputedStyle(element).color)).not.toBe(muted)
  await page.screenshot({ path: testInfo.outputPath("compact-secondary-tools.png") })
})
