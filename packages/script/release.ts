#!/usr/bin/env bun
/**
 * release.ts — fork release orchestration (DEC-041, supersedes DEC-037 grammar).
 *
 * Produces a SINGLE unified user-facing version string shown identically by the
 * engine (/api/health), the webui (Settings), and the desktop wrapper (About):
 *
 *   1.<MAJOR>.<YYYYMMDDHHMMSS>
 *
 * where:
 *   `1`        = web-wrapper product major (fixed)
 *   `<MAJOR>`  = fork/feature major counter (starts at 1, bumped on stable releases)
 *   `<YYYYMMDDHHMMSS>` = 14-digit UTC timestamp of the deploy / installer build
 *
 * This applies to ALL channels (dev, beta, stable) — the old DEC-037 `-fork.<N>`
 * / `-beta.<M>` / `-dev` suffix scheme is dropped. The timestamp makes every
 * build/uniquely versioned, so a client's health-version change always fires the
 * deploy-notification toast.
 *
 * Applies in lockstep to packages/opencode, packages/app, packages/desktop.
 *
 * Usage (run from repo root):
 *   bun packages/script/release.ts                          print current line (dev)
 *   bun packages/script/release.ts --channel beta           print beta line
 *   bun packages/script/release.ts --channel stable         print stable line
 *   bun packages/script/release.ts --channel stable --bump  roll the <MAJOR> counter
 *   bun packages/script/release.ts --json                   machine-readable output
 *   bun packages/script/release.ts --dry                    never write files
 *
 * Note: --sync-upstream is no longer needed (no upstream base is mirrored into the
 * version string); kept as a no-op passthrough for compatibility.
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

// 14-digit UTC deploy timestamp (YYYYMMDDHHMMSS) — wall-clock seconds. Unique enough
// per build because two builds for the same channel rarely share the same second;
// when they do, the string is still monotonic across deploys and always differs
// from any prior deploy at a different second of the (future) clock.
function utcDeployStamp(now: Date): string {
  return (
    now.getUTCFullYear().toString() +
    String(now.getUTCMonth() + 1).padStart(2, "0") +
    String(now.getUTCDate()).padStart(2, "0") +
    String(now.getUTCHours()).padStart(2, "0") +
    String(now.getUTCMinutes()).padStart(2, "0") +
    String(now.getUTCSeconds()).padStart(2, "0")
  )
}

// Read the current fork <MAJOR> counter (the middle component of `1.<MAJOR>.<ts>`).
// Falls back to 1 when the stored version isn't yet in the unified grammar.
function readForkMajor(version: string): number {
  const m = /^1\.(\d+)\.\d{14}$/.exec(version)
  return m ? Number(m[1]) : 1
}

async function readVersion(p: string): Promise<string> {
  const pkg = await Bun.file(p).json()
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

function buildVersion(forkMajor: number, now: Date): string {
  return `1.${forkMajor}.${utcDeployStamp(now)}`
}

async function main() {
  const opts = parseArgs()
  if (!(CHANNELS as readonly string[]).includes(opts.channel)) {
    throw new Error(`unknown channel: ${opts.channel} (valid: ${CHANNELS.join(", ")})`)
  }
  if (opts.bump && opts.syncUpstream) {
    throw new Error(`--bump and --sync-upstream are mutually exclusive`)
  }

  const corePkgPath = path.join(cwd, "packages/opencode/package.json")
  const current = await readVersion(corePkgPath)
  let forkMajor = readForkMajor(current)

  if (opts.bump) {
    if (opts.channel === "stable") {
      forkMajor += 1
    } else if (opts.channel === "beta") {
      forkMajor += 1
    }
  }

  const version = buildVersion(forkMajor, new Date())

  if (opts.bump) {
    await writeVersions(version, opts.dry || false)
  }

  // CRITICAL: OPENCODE_CHANNEL doubles as the SQLite database filename suffix
  // (packages/core/src/database/database.ts path()). It MUST stay "mark-dev" so the
  // fork never shares/points at the upstream "opencode.db" or a spuriously-named DB.
  // Fork channel semantics (dev/beta/stable) live ONLY in the version string, never
  // in OPENCODE_CHANNEL. Channel "mark-dev" -> opencode-mark-dev.db (fork data).
  const out = {
    version,
    major: forkMajor,
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
  console.log(`           major:    ${forkMajor}`)
  console.log(`           channel:  ${opts.channel}`)
  console.log(`\nBuild invocation (stamps build.ts/@{oai-script}):\n`)
  console.log(
    `  OPENCODE_VERSION='${version}' ` +
      `OPENCODE_CHANNEL='${out.env.OPENCODE_CHANNEL}' ` +
      `bun ./packages/opencode/script/build.ts --single\n`,
  )
  console.log(`Tag when published:  v${version}`)
}

await main()
