import { Component, Show, createEffect, createResource, createSignal } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import type { Config } from "@opencode-ai/sdk/v2/client"
import { fetchWebuiStatus, type WebuiStatus } from "@/utils/server"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

// FE-023: server-wide settings, stored in the global config file
// (`~/.config/opencode/opencode.json(c)`) so they apply to every user of this
// server. Rows send only the leaf they changed: a config patch deep-merges, but
// arrays are replaced rather than merged, so patching the whole `server` object
// would clobber `server.cors`.
//
// The port is read once when the process starts, so a saved port shows up here as
// "running on X, restart to apply Y" until the next start. `GET /global/webui`
// reports both, which is the only reason this tab can tell the truth about it.
export const SettingsAdminV2: Component = () => {
  const language = useLanguage()
  const server = useServer()
  const serverSync = useServerSync()
  const [busy, setBusy] = createSignal(false)
  const [portDraft, setPortDraft] = createSignal<string>()
  const [portError, setPortError] = createSignal<string>()

  const [status, { refetch }] = createResource(
    () => server.current?.http,
    (http) => fetchWebuiStatus({ server: http }),
  )

  createEffect(() => {
    const current = status()
    if (!current) return
    setPortError(undefined)
    setPortDraft((draft) => draft ?? String(current.configuredPort ?? current.defaultPort))
  })

  const parsedPort = () => {
    const value = Number(portDraft()?.trim())
    if (!value || !Number.isInteger(value) || value < 1 || value > 65535) return undefined
    return value
  }

  const portChanged = () => {
    const current = status()
    if (!current) return false
    const value = parsedPort()
    if (!value) return false
    return value !== (current.configuredPort ?? current.defaultPort)
  }

  const updateServerConfig = (patch: Config) => serverSync().updateConfig(patch)
  // The published SDK types predate `server.webui` (FE-023), so this one patch is cast
  // at the single place it is built; the server schema accepted the key with the
  // change and the SDK is regenerated separately.
  const updateAutoStart = (autoStart: boolean) =>
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- generated SDK types predate server.webui
    serverSync().updateConfig({ server: { webui: { autoStart } } } as Config)

  const savePort = async () => {
    const value = parsedPort()
    if (!value) {
      setPortError(language.t("settings.admin.row.port.invalid"))
      return
    }
    setBusy(true)
    await updateServerConfig({ server: { port: value } })
      .then(async () => {
        setPortError(undefined)
        setPortDraft(String(value))
        await refetch()
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("settings.admin.row.port.saved.title", { port: value }),
        })
      })
      .catch((err: unknown) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => setBusy(false))
  }

  const setAutoStart = async (autoStart: boolean) => {
    const before = status()?.autoStart ?? false
    setBusy(true)
    await updateAutoStart(autoStart)
      .then(() => {
        void refetch()
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t(autoStart ? "settings.admin.row.autoStart.on.title" : "settings.admin.row.autoStart.off.title"),
        })
      })
      .catch((err: unknown) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
        if (before === autoStart) return
      })
      .finally(() => setBusy(false))
  }

  const runningLine = (current: WebuiStatus) => {
    if (current.restartRequired)
      return language.t("settings.admin.note.restartRequired", {
        running: current.runningPort ?? 0,
        configured: current.configuredPort ?? current.defaultPort,
      })
    if (current.runningPort === null) return language.t("settings.admin.note.noListener")
    if (current.configuredPort === null)
      return language.t("settings.admin.note.unconfigured", { running: current.runningPort })
    return language.t("settings.admin.note.running", { running: current.runningPort })
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.tab.admin")}</h2>
      </div>

      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.admin.section.webui")}</h3>
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.admin.row.autoStart.title")}
              description={language.t("settings.admin.row.autoStart.description")}
            >
              <div data-action="settings-admin-webui-auto-start">
                <Switch
                  checked={status()?.autoStart ?? false}
                  disabled={busy() || status() === undefined}
                  onChange={(checked) => void setAutoStart(checked)}
                />
              </div>
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.admin.row.port.title")}
              description={language.t("settings.admin.row.port.description")}
            >
              <div class="w-full sm:w-[220px] flex items-center gap-2" data-action="settings-admin-webui-port">
                <TextInputV2
                  type="text"
                  inputmode="numeric"
                  appearance="base"
                  value={portDraft() ?? ""}
                  placeholder={String(status()?.defaultPort ?? "")}
                  disabled={busy() || status() === undefined}
                  invalid={portError() !== undefined}
                  onInput={(event) => {
                    setPortDraft(event.currentTarget.value)
                    setPortError(undefined)
                  }}
                  onBlur={() => {
                    if (portDraft()?.trim() === "" || parsedPort()) setPortError(undefined)
                    else setPortError(language.t("settings.admin.row.port.invalid"))
                  }}
                  spellcheck={false}
                  autocorrect="off"
                  autocomplete="off"
                  autocapitalize="off"
                  aria-label={language.t("settings.admin.row.port.title")}
                />
                <ButtonV2
                  size="normal"
                  variant="neutral"
                  disabled={busy() || !portChanged()}
                  onClick={() => void savePort()}
                >
                  {language.t("common.save")}
                </ButtonV2>
              </div>
            </SettingsRowV2>
          </SettingsListV2>

          <Show when={portError()}>{(error) => <p class="settings-v2-server-dialog-error">{error()}</p>}</Show>
          <Show when={status()}>
            {(current) => <p class="settings-v2-note">{runningLine(current())}</p>}
          </Show>
        </div>
      </div>
    </>
  )
}
