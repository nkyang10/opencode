import { createMemo, Show } from "solid-js"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import type { ImageViewerItem } from "@opencode-ai/ui/image-viewer"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { useData } from "../context"
import { ImageActionsContext, ImageActionsDropdown, useImageGallery } from "./image-actions-menu"
import { shownImage } from "./shown-image"

export function ShownImageCard(props: { part: ToolPart }) {
  const data = useData()
  const i18n = useI18n()
  const gallery = useImageGallery()
  const image = createMemo(() => shownImage(props.part))
  const fallbackName = () => i18n.t("ui.toolMedia.image")
  const alt = () => {
    const current = image()
    return current?.caption ?? current?.name ?? fallbackName()
  }
  const title = () => {
    const current = image()
    return current?.caption ?? current?.name ?? fallbackName()
  }
  const meta = () => {
    const current = image()
    return current?.filename ?? current?.name
  }
  const dimensions = () => {
    const current = image()
    if (!current?.width || !current?.height) return
    return i18n.t("ui.imageViewer.dimensions", { width: current.width, height: current.height })
  }
  const aspectRatio = () => {
    const current = image()
    if (!current?.width || !current?.height) return
    return current.width / current.height
  }
  const previewStyle = () => {
    const ratio = aspectRatio()
    if (ratio === undefined) return
    return `--shown-image-card-aspect-ratio: ${ratio}`
  }
  const target = createMemo<ImageViewerItem | undefined>(() => {
    const current = image()
    if (!current) return
    return {
      src: current.url,
      alt: alt(),
      caption: current.caption,
      filename: current.filename ?? current.name,
      mime: current.mime,
      width: current.width,
      height: current.height,
      source: current.path ? `${props.part.tool} · ${current.path}` : props.part.tool,
      path: current.path,
      messageID: props.part.messageID,
      partID: props.part.id,
      full: current.full,
    }
  })
  let imageRef: HTMLButtonElement | undefined
  const open = (source?: HTMLElement | null) => {
    const current = target()
    if (!current) return
    gallery.open({
      sessionID: props.part.sessionID || data.sessionID || "",
      target: current,
      source,
    })
  }

  return (
    <Show when={target()}>
      {(item) => (
        <div data-component="shown-image-card">
          <div data-slot="shown-image-card-header">
            <div data-slot="shown-image-card-text">
              <div data-slot="shown-image-card-title" dir="auto">
                {title()}
              </div>
              <div data-slot="shown-image-card-meta">
                <Show when={meta()}>
                  {(name) => (
                    <span data-slot="shown-image-card-filename" dir="ltr">
                      {name()}
                    </span>
                  )}
                </Show>
                <Show when={dimensions()}>
                  {(value) => <span data-slot="shown-image-card-dimensions">{value()}</span>}
                </Show>
              </div>
            </div>
            <div data-slot="shown-image-card-actions">
              <ImageActionsDropdown target={item()} onOpen={(source) => open(source)} source={() => imageRef} />
            </div>
          </div>
          <ImageActionsContext target={item()} onOpen={(source) => open(source)}>
            <button
              ref={imageRef}
              type="button"
              data-slot="shown-image-card-image"
              data-ratio={aspectRatio() === undefined ? undefined : "true"}
              style={previewStyle()}
              aria-label={i18n.t("ui.toolMedia.openImage", { name: alt() })}
              title={alt()}
              onClick={(event) => open(event.currentTarget)}
            >
              <img
                data-slot="shown-image-card-image-content"
                src={item().src}
                alt={alt()}
                width={image()?.width}
                height={image()?.height}
                loading="lazy"
                decoding="async"
              />
            </button>
          </ImageActionsContext>
        </div>
      )}
    </Show>
  )
}
