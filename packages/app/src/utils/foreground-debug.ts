// Debug logging that is ALWAYS on (no localStorage gate): lifecycle + sync
// events are reported to the server's /__debug sink, which logs them to server
// stdout (run-web.sh redirects that to testing/web-4447.log). The old gate
// (localStorage "foreground-debug" === "1") made failures invisible because the
// .catch(debugLog(...)) calls swallowed errors before any flag was ever set.
export const debugLog = (event: string, detail?: string) => {
  const line = [`t=${Date.now()}`, event, detail ?? ""].filter(Boolean).join(" ")
  if (location.pathname === "/__debug") return
  void fetch(`/__debug?m=${encodeURIComponent(line)}`, { keepalive: true }).catch(() => {})
}
