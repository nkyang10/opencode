/**
 * Where the commentary speech proxy is allowed to connect.
 *
 * The host is a user setting, so it reaches an outbound request: this is an SSRF sink, and the route that
 * consumes it is reachable by anyone who can authenticate to the server. The speech box is on the LAN, so
 * private addresses and DNS names have to keep working — what is refused is the shape of host string that
 * turns "speak this line" into "fetch something else": a scheme or path or credentials smuggled in beside
 * the host, and the loopback / link-local targets that are never a speech service.
 */

export const DEFAULT_SPEECH_HOST = "192.168.1.162:8880"

/** A bare `host`, `host:port` or IPv4 literal. No scheme, no path, no credentials, no IPv6 bracket form. */
const HOST_PATTERN = /^[A-Za-z0-9._-]+(:\d{1,5})?$/

/**
 * The base URL to synthesize the speech request against, or `undefined` when the host is not acceptable.
 * An empty host falls back to the default, which is what an unset Settings field sends.
 */
export function speechBaseUrl(host: string | undefined) {
  const trimmed = (host ?? "").trim().replace(/\/+$/, "")
  if (!trimmed) return `http://${DEFAULT_SPEECH_HOST}`
  if (!HOST_PATTERN.test(trimmed)) return undefined
  const [address, port] = trimmed.split(":")
  // Port 0 and anything past the 16-bit range are never a listening speech service, and letting them
  // through would hand the client a connection error instead of a clear rejection.
  if (port !== undefined && (Number(port) === 0 || Number(port) > 65_535)) return undefined
  // 169.254.0.0/16 is link-local and contains the 169.254.169.254 metadata address; 127/8 is this machine.
  // Neither is a speech box, and both are the reason this function exists.
  if (/^169\.254\./.test(address)) return undefined
  if (/^127\./.test(address)) return undefined
  if (address === "localhost" || address.endsWith(".localhost")) return undefined
  if (address === "0.0.0.0") return undefined
  return `http://${trimmed}`
}