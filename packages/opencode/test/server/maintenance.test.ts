import { expect, test } from "bun:test"
import { ServerMaintenance } from "../../src/server/maintenance"
import { ServerLifecycle } from "../../src/server/lifecycle"

test("keeps self-restart unavailable until its owning host opts in", () => {
  expect(ServerMaintenance.info()).toEqual({ restartSupported: false, restarting: false })
  expect(ServerMaintenance.request(async () => 0)).toBe(false)
})

test("preserves source and compiled launch commands and pins the current port", () => {
  expect(
    ServerMaintenance.argumentsForRestart(["bun", "/repo/src/index.ts", "web", "--port", "0"], false, 4447),
  ).toEqual(["/repo/src/index.ts", "web", "--port", "4447"])
  expect(
    ServerMaintenance.argumentsForRestart(
      ["bun", "/$bunfs/root/opencode", "web", "--hostname", "0.0.0.0", "--port=0"],
      true,
      4447,
    ),
  ).toEqual(["web", "--hostname", "0.0.0.0", "--port", "4447"])
})

test("coalesces repeated requests and delegates to the owning host without restarting this test process", async () => {
  let count = 0
  let finish: () => void = () => {}
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  const remove = ServerMaintenance.install(async (active) => {
    expect(await active()).toBe(2)
    count++
    finish()
  })
  expect(ServerMaintenance.request(async () => 2)).toBe(true)
  expect(ServerMaintenance.request(async () => 99)).toBe(true)
  expect(ServerLifecycle.info().reason).toBe("maintenance")
  await finished
  expect(count).toBe(1)
  remove()
  await Bun.sleep(0)
  expect(ServerMaintenance.info()).toEqual({ restartSupported: false, restarting: false })
})

test("leaves supervised process replacement to its service manager", () => {
  expect(ServerMaintenance.standalone({})).toBe(true)
  expect(ServerMaintenance.standalone({ INVOCATION_ID: "systemd-unit" })).toBe(false)
  expect(ServerMaintenance.standalone({ pm_id: "0" })).toBe(false)
  expect(ServerMaintenance.standalone({ SUPERVISOR_ENABLED: "1" })).toBe(false)
})

test("a systemd unit is supervised but still restartable, through the unit", () => {
  const unmanaged = () => undefined
  const unit = () => "opencode-fork.service"
  expect(ServerMaintenance.restartable({}, unmanaged)).toBe(true)
  expect(ServerMaintenance.restartable({ INVOCATION_ID: "systemd-unit" }, unmanaged)).toBe(false)
  expect(ServerMaintenance.restartable({ pm_id: "0" }, unmanaged)).toBe(false)
  expect(ServerMaintenance.restartable({ INVOCATION_ID: "systemd-unit" }, unit)).toBe(true)
})
