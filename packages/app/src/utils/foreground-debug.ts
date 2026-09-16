let enabled = false
try {
  enabled = typeof localStorage !== "undefined" && localStorage.getItem("foreground-debug") === "1"
} catch {
  enabled = false
}

export const debugLog = (event: string, detail?: string) => {
  if (!enabled) return
  const line = [`t=${Date.now()}`, event, detail ?? ""].filter(Boolean).join(" ")
  if (location.pathname === "/__debug") return
  void fetch(`/__debug?m=${encodeURIComponent(line)}`, { keepalive: true }).catch(() => {})
}
