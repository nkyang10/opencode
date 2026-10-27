import { createMemo, For, Show } from "solid-js"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { ImagePreview } from "@opencode-ai/ui/image-preview"
import { typeLabel } from "./message-file"
import { toolMedia } from "./tool-media"

export function ToolMedia(props: { part: ToolPart | undefined; compact?: boolean }) {
  const dialog = useDialog()
  const i18n = useI18n()
  const items = createMemo(() => toolMedia(props.part))

  return (
    <Show when={items().length > 0}>
      <div data-component="tool-media" data-compact={props.compact ? "true" : undefined}>
        <For each={items()}>
          {(item) => {
            const name = item.filename ?? i18n.t(item.kind === "image" ? "ui.toolMedia.image" : "ui.toolMedia.file")
            const open = () => dialog.show(() => <ImagePreview src={item.url} alt={name} />)

            return (
              <Show
                when={item.kind === "image"}
                fallback={
                  <div data-slot="tool-media-chip" data-mime={item.mime}>
                    <FileIcon node={{ path: name, type: "file" }} />
                    <span data-slot="tool-media-chip-name">{name}</span>
                    <span data-slot="tool-media-chip-type">
                      {typeLabel(item.filename ?? "", item.mime, i18n.t("ui.toolMedia.file"))}
                    </span>
                  </div>
                }
              >
                <button
                  type="button"
                  data-slot="tool-media-image"
                  data-mime={item.mime}
                  aria-label={i18n.t("ui.toolMedia.openImage", { name })}
                  title={name}
                  onClick={open}
                >
                  <img data-slot="tool-media-image-content" src={item.url} alt={name} loading="lazy" decoding="async" />
                </button>
              </Show>
            )
          }}
        </For>
      </div>
    </Show>
  )
}
