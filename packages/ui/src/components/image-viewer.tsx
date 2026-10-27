import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { createEffect, createMemo, createSignal, on, Show, type JSX } from "solid-js"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { makeEventListener } from "@solid-primitives/event-listener"
import { useI18n } from "../context/i18n"
import { IconButton } from "./icon-button"

const MIN_ZOOM = 10
const MAX_ZOOM = 800
const FIT_PADDING = 32
const INLINE_IMAGE_SRC = /^data:image\/(png|jpeg|gif|webp);base64,/i

export type ImageViewerItem = {
  src: string
  alt: string
  caption?: string
  filename?: string
  mime?: string
  width?: number
  height?: number
  source?: string
  path?: string
  messageID?: string
  partID?: string
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function ImageViewer(props: {
  items: ImageViewerItem[]
  index: number
  onIndexChange: (index: number) => void
  onClose: () => void
  onCopy?: (item: ImageViewerItem) => void | Promise<void>
  onSave?: (item: ImageViewerItem) => void
  onActions?: (item: ImageViewerItem) => void
  copyDisabledReason?: string
  actionsMenu?: (item: ImageViewerItem) => JSX.Element
  onCloseAutoFocus?: (event: Event) => void
}) {
  const i18n = useI18n()

  const [zoom, setZoom] = createSignal(0)
  const [offset, setOffset] = createSignal({ x: 0, y: 0 })
  const [dragging, setDragging] = createSignal(false)
  const [stageSize, setStageSize] = createSignal({ width: 0, height: 0 })
  const [natural, setNatural] = createSignal({ width: 0, height: 0 })

  let stageRef: HTMLDivElement | undefined

  const current = createMemo(() => props.items[props.index])
  const title = createMemo(() => {
    const item = current()
    if (!item) return ""
    return item.caption ?? item.filename ?? item.alt
  })
  const dimensions = createMemo(() => {
    const item = current()
    const width = item?.width ?? natural().width
    const height = item?.height ?? natural().height
    if (!width || !height) return
    return { width, height }
  })
  const source = createMemo(() => current()?.source)

  const fitZoom = createMemo(() => {
    const image = natural()
    const stage = stageSize()
    if (!image.width || !image.height || !stage.width || !stage.height) return 100
    const scale = Math.min(
      (stage.width - FIT_PADDING) / image.width,
      (stage.height - FIT_PADDING) / image.height,
      1,
    )
    return clamp(scale * 100, MIN_ZOOM, MAX_ZOOM)
  })

  const effectiveZoom = () => (zoom() === 0 ? fitZoom() : zoom())
  const zoomPercent = () => Math.round(effectiveZoom())
  const zoomScale = () => effectiveZoom() / fitZoom()
  const canPan = () => effectiveZoom() > fitZoom() + 0.5
  const pixelated = () => effectiveZoom() >= 200
  const canPrevious = () => props.index > 0
  const canNext = () => props.index < props.items.length - 1

  const imageStyle = () => {
    const image = natural()
    const scale = fitZoom()
    if (!image.width || !image.height) return {}
    return {
      width: `${(image.width * scale) / 100}px`,
      height: `${(image.height * scale) / 100}px`,
    }
  }

  const imageTransform = () => {
    const value = offset()
    return `translate(-50%, -50%) translate(${value.x}px, ${value.y}px) scale(${zoomScale()})`
  }

  const stageCenter = () => {
    if (!stageRef) return { x: 0, y: 0 }
    const rect = stageRef.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }

  const zoomTo = (next: number, anchor?: { x: number; y: number }) => {
    const value = clamp(next, MIN_ZOOM, MAX_ZOOM)
    if (anchor) {
      const center = stageCenter()
      const currentOffset = offset()
      const dx = anchor.x - center.x
      const dy = anchor.y - center.y
      const ratio = value / effectiveZoom()
      setOffset({
        x: dx - (dx - currentOffset.x) * ratio,
        y: dy - (dy - currentOffset.y) * ratio,
      })
    }
    setZoom(value)
  }

  const zoomBy = (factor: number, anchor?: { x: number; y: number }) => {
    zoomTo(effectiveZoom() * factor, anchor)
  }

  const fit = () => {
    setZoom(0)
    setOffset({ x: 0, y: 0 })
  }

  const actual = () => {
    setZoom(100)
    setOffset({ x: 0, y: 0 })
  }

  const go = (delta: number) => {
    const next = props.index + delta
    if (next < 0 || next >= props.items.length) return
    props.onIndexChange(next)
  }

  const arrowShortcut = (direction: "previous" | "next") => {
    const rtl = typeof document !== "undefined" && document.documentElement.dir === "rtl"
    if (direction === "next") return rtl ? "←" : "→"
    return rtl ? "→" : "←"
  }

  const onWheel = (event: WheelEvent) => {
    event.preventDefault()
    const factor = event.ctrlKey ? Math.exp(-event.deltaY * 0.01) : Math.exp(-event.deltaY * 0.0015)
    zoomBy(factor, { x: event.clientX, y: event.clientY })
  }

  let drag: { x: number; y: number; offset: { x: number; y: number } } | undefined
  let swipe: { x: number; y: number } | undefined

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    if (canPan()) {
      drag = { x: event.clientX, y: event.clientY, offset: offset() }
      setDragging(true)
      const target = event.currentTarget as HTMLElement
      target.setPointerCapture(event.pointerId)
      event.preventDefault()
      return
    }
    if (event.pointerType !== "mouse") swipe = { x: event.clientX, y: event.clientY }
  }

  const onPointerMove = (event: PointerEvent) => {
    if (!drag) return
    setOffset({
      x: drag.offset.x + event.clientX - drag.x,
      y: drag.offset.y + event.clientY - drag.y,
    })
  }

  const endPointer = (event: PointerEvent) => {
    if (drag) {
      drag = undefined
      setDragging(false)
      const target = event.currentTarget as HTMLElement
      if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
      return
    }
    if (!swipe) return
    const dx = event.clientX - swipe.x
    const dy = event.clientY - swipe.y
    swipe = undefined
    if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy)) return
    go(dx < 0 ? 1 : -1)
  }

  const cancelPointer = () => {
    drag = undefined
    swipe = undefined
    setDragging(false)
  }

  const onDoubleClick = () => {
    if (Math.abs(effectiveZoom() - 100) < 0.5) {
      fit()
      return
    }
    actual()
  }

  const pan = (dx: number, dy: number) => {
    const value = offset()
    setOffset({ x: value.x + dx, y: value.y + dy })
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if (
      event.target instanceof Element &&
      event.target.closest(
        '[data-component="dropdown-menu-content"], [data-component="context-menu-content"], [role="menu"]',
      )
    )
      return
    if (
      document.querySelector(
        '[data-component="dropdown-menu-content"][data-expanded], [data-component="context-menu-content"][data-expanded], [role="menu"][data-expanded]',
      )
    )
      return

    const key = event.key
    if (key === "+" || key === "=") {
      event.preventDefault()
      const center = stageCenter()
      zoomBy(1.2, center)
      return
    }
    if (key === "-" || key === "_") {
      event.preventDefault()
      const center = stageCenter()
      zoomBy(1 / 1.2, center)
      return
    }
    if (key === "0") {
      event.preventDefault()
      fit()
      return
    }
    if (key === "1") {
      event.preventDefault()
      actual()
      return
    }
    if (key === "ArrowLeft" || key === "ArrowRight") {
      event.preventDefault()
      if (canPan()) {
        pan(key === "ArrowLeft" ? -48 : 48, 0)
        return
      }
      const delta = key === "ArrowRight" ? 1 : -1
      const rtl = typeof document !== "undefined" && document.documentElement.dir === "rtl"
      go(rtl ? -delta : delta)
      return
    }
    if (key === "ArrowUp" || key === "ArrowDown") {
      if (!canPan()) return
      event.preventDefault()
      pan(0, key === "ArrowUp" ? -48 : 48)
    }
  }

  createEffect(
    on(
      () => props.index,
      () => {
        fit()
        const item = current()
        setNatural({ width: item?.width ?? 0, height: item?.height ?? 0 })
      },
      { defer: false },
    ),
  )

  createEffect(() => {
    const item = current()
    if (!item?.src || !INLINE_IMAGE_SRC.test(item.src) || typeof Image === "undefined") return
    for (const index of [props.index - 1, props.index + 1]) {
      const neighbor = props.items[index]
      if (!neighbor?.src || !INLINE_IMAGE_SRC.test(neighbor.src)) continue
      const image = new Image()
      image.decoding = "async"
      image.src = neighbor.src
    }
  })

  makeEventListener(window, "keydown", handleKeyDown, { capture: true })

  createResizeObserver(
    () => stageRef,
    () => {
      if (!stageRef) return
      const rect = stageRef.getBoundingClientRect()
      const next = { width: rect.width, height: rect.height }
      const previous = stageSize()
      if (previous.width === next.width && previous.height === next.height) return
      setStageSize(next)
    },
  )

  return (
    <Kobalte.Content
      data-component="image-viewer"
      onCloseAutoFocus={(event) => props.onCloseAutoFocus?.(event)}
      onOpenAutoFocus={(event) => {
        const target = event.currentTarget as HTMLElement | null
        const focus = target?.querySelector("[data-action='image-viewer-close']") as HTMLElement | null
        if (!focus) return
        event.preventDefault()
        focus.focus()
      }}
    >
      <div data-slot="image-viewer-header">
        <div data-slot="image-viewer-heading">
          <Kobalte.Title data-slot="image-viewer-title">{title()}</Kobalte.Title>
          <Show when={dimensions()}>
            {(value) => (
              <span data-slot="image-viewer-dimensions">
                {i18n.t("ui.imageViewer.dimensions", { width: value().width, height: value().height })}
              </span>
            )}
          </Show>
          <Show when={source()}>
            {(value) => <span data-slot="image-viewer-source">{value()}</span>}
          </Show>
        </div>
        <div data-slot="image-viewer-header-actions">
          <Show when={props.onActions}>
            {(onActions) => (
              <IconButton
                data-action="image-viewer-actions"
                icon="dot-grid"
                variant="ghost"
                aria-label={i18n.t("ui.imageViewer.actions")}
                title={i18n.t("ui.imageViewer.actions")}
                onClick={() => {
                  const item = current()
                  if (item) onActions()(item)
                }}
              />
            )}
          </Show>
          <IconButton
            data-action="image-viewer-close"
            icon="close"
            variant="ghost"
            aria-label={i18n.t("ui.imageViewer.close")}
            title={`${i18n.t("ui.imageViewer.close")} (Esc)`}
            onClick={() => props.onClose()}
          />
        </div>
      </div>

      <div
        ref={stageRef}
        data-slot="image-viewer-stage"
        data-dragging={dragging() ? "true" : undefined}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={cancelPointer}
        onDblClick={onDoubleClick}
        onContextMenu={(event) => {
          if (!props.onActions) return
          const item = current()
          if (!item) return
          event.preventDefault()
          props.onActions(item)
        }}
      >
        <Show when={current()}>
          {(item) => (
            <img
              data-slot="image-viewer-image"
              data-zoom={zoomPercent()}
              data-pixelated={pixelated() ? "true" : undefined}
              src={item().src}
              alt={item().alt}
              draggable={false}
              loading="eager"
              decoding="async"
              style={{ ...imageStyle(), transform: imageTransform() }}
              onLoad={(event) => {
                const image = event.currentTarget
                if (!image.naturalWidth || !image.naturalHeight) return
                setNatural({ width: image.naturalWidth, height: image.naturalHeight })
              }}
            />
          )}
        </Show>
      </div>

      <div data-slot="image-viewer-toolbar">
        <div data-slot="image-viewer-nav">
          <IconButton
            data-action="image-viewer-previous"
            icon="arrow-left"
            variant="ghost"
            disabled={!canPrevious()}
            aria-label={i18n.t("ui.imageViewer.previous")}
            title={`${i18n.t("ui.imageViewer.previous")} (${arrowShortcut("previous")})`}
            onClick={() => go(-1)}
          />
          <span data-slot="image-viewer-counter">
            {i18n.t("ui.imageViewer.counter", { index: props.index + 1, total: props.items.length })}
          </span>
          <IconButton
            data-action="image-viewer-next"
            icon="arrow-right"
            variant="ghost"
            disabled={!canNext()}
            aria-label={i18n.t("ui.imageViewer.next")}
            title={`${i18n.t("ui.imageViewer.next")} (${arrowShortcut("next")})`}
            onClick={() => go(1)}
          />
        </div>
        <div data-slot="image-viewer-zoom-controls">
          <button
            type="button"
            data-action="image-viewer-zoom-out"
            aria-label={i18n.t("ui.imageViewer.zoomOut")}
            title={`${i18n.t("ui.imageViewer.zoomOut")} (−)`}
            onClick={() => {
              const center = stageCenter()
              zoomBy(1 / 1.2, center)
            }}
          >
            −
          </button>
          <span data-slot="image-viewer-zoom">
            {i18n.t("ui.imageViewer.zoomLevel", { value: zoomPercent() })}
          </span>
          <button
            type="button"
            data-action="image-viewer-zoom-in"
            aria-label={i18n.t("ui.imageViewer.zoomIn")}
            title={`${i18n.t("ui.imageViewer.zoomIn")} (+)`}
            onClick={() => {
              const center = stageCenter()
              zoomBy(1.2, center)
            }}
          >
            +
          </button>
          <button
            type="button"
            data-action="image-viewer-fit"
            aria-label={i18n.t("ui.imageViewer.fit")}
            title={`${i18n.t("ui.imageViewer.fit")} (0)`}
            onClick={fit}
          >
            {i18n.t("ui.imageViewer.fit")}
          </button>
          <button
            type="button"
            data-action="image-viewer-actual-size"
            aria-label={i18n.t("ui.imageViewer.actualSize")}
            title={`${i18n.t("ui.imageViewer.actualSize")} (1)`}
            onClick={actual}
          >
            100%
          </button>
        </div>
        <div data-slot="image-viewer-file-actions">
          <Show when={props.onCopy}>
            {(onCopy) => (
              <IconButton
                data-action="image-viewer-copy"
                icon="copy"
                variant="ghost"
                disabled={!!props.copyDisabledReason}
                aria-label={i18n.t("ui.imageViewer.copy")}
                aria-description={props.copyDisabledReason}
                title={props.copyDisabledReason ?? i18n.t("ui.imageViewer.copy")}
                onClick={() => {
                  const item = current()
                  if (item) void Promise.resolve(onCopy()(item)).catch(() => {})
                }}
              />
            )}
          </Show>
          <Show when={props.onSave}>
            {(onSave) => (
              <IconButton
                data-action="image-viewer-save"
                icon="download"
                variant="ghost"
                aria-label={i18n.t("ui.imageViewer.save")}
                title={i18n.t("ui.imageViewer.save")}
                onClick={() => {
                  const item = current()
                  if (item) onSave()(item)
                }}
              />
            )}
          </Show>
        </div>
      </div>

      <Show when={current()}>
        {(item) => <Show when={props.actionsMenu}>{props.actionsMenu!(item())}</Show>}
      </Show>

      <div data-slot="image-viewer-live" aria-live="polite" aria-atomic="true">
        {i18n.t("ui.imageViewer.zoomAnnouncement", { value: zoomPercent() })}
      </div>
    </Kobalte.Content>
  )
}
