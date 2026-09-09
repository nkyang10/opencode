const TITLE = "OpenCode"
const ICON = "/web-app-manifest-192x192.png"

self.addEventListener("install", () => {
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener("push", (event) => {
  if (!(self.Notification && self.Notification.permission === "granted")) return
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = {}
  }
  const title = payload.title || TITLE
  const options = {
    body: payload.body || "",
    icon: ICON,
    badge: ICON,
    data: { url: payload.url || "/" },
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || "/"
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.focus()
          return
        }
      }
      return self.clients.openWindow(url)
    }),
  )
})
