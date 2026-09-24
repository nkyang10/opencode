#!/usr/bin/env bun
/**
 * release.ts — fork release orchestration (DEC-037).
 *
 * Manages the monotonic `-fork.<N>` release counter and stamps the version/channel
 * so downstream builds (packages/opencode/script/build.ts via Script.version) emit
 * a SemVer fingerprint instead of the bare `0.0.0-<channel>-<ts>` default.
 *
 * Version grammar (single source of truth = packages/opencode/package.json version):
 *   dev    base-fork.<N>-dev             (float, no tag)
 *   beta   base-fork.<N>-beta.<M>         tag v<ver>
 *   stable base-fork.<N>                  tag v<ver>
 * where base = upstream MAJOR.MINOR.PATCH mirrored from package version.
 * Applies in lockstep to packages/opencode, packages/app, packages/desktop.
 *
 * Usage (run from repo root):
 *   bun packages/script/release.ts                          print current line (dev)
 *   bun packages/script/release.ts --channel beta           print beta line
 *   bun packages/script/release.ts --channel beta --bump    roll beta.<M>
 *   bun packages/script/release.ts --channel stable --bump  roll the fork.<N> counter
 *   bun packages/script/release.ts --sync-upstream          carry -fork.<N> onto the
 *                                                           (new) base in package.jsons
 *   bun packages/script/release.ts --json                   machine-readable output
 *   bun packages/script/release.ts --dry                    never write files
 */

import path from "path"

const CHANNELS = ["dev", "beta", "stable"] as const
type Channel = (typeof CHANNELS)[number]

const cwd = path.resolve(import.meta.dir, "../..") // fork repo root
const PKG_PATHS = [
  "packages/opencode/package.json",
  "packages/app/package.json",
  "packages/desktop/package.json",
].map((p) => path.join(cwd, p))

function parseArgs(argv = Bun.argv) {
  const args = argv.slice(2)
  const valueFor = (flag: string) => {
    const inline = args.find((a) => a.startsWith(`${flag}=`))?.split("=")[1]
    const i = args.indexOf(flag)
    return inline ?? (i !== -1 ? args[i + 1] : undefined)
  }
  return {
    channel: (valueFor("--channel") ?? "dev") as Channel,
    bump: args.includes("--bump"),
    syncUpstream: args.includes("--sync-upstream"),
    json: args.includes("--json"),
    dry: args.includes("--dry"),
  }
}

// Date-versioned dev channel: dev deploys get `1.0.YYYYMMDD-N-HHHH` where N is a
// per-day counter that increments on each build/deploy and HHHH is a build-unique
// hex suffix derived from wall-clock time + entropy. The counter lives in a local
// state file (gitignored) and resets to 1 on a new UTC day; the time+entropy
// suffix guarantees every build emits a globally distinct version string no
// matter how many machines build in parallel or whether a day's counter resets —
// so the client's health-version change (deploy notification) always fires.
// Real release channels (beta/stable) keep DEC-037's monotonic `-fork.<N>` scheme.
function buildUniqueSuffix(now: Date): string {
  const ts =
    now.getUTCFullYear().toString() +
    String(now.getUTCMonth() + 1).padStart(2, "0") +
    String(now.getUTCDate()).padStart(2, "0") +
    String(now.getUTCHours()).padStart(2, "0") +
    String(now.getUTCMinutes()).padStart(2, "0") +
    String(now.getUTCSeconds()).padStart(2, "0") +
    "000"
  const millis = String(now.getUTCMilliseconds()).padStart(3, "0")
  const random = Math.random().toString(16).slice(2, 8).padEnd(6, "0")
  return ts + millis + random
}

async function devDateVersion(cwdPath: string): Promise<string> {
  const now = new Date()
  const yyyymmdd =
    now.getUTCFullYear().toString() +
    String(now.getUTCMonth() + 1).padStart(2, "0") +
    String(now.getUTCDate()).padStart(2, "0")
  const stateDir = path.join(cwdPath, "packages/script/state")
  const statePath = path.join(stateDir, "dev-version.json")
  let n = 0
  try {
    const prev = await Bun.file(statePath).json()
    if ((prev as { day?: string; n?: unknown } | null)?.day === yyyymmdd && typeof (prev as { n?: unknown }).n === "number")
      n = (prev as { n: number }).n
  } catch {
    // no prior state yet — fresh counter
  }
  n += 1
  await Bun.write(statePath, JSON.stringify({ day: yyyymmdd, n }, null, 2) + "\n")
  return `1.0.${yyyymmdd}-${String(n).padStart(2, "0")}-${buildUniqueSuffix(now)}`
}

function readBase(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!m) throw new Error(`version ${version} is not parseable as MAJOR.MINOR.PATCH pre-release`)
  return `${m[1]}.${m[2]}.${m[3]}`
}

function readForkN(version: string): number {
  const m = /-fork\.(\d+)/.exec(version)
  return m ? Number(m[1]) : 0
}

function readBetaM(version: string): number {
  const m = /-beta\.(\d+)/.exec(version)
  return m ? Number(m[1]) : 0
}

async function readVersion(path: string): Promise<string> {
  const pkg = await Bun.file(path).json()
  return pkg.version
}

async function writeVersions(version: string, dry: boolean) {
  if (dry) {
    console.error(`[release] --dry: would write version = ${version}`)
    return
  }
  for (const p of PKG_PATHS) {
    const pkg = await Bun.file(p).json()
    pkg.version = version
    await Bun.write(p, JSON.stringify(pkg, null, 2) + "\n")
    console.error(`[release] wrote ${path.relative(cwd, p)} → ${version}`)
  }
}

async function main() {
  const opts = parseArgs()
  if (!(CHANNELS as readonly string[]).includes(opts.channel)) {
    throw new Error(`unknown channel: ${opts.channel} (valid: ${CHANNELS.join(", ")})`)
  }
  if ((opts.bump && opts.syncUpstream) || (opts.bump && opts.channel === "dev")) {
    throw new Error(
      `invalid combo: --bump with channel=${opts.channel} — dev is date-versioned (1.0.YYYYMMDD-N-HHHH, never hand-bumped); ` +
        `--bump and --sync-upstream are mutually exclusive`,
    )
  }

  const corePkgPath = path.join(cwd, "packages/opencode/package.json")
  const current = await readVersion(corePkgPath)
  const base = readBase(current)
  let forkN = readForkN(current)

  if (opts.syncUpstream) {
    // Carry the counter onto whatever base is currently in package.jsons.
    forkN = Math.max(forkN, 1)
  } else if (opts.bump) {
    if (opts.channel === "stable") {
      forkN += 1
    } else if (opts.channel === "beta") {
      const betaM = readBetaM(current) + 1
      await writeVersions(`${base}-fork.${Math.max(forkN, 1)}-beta.${betaM}`, opts.dry || false)
      if (opts.json) process.stdout.write(JSON.stringify(
        { version: `${base}-fork.${Math.max(forkN, 1)}-beta.${betaM}`,
          base, fork: Math.max(forkN, 1), channel: "beta", betaM }, null, 2) + "\n")
      return
    }
  } else {
    forkN = Math.max(forkN, 1)
  }

  const version = opts.channel === "stable"
    ? `${base}-fork.${forkN}`
    : opts.channel === "beta"
      ? `${base}-fork.${forkN}-beta.${readBetaM(current) || 1}`
      : await devDateVersion(cwd)

  if (opts.bump && opts.channel === "stable") {
    await writeVersions(version, opts.dry || false)
  }

  // CRITICAL: OPENCODE_CHANNEL doubles as the SQLite database filename suffix
  // (packages/core/src/database/database.ts path()). It MUST stay "mark-dev" so the
  // fork never shares/points at the upstream "opencode.db" or a spuriously-named DB.
  // Fork channel semantics (dev/beta/stable) live ONLY in the version string, never
  // in OPENCODE_CHANNEL. Channel "mark-dev" -> opencode-mark-dev.db (fork data).
  const out = {
    version,
    base,
    fork: forkN,
    channel: opts.channel,
    dbChannel: "mark-dev",
    env: {
      OPENCODE_VERSION: version,
      OPENCODE_CHANNEL: "mark-dev",
    },
  }

  if (opts.json || !process.stdout.isTTY) {
    process.stdout.write(JSON.stringify(out, null, 2) + "\n")
    return
  }

  console.log(`\n[release] fork line:  ${version}`)
  console.log(`           upstream: ${base}`)
  console.log(`           channel:  ${opts.channel}`)
  console.log(`\nBuild invocation (stamps build.ts/@{oai-script}):\n`)
  console.log(
    `  OPENCODE_VERSION='${version}' ` +
      `OPENCODE_CHANNEL='${out.env.OPENCODE_CHANNEL}' ` +
      `bun ./packages/opencode/script/build.ts ${opts.channel === "dev" ? "--single" : "--single --sourcemaps"}\n`,
  )
  if (opts.channel !== "dev") console.log(`Tag when published:  v${version}`)
}

await main()
