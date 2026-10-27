import { createMemo, For, Show } from "solid-js"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { ImageActionsContext, ImageActionsDropdown, useImageGallery } from "./image-actions-menu"
import { toolImageViewerItem } from "./image-gallery"
import { typeLabel } from "./message-file"
import { toolMedia } from "./tool-media"

export function ToolMedia(props: { part: ToolPart | undefined; compact?: boolean }) {
  const i18n = useI18n()
  const gallery = useImageGallery()
  const items = createMemo(() => toolMedia(props.part))

  return (
    <Show when={items().length > 0}>
      <div data-component="tool-media" data-compact={props.compact ? "true" : undefined}>
        <For each={items()}>
          {(item) => {
            const name = item.filename ?? i18n.t(item.kind === "image" ? "ui.toolMedia.image" : "ui.toolMedia.file")
            const target = () =>
              toolImageViewerItem(props.part!, item, { image: i18n.t("ui.toolMedia.image") })
            let imageRef: HTMLButtonElement | undefined
            const open = (source?: HTMLElement | null) => {
              if (!props.part) return
              gallery.open({ sessionID: props.part.sessionID, target: target(), source })
            }

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
                <div data-slot="tool-media-image-group">
                  <ImageActionsContext target={target()} onOpen={(source) => open(source)}>
                    <button
                      ref={imageRef}
                      type="button"
                      data-slot="tool-media-image"
                      data-mime={item.mime}
                      aria-label={i18n.t("ui.toolMedia.openImage", { name })}
                      title={name}
                      onClick={(event) => open(event.currentTarget)}
                    >
                      <img
                        data-slot="tool-media-image-content"
                        src={item.url}
                        alt={name}
                        loading="lazy"
                        decoding="async"
                      />
                    </button>
                  </ImageActionsContext>
                  <ImageActionsDropdown
                    target={target()}
                    onOpen={(source) => open(source)}
                    source={() => imageRef}
                  />
                </div>
              </Show>
            )
          }}
        </For>
      </div>
    </Show>
  )
}
