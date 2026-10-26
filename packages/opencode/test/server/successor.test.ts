import { expect, test } from "bun:test"
import { ServerSuccessor } from "@/server/successor"

const userCgroup =
  "0::/user.slice/user-1000.slice/user@1000.service/app.slice/opencode-fork.service\n"

function exec(
  results: Record<string, { status: number; stdout: string; stderr?: string }>,
  fallback = { status: 0, stdout: "" },
) {
  const calls: { command: string; args: string[] }[] = []
  const run: ServerSuccessor.Run = (command, args) => {
    const key = args.join(" ")
    calls.push({ command, args })
    const match = Object.entries(results).find(([pattern]) => key.includes(pattern))
    return match ? match[1] : fallback
  }
  return { run, calls }
}

const failed = { status: 1, stdout: "" }

test("reads the owning user unit from the cgroup, and nothing else", () => {
  expect(ServerSuccessor.unit(() => userCgroup)).toBe("opencode-fork.service")
  expect(ServerSuccessor.unit(() => "0::/user.slice/user-1000.slice/user@1000.service/app.slice/x@y.service")).toBe(
    "x@y.service",
  )
  // A system unit is not restartable from an unprivileged process, so it must not be claimed.
  expect(ServerSuccessor.unit(() => "0::/system.slice/opencode.service")).toBeUndefined()
  // Inside the user manager itself the deepest component is a slice, not a unit.
  expect(ServerSuccessor.unit(() => "0::/user.slice/user-1000.slice/user@1000.service/app.slice")).toBeUndefined()
  expect(ServerSuccessor.unit(() => "")).toBeUndefined()
  expect(ServerSuccessor.unit(() => "0::/init.scope")).toBeUndefined()
})

test("a missing procfs is 'nothing supervises me', not a crash", () => {
  expect(ServerSuccessor.unit(() => throwRead())).toBeUndefined()
})

function throwRead(): string {
  throw new Error("ENOENT /proc/self/cgroup")
}

test("systemd owns the stop only when it already has a job for us", () => {
  // A deploy's bare `kill` arrives while the unit still reads `active`: systemd does not know.
  expect(ServerSuccessor.owned("u.service", exec({ ActiveState: { status: 0, stdout: "active\n" } }).run)).toBe(false)
  // `systemctl stop` and `systemctl restart` both arrive as `deactivating/stop-sigterm`.
  expect(ServerSuccessor.owned("u.service", exec({ ActiveState: { status: 0, stdout: "deactivating\n" } }).run)).toBe(
    true,
  )
  // No answer is not permission to queue a job against an unknown state.
  expect(ServerSuccessor.owned("u.service", exec({}, failed).run)).toBe(true)
  expect(ServerSuccessor.owned("u.service", exec({ ActiveState: { status: 0, stdout: "" } }).run)).toBe(true)
})

test("the queued restart never blocks on our own stop job", () => {
  const { run, calls } = exec({})
  expect(ServerSuccessor.queue("opencode-fork.service", run)).toBe(true)
  expect(calls[0]?.args).toEqual(["--user", "restart", "--no-block", "opencode-fork.service"])
  expect(ServerSuccessor.queue("u.service", exec({}, failed).run)).toBe(false)
})

test("handoff decides between queueing a replacement and leaving the job to systemd", () => {
  const active = exec({ ActiveState: { status: 0, stdout: "active\n" } })
  const started = ServerSuccessor.handoff(() => userCgroup, active.run)
  expect(started).toMatchObject({ attempted: true, queued: true, unit: "opencode-fork.service" })
  expect(active.calls.some((call) => call.args.join(" ").includes("--no-block"))).toBe(true)

  const stopping = ServerSuccessor.handoff(
    () => userCgroup,
    exec({ ActiveState: { status: 0, stdout: "deactivating\n" } }).run,
  )
  expect(stopping.attempted).toBe(false)
  expect(stopping.note).toContain("systemd owns this stop")

  const unmanaged = ServerSuccessor.handoff(() => "0::/init.scope", exec({}).run)
  expect(unmanaged.attempted).toBe(false)
  expect(unmanaged.note).toContain("systemd user service")

  const refused = ServerSuccessor.handoff(
    () => userCgroup,
    exec({ ActiveState: { status: 0, stdout: "active\n" }, restart: failed }).run,
  )
  expect(refused).toMatchObject({ attempted: true, queued: false })
  expect(refused.note).toContain("NOT queued")
})

test("listening is proven by an HTTP answer, and a dead port gives up", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("not found", { status: 404 }) })
  const port = server.port ?? 0
  try {
    // Any status counts: the FE-001 gate answers 401/redirect on `/login` when a password is set.
    expect(await ServerSuccessor.listening(port, "0.0.0.0", 2_000)).toBe(true)
  } finally {
    server.stop(true)
  }
  expect(await ServerSuccessor.listening(port, "0.0.0.0", 300)).toBe(false)
})

test("a refused restart says why, because nothing is watching this terminal", () => {
  const refused = ServerSuccessor.handoff(
    () => userCgroup,
    exec({
      ActiveState: { status: 0, stdout: "active\n" },
      restart: { status: 1, stdout: "", stderr: "\nJob existing is conflicting with running job: start.\n" },
    }).run,
  )
  expect(refused.queued).toBe(false)
  expect(refused.note).toContain("Job existing is conflicting")
  // Without a message the exit status is still reported rather than an empty note.
  const silent = ServerSuccessor.handoff(() => userCgroup, exec({ ActiveState: { status: 0, stdout: "active\n" } }, failed).run)
  expect(silent.note).toContain("systemctl exited 1")
})
