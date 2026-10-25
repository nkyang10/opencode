import { expect, test } from "bun:test"
import { serverUpdateVersion } from "./server-update-state"

test("the first healthy version establishes a baseline, not an update", () => {
  expect(serverUpdateVersion(undefined, { healthy: true, version: "1.2.3" })).toEqual({
    version: "1.2.3",
    changed: false,
  })
})

test("outages and missing versions preserve the last healthy version", () => {
  for (const health of [
    { healthy: false },
    { healthy: false, version: "1.2.4" },
    { healthy: true },
    { healthy: true, version: "" },
    { healthy: true, version: "  " },
  ]) {
    expect(serverUpdateVersion("1.2.3", health)).toEqual({ version: "1.2.3", changed: false })
  }
})

test("same-version recovery never requests a refresh", () => {
  const outage = serverUpdateVersion("1.2.3", { healthy: false })
  expect(serverUpdateVersion(outage.version, { healthy: true, version: "1.2.3" }).changed).toBeFalse()
})

test("a changed version after an outage requests a refresh exactly once", () => {
  const outage = serverUpdateVersion("1.2.3", { healthy: false })
  const recovery = serverUpdateVersion(outage.version, { healthy: true, version: "1.2.4" })
  expect(recovery).toEqual({ version: "1.2.4", changed: true })
  expect(serverUpdateVersion(recovery.version, { healthy: true, version: "1.2.4" }).changed).toBeFalse()
})

test("an unavailable server at startup does not count as an old version", () => {
  const outage = serverUpdateVersion(undefined, { healthy: false })
  expect(serverUpdateVersion(outage.version, { healthy: true, version: "1.2.3" }).changed).toBeFalse()
})
