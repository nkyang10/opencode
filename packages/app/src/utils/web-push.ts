const PUSH_ENDPOINT = "/api/push"
const SW_PATH = "/sw.js"

export interface PushSubscriptionBody {
  endpoint: string
  expirationTime: number | null
  keys: { p256dh: string; auth: string }
}

export function webPushSupported() {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    window.isSecureContext
  )
}

function base64UrlEncode(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function toSubscriptionBody(subscription: PushSubscription): PushSubscriptionBody {
  return {
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime,
    keys: {
      p256dh: base64UrlEncode(subscription.getKey("p256dh")!),
      auth: base64UrlEncode(subscription.getKey("auth")!),
    },
  }
}

async function pubKey(): Promise<ArrayBuffer> {
  const response = await fetch(`${PUSH_ENDPOINT}/pubkey`, { credentials: "same-origin" })
  if (!response.ok) throw new Error(`push pubkey ${response.status}`)
  const { publicKey } = (await response.json()) as { publicKey: string }
  const binary = atob(publicKey.replace(/-/g, "+").replace(/_/g, "/"))
  const keyBuffer = new ArrayBuffer(binary.length)
  const bytes = new Uint8Array(keyBuffer)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return keyBuffer
}

async function register(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register(SW_PATH)
}

export async function enableWebPush(): Promise<boolean> {
  if (!webPushSupported()) return false
  let registration: ServiceWorkerRegistration
  try {
    registration = await register()
  } catch {
    return false
  }
  const permission = await Notification.requestPermission()
  if (permission !== "granted") return false
  try {
    const applicationServerKey = await pubKey()
    let subscription = await registration.pushManager.getSubscription()
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      })
    }
    const response = await fetch(`${PUSH_ENDPOINT}/subscribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(toSubscriptionBody(subscription)),
    })
    return response.ok
  } catch {
    return false
  }
}

export async function disableWebPush(): Promise<boolean> {
  if (!webPushSupported()) return true
  let subscription: PushSubscription | null = null
  try {
    const registration = await navigator.serviceWorker.ready
    subscription = await registration.pushManager.getSubscription()
  } catch {
    return true
  }
  if (subscription) {
    try {
      await fetch(`${PUSH_ENDPOINT}/unsubscribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      })
      await subscription.unsubscribe()
    } catch {
      return false
    }
  }
  return true
}
