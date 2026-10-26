// Who brings the next version of this server up.
//
// A deploy stops the web server with SIGTERM, the drain exits with status 0, and a systemd user unit
// with `Restart=on-failure` does not restart a clean exit. That is how a deploy left port 4447 dead
// until a human ran `systemctl --user restart`: nothing in the flow owned the successor. This module is
// the single place that decides whether the process being stopped has to arrange one, and how.
//
// Two measured constraints, from a probe unit on the same box, because the obvious answers are wrong:
//
// - `systemctl show -p JobType` reads empty even while systemd is running our own stop job, so it does
//   not distinguish "systemd is stopping me" from "a deploy killed me". `ActiveState` does: a bare
//   `kill` arrives while the unit still reads `active/running` (systemd has no idea this is happening),
//   while `systemctl stop` and `systemctl restart` both arrive as `deactivating/stop-sigterm`. Only the
//   first case needs a handoff. In the second, systemd is already committed to starting the successor
//   (restart) or an operator deliberately stopped the service (stop); either way this process must not
//   queue a job that fights the one already running.
//
// - A successor spawned by this process cannot survive a unit: `KillMode` defaults to `control-group`,
//   so systemd SIGKILLs everything left in the cgroup once the main process exits. The replacement has
//   to be requested from the user manager, and `--no-block` is load-bearing — a blocking
//   `systemctl restart` waits for the unit's stop job, which waits for this process to exit, which is
//   the thing it would be waiting on.

import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"

const cgroupPath = "/proc/self/cgroup"

export type Handoff = {
  /** True when this process actually asked its service manager for a replacement. */
  attempted: boolean
  /** True only when the restart job was accepted. */
  queued: boolean
  unit?: string
  /** One line for the log: what was decided and why, because nobody is watching this terminal. */
  note: string
}

export type Result = { status: number | null; stdout: string; stderr?: string }
export type Read = () => string
export type Run = (command: string, args: string[]) => Result

function run(command: string, args: string[]): Result {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 5_000 })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

/**
 * The systemd **user** unit owning this process, or undefined when nothing supervises it.
 *
 * The last `.service` component of the cgroup path is the unit; earlier ones are its slices and the
 * `user@1000.service` manager above it. `user.slice` is required on purpose: restarting a *system*
 * unit from an unprivileged process is not possible, so claiming support there would be a lie.
 */
export function unit(read: Read = () => readFileSync(cgroupPath, "utf8")) {
  let cgroup: string
  try {
    cgroup = read()
  } catch {
    // No procfs (non-Linux, or a container without /proc) simply means nothing supervises us here.
    return undefined
  }
  const path = cgroup
    .split("\n")
    .map((line) => line.slice(line.indexOf("::") + 2))
    .find((line) => line.startsWith("/user.slice/"))
  if (!path) return undefined
  const name = path.split("/").at(-1)
  if (!name?.endsWith(".service")) return undefined
  return name
}

/**
 * True when systemd is already running a job for us, so the replacement is not ours to start. A unit
 * that still reads `active` means the stop signal came from outside systemd — a deploy script or a
 * bare `kill` — and nobody else knows this process is about to die.
 */
export function owned(name: string, exec: Run = run) {
  const result = exec("systemctl", ["--user", "show", name, "-p", "ActiveState", "--value"])
  if (result.status !== 0) return true
  // `--value` prints the bare state, no `Key=` prefix.
  const state = result.stdout.trim()
  if (!state) return true
  return state !== "active"
}

/** Queue the unit's restart with the user manager and return immediately. See the `--no-block` note. */
export function request(name: string, exec: Run = run) {
  return exec("systemctl", ["--user", "restart", "--no-block", name])
}

export function queue(name: string, exec: Run = run) {
  return request(name, exec).status === 0
}

/** Decide and act. Safe to call from a signal handler: synchronous, bounded, never throws. */
export function handoff(read: Read = () => readFileSync(cgroupPath, "utf8"), exec: Run = run): Handoff {
  const name = unit(read)
  if (!name)
    return {
      attempted: false,
      queued: false,
      note: "no successor queued: this process is not running as a systemd user service, so nothing will restart it",
    }
  if (owned(name, exec))
    return {
      attempted: false,
      queued: false,
      unit: name,
      note: `no successor queued: systemd owns this stop for ${name} (stop or restart job in flight)`,
    }
  const result = request(name, exec)
  return {
    attempted: true,
    queued: result.status === 0,
    unit: name,
    note:
      result.status === 0
        ? `successor queued: systemctl --user restart ${name}`
        : `successor NOT queued for ${name}: ${failure(result) || `systemctl exited ${result.status}`}`,
  }
}

/**
 * systemctl's reason, first line only. A refused job is otherwise invisible here: the message says
 * exactly which job is already in flight, and it is the only trace left when the port stays dead.
 */
function failure(result: Result) {
  return (result.stderr ?? "").split("\n").find((line) => line.trim())?.trim().slice(0, 300) ?? ""
}

/**
 * Poll a port until something answers HTTP on it. An answer of *any* status counts as listening: with
 * the FE-001 gate configured `/login` answers 200, without it the same request redirects, and either
 * way the listener is back. Used to prove a successor is really serving before the predecessor exits.
 */
export async function listening(port: number, hostname: string, timeoutMs: number) {
  const host = hostname === "0.0.0.0" || hostname === "::" || !hostname ? "127.0.0.1" : hostname
  const url = `http://${host}:${port}/login`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await fetch(url, { method: "GET", signal: AbortSignal.timeout(1_000) })
      return true
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  return false
}

export * as ServerSuccessor from "./successor"
