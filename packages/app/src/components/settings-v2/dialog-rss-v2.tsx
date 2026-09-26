import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { type Component, createSignal } from "solid-js"
import { useLanguage } from "@/context/language"
import "./settings-v2.css"

export const DialogRssV2: Component<{ url: string }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const [copied, setCopied] = createSignal(true)

  const copyToClipboard = (value: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      return navigator.clipboard.writeText(value)
    }
    const textarea = document.createElement("textarea")
    textarea.value = value
    textarea.style.position = "fixed"
    textarea.style.opacity = "0"
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand("copy")
    textarea.remove()
    return Promise.resolve()
  }

  let copyTimer: ReturnType<typeof setTimeout> | undefined
  const copyAll = () => {
    if (!props.url || typeof navigator === "undefined") return
    setCopied(true)
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => setCopied(false), 1500)
    void copyToClipboard(props.url)
  }

  const selectAll = (event: FocusEvent) => {
    const target = event.currentTarget as HTMLTextAreaElement
    target.select()
  }

  return (
    <Dialog fit class="settings-v2-server-dialog">
      <DialogHeader hideClose={true}>
        <DialogTitle>{language.t("settings.general.notifications.rss.dialog.title")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="flex w-full min-w-0 flex-1 flex-col px-4 pt-4 pb-2">
        <div class="flex w-full min-w-0 flex-col gap-3">
          <p class="settings-v2-rss-dialog-description">
            {language.t("settings.general.notifications.rss.dialog.description")}
          </p>
          <TextareaV2
            class="!w-full self-stretch"
            value={props.url}
            readOnly
            rows={3}
            autofocus
            onFocus={selectAll}
            spellcheck={false}
          />
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2
          variant="neutral"
          icon={copied() ? "check" : "outline-copy"}
          onClick={copyAll}
        >
          {copied()
            ? language.t("settings.general.notifications.rss.copied")
            : language.t("settings.general.notifications.rss.dialog.copyAll")}
        </ButtonV2>
        <ButtonV2 variant="contrast" onClick={() => dialog.close()}>
          {language.t("settings.general.notifications.rss.dialog.done")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
