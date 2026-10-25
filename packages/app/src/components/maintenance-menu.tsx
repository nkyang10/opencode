import { Show, createResource } from "solid-js"
import { createStore } from "solid-js/store"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Button } from "@opencode-ai/ui/button"
import { useLanguage } from "@/context/language"
import { useServer, type ServerConnection } from "@/context/server"
import { usePlatform } from "@/context/platform"
import { authTokenFromCredentials } from "@/utils/server"
import { showToast } from "@/utils/toast"

export async function hostMaintenanceRequest(
  server: ServerConnection.HttpBase,
  restart = false,
  fetcher = globalThis.fetch,
) {
  const response = await fetcher(`${server.url.replace(/\/+$/, "")}/global/${restart ? "restart" : "maintenance"}`, {
    method: restart ? "POST" : "GET",
    headers: {
      ...(server.password
        ? {
            Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
          }
        : {}),
      ...(restart ? { "Content-Type": "application/json" } : {}),
    },
    ...(restart ? { body: "{}" } : {}),
  })
  if (!response.ok) throw new Error(String(response.status))
  const value: unknown = await response.json()
  if (!value || typeof value !== "object") throw new Error("Invalid maintenance response")
  if (restart) {
    if (!("accepted" in value) || value.accepted !== true) throw new Error("Restart was not accepted")
    return { restartSupported: true, restarting: true }
  }
  if (
    !("restartSupported" in value) ||
    typeof value.restartSupported !== "boolean" ||
    !("restarting" in value) ||
    typeof value.restarting !== "boolean"
  )
    throw new Error("Invalid maintenance status")
  return { restartSupported: value.restartSupported, restarting: value.restarting }
}

export function MaintenanceMenu() {
  const language = useLanguage()
  const server = useServer()
  const platform = usePlatform()
  const dialog = useDialog()
  const [status] = createResource(
    () => server.current?.http,
    async (http) => hostMaintenanceRequest(http, false, platform.fetch).catch(() => undefined),
  )
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger>{language.t("menu.maintenance")}</DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent>
          <DropdownMenu.Item
            disabled={!status()?.restartSupported || status()?.restarting}
            onSelect={() => {
              const http = server.current?.http
              if (http) dialog.show(() => <RestartHostDialog server={http} />)
            }}
          >
            <DropdownMenu.ItemLabel>{language.t("menu.maintenance.restart")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <Show when={status() && !status()?.restartSupported}>
            <DropdownMenu.Item disabled>
              <DropdownMenu.ItemLabel>{language.t("menu.maintenance.unsupported")}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          </Show>
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  )
}

function RestartHostDialog(props: { server: ServerConnection.HttpBase }) {
  const language = useLanguage()
  const dialog = useDialog()
  const platform = usePlatform()
  const [state, setState] = createStore({ pending: false })
  const restart = async () => {
    if (state.pending) return
    setState("pending", true)
    await hostMaintenanceRequest(props.server, true, platform.fetch)
      .then(() => {
        dialog.close()
        showToast({ title: language.t("menu.maintenance.accepted") })
      })
      .catch(() => showToast({ title: language.t("common.requestFailed") }))
      .finally(() => setState("pending", false))
  }
  return (
    <Dialog title={language.t("menu.maintenance.restart")}>
      <div class="p-6 flex flex-col gap-4">
        <p>{language.t("menu.maintenance.confirm", { server: props.server.url })}</p>
        <div class="flex justify-end gap-2">
          <Button onClick={() => dialog.close()}>{language.t("common.cancel")}</Button>
          <Button variant="primary" disabled={state.pending} onClick={() => void restart()}>
            {language.t("menu.maintenance.restart")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
