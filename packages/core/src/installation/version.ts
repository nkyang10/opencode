declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
  const OPENCODE_UPSTREAM_VERSION: string
}

export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
// The upstream release this fork tracks, stamped by packages/script. OpenCode's own
// services compare the version a client puts on the wire against upstream's numbering
// and reject anything below 1.18.0 — the Zen free tier answers HTTP 426
// "OpenCode 1.18.0 or newer is required to use the free tier" (anomalyco/opencode#50451).
// This fork's own version is `1.<counter>.<deploy-ts>` (DEC-042), which reads as 1.1.x and
// is therefore older than 1.18.0 to every one of those comparisons, so the provider
// User-Agent carries this value instead. A source run has no stamp and falls back to the
// fork version, which is the pre-existing behaviour.
export const UpstreamVersion =
  typeof OPENCODE_UPSTREAM_VERSION === "string" ? OPENCODE_UPSTREAM_VERSION : InstallationVersion
