import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Accessor, type JSX } from "solid-js"
import type { ImageViewerItem, ShownImageAddress } from "@opencode-ai/ui/image-viewer"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ImageViewer } from "@opencode-ai/ui/image-viewer"
import { showToast } from "@opencode-ai/ui/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useI18n, type UiI18n } from "@opencode-ai/ui/context/i18n"
import { useData, type ImageSource } from "../context"
import { dataUrlToBlob, imageActionAvailability, imageFileName, pngConversionDecision } from "./image-actions-helpers"
import { sessionImageGallery } from "./image-gallery"

type ImageActionItem = {
  id: string
  label: string
  icon?: IconProps["name"]
  description?: string
  disabled?: boolean
  run: () => void
}

type FullImageLoader = (address: ShownImageAddress, options?: { signal?: AbortSignal }) => Promise<ImageSource>

let preserveExternalFocus = false
function consumeExternalFocus() {
  if (!preserveExternalFocus) return false
  preserveExternalFocus = false
  return true
}

type ImageActionItemProps = {
  target: ImageViewerItem
  inViewer?: boolean
  onOpen?: () => void
  onGoToMessage?: () => void
  onAttach?: () => void
}

function targetSource(item: ImageViewerItem): ImageSource {
  return {
    src: item.src,
    filename: item.filename,
    mime: item.mime,
    path: item.path,
  }
}

/**
 * Bytes an action should hand over.
 *
 * A previewed shown image only carries the small frame in the timeline, so anything leaving the page (clipboard, disk,
 * new tab, composer) has to fetch the full frame behind it first. The address is dropped from the result: it describes
 * the preview, and keeping it would make every later action fetch again.
 */
function withFullImage(item: ImageViewerItem, load: FullImageLoader | undefined, options?: { signal?: AbortSignal }) {
  if (!item.full || !load) return Promise.resolve(item)
  return load(item.full, options).then((full) => ({ ...item, src: full.src, mime: full.mime, full: undefined }))
}

function showLoadFullImageFailed(i18n: UiI18n) {
  showToast({
    description: i18n.t("ui.imageActions.loadFailed"),
    variant: "error",
  })
}

function runWithFullImage(
  item: ImageViewerItem,
  load: FullImageLoader | undefined,
  i18n: UiI18n,
  next: (full: ImageViewerItem) => unknown,
) {
  void withFullImage(item, load).then(next, () => showLoadFullImageFailed(i18n))
}

function copyImageToClipboard(item: ImageViewerItem, i18n: UiI18n) {
  const failed = () => {
    showToast({
      description: i18n.t("ui.imageActions.copyFailed"),
      variant: "error",
    })
  }

  if (typeof navigator === "undefined" || !navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    failed()
    return Promise.resolve()
  }

  try {
    const blob = imageToPngBlob(item)
    const clipboardItem = new ClipboardItem({ "image/png": blob })
    return navigator.clipboard.write([clipboardItem]).then(
      () => {
        showToast({
          description: i18n.t("ui.imageActions.copied"),
          variant: "success",
          icon: "check-small",
        })
      },
      failed,
    )
  } catch {
    failed()
    return Promise.resolve()
  }
}

function imageToPngBlob(item: ImageViewerItem) {
  const decision = pngConversionDecision(item)
  if (!decision.copyable) return Promise.reject(new Error("Image cannot be copied"))
  const blob = dataUrlToBlob(item.src)
  if (!decision.convert) return Promise.resolve(blob)
  return convertImageBlobToPng(blob)
}

function convertImageBlobToPng(blob: Blob) {
  const url = URL.createObjectURL(blob)
  return loadImage(url)
    .then((image) => {
      const canvas = document.createElement("canvas")
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext("2d")
      if (!context) throw new Error("Canvas is unavailable")
      context.drawImage(image, 0, 0)
      return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((png) => {
          if (png) resolve(png)
          else reject(new Error("PNG conversion failed"))
        }, "image/png")
      })
    })
    .finally(() => URL.revokeObjectURL(url))
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error("Image could not be loaded"))
    image.src = src
  })
}

function saveImage(item: ImageViewerItem) {
  if (typeof document === "undefined") return
  const link = document.createElement("a")
  link.href = item.src
  link.download = imageFileName(item)
  link.rel = "noopener"
  document.body.appendChild(link)
  link.click()
  link.remove()
}

function copyTextToClipboard(text: string): Promise<boolean> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
  if (clipboard?.writeText) {
    return clipboard.writeText(text).then(
      () => true,
      () => copyTextFallback(text),
    )
  }
  return copyTextFallback(text)
}

function copyTextFallback(text: string): Promise<boolean> {
  const body = typeof document === "undefined" ? undefined : document.body
  if (!body) return Promise.resolve(false)

  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.setAttribute("readonly", "")
  textarea.style.position = "fixed"
  textarea.style.opacity = "0"
  textarea.style.pointerEvents = "none"
  body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand("copy")
  body.removeChild(textarea)
  return Promise.resolve(copied)
}

function useImageActionItems(props: ImageActionItemProps): Accessor<ImageActionItem[]> {
  const data = useData()
  const i18n = useI18n()

  return createMemo(() => {
    const inViewer = !!props.inViewer
    const availability = imageActionAvailability({
      target: props.target,
      platform: data.revealPath ? "desktop" : "browser",
      secureContext: typeof window === "undefined" ? true : window.isSecureContext,
      hasClipboardItem: typeof ClipboardItem !== "undefined",
      canOpenInNewTab: !!data.openImageInNewTab,
      canRevealPath: !!data.revealPath,
      canAttachImage: !!data.attachImage,
      inViewer,
    })

    const items: ImageActionItem[] = []
    const reason = availability.copyImageDisabledReason
      ? i18n.t("ui.imageActions.copyImageUnavailable")
      : undefined

    if (availability.open) {
      items.push({
        id: "open",
        label: i18n.t("ui.imageActions.open"),
        icon: "open-file",
        run: () => props.onOpen?.(),
      })
    }

    if (availability.openInNewTab) {
      items.push({
        id: "openInNewTab",
        label: i18n.t("ui.imageActions.openInNewTab"),
        icon: "square-arrow-top-right",
        run: () =>
          runWithFullImage(props.target, data.loadFullImage, i18n, (full) =>
            data.openImageInNewTab?.(targetSource(full)),
          ),
      })
    }

    if (availability.copyImage) {
      items.push({
        id: "copyImage",
        label: i18n.t("ui.imageActions.copyImage"),
        icon: "copy",
        description: reason,
        disabled: !!availability.copyImageDisabledReason,
        run: () => runWithFullImage(props.target, data.loadFullImage, i18n, (full) => copyImageToClipboard(full, i18n)),
      })
    }

    if (availability.saveImage) {
      items.push({
        id: "saveImage",
        label: i18n.t("ui.imageActions.saveImage"),
        icon: "download",
        run: () => runWithFullImage(props.target, data.loadFullImage, i18n, (full) => saveImage(full)),
      })
    }

    if (availability.copyPath) {
      items.push({
        id: "copyPath",
        label: i18n.t("ui.imageActions.copyPath"),
        icon: "copy",
        run: () => void copyTextToClipboard(props.target.path!),
      })
    }

    if (availability.revealInFileManager) {
      items.push({
        id: "revealInFileManager",
        label: i18n.t("ui.imageActions.revealInFileManager"),
        icon: "folder",
        run: () => {
          const reveal = data.revealPath
          const path = props.target.path
          if (!reveal || !path) return
          void Promise.resolve(reveal(path)).then(
            (result) => {
              if (result === false) {
                showToast({ description: i18n.t("ui.imageActions.revealFailed"), variant: "error" })
              }
            },
            () => showToast({ description: i18n.t("ui.imageActions.revealFailed"), variant: "error" }),
          )
        },
      })
    }

    if (availability.attachToMessage) {
      items.push({
        id: "attachToMessage",
        label: i18n.t("ui.imageActions.attachToMessage"),
        icon: "share",
        run: () => {
          const attach = data.attachImage
          if (!attach) return
          void withFullImage(props.target, data.loadFullImage).then(
            (full) =>
              Promise.resolve(attach(targetSource(full))).then(
                () => {
                  showToast({
                    description: i18n.t("ui.imageActions.attached"),
                    variant: "success",
                    icon: "check-small",
                  })
                  if (props.onAttach) {
                    preserveExternalFocus = true
                    props.onAttach()
                  }
                },
                () => {
                  preserveExternalFocus = false
                  showToast({
                    description: i18n.t("ui.imageActions.attachFailed"),
                    variant: "error",
                  })
                },
              ),
            () => {
              preserveExternalFocus = false
              showLoadFullImageFailed(i18n)
            },
          )
        },
      })
    }

    if (availability.goToMessage && props.onGoToMessage) {
      items.push({
        id: "goToMessage",
        label: i18n.t("ui.imageActions.goToMessage"),
        icon: "speech-bubble",
        run: () => props.onGoToMessage?.(),
      })
    }

    return items
  })
}

function ActionIcon(props: { name?: IconProps["name"] }) {
  return (
    <Show when={props.name}>
      {(name) => (
        <span data-slot="image-actions-icon">
          <Icon name={name()} size="small" />
        </span>
      )}
    </Show>
  )
}

function DropdownItems(props: { items: Accessor<ImageActionItem[]> }) {
  return (
    <For each={props.items()}>
      {(item) => (
        <DropdownMenu.Item disabled={item.disabled} onSelect={item.run}>
          <ActionIcon name={item.icon} />
          <DropdownMenu.ItemLabel>{item.label}</DropdownMenu.ItemLabel>
          <Show when={item.description}>
            {(description) => <DropdownMenu.ItemDescription>{description()}</DropdownMenu.ItemDescription>}
          </Show>
        </DropdownMenu.Item>
      )}
    </For>
  )
}

function focusViewerActions() {
  if (typeof document === "undefined") return
  requestAnimationFrame(() => {
    const button = document.querySelector('[data-action="image-viewer-actions"]')
    if (button instanceof HTMLElement) button.focus()
  })
}

function ViewerActionsMenu(props: {
  target: ImageViewerItem
  open: boolean
  anchor: { left: number; top: number }
  onClose: () => void
  onGoToMessage?: () => void
  onAttach?: () => void
}) {
  let restoreMenuFocus = true
  const items = useImageActionItems({
    target: props.target,
    inViewer: true,
    onGoToMessage: props.onGoToMessage,
    onAttach: props.onAttach
      ? () => {
          restoreMenuFocus = false
          props.onAttach?.()
        }
      : undefined,
  })

  return (
    <DropdownMenu
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
    >
      <DropdownMenu.Trigger
        as="div"
        aria-hidden="true"
        tabIndex={-1}
        style={{
          position: "fixed",
          left: `${props.anchor.left}px`,
          top: `${props.anchor.top}px`,
          width: "1px",
          height: "1px",
          "pointer-events": "none",
        }}
      />
      <DropdownMenu.Content
        placement="bottom-end"
        style={{ "min-width": "176px", "max-width": "calc(100vw - 16px)" }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (consumeExternalFocus()) return
          if (restoreMenuFocus) focusViewerActions()
        }}
      >
        <DropdownItems items={items} />
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

export function ImageActionsContext(props: {
  target: ImageViewerItem
  inViewer?: boolean
  onOpen?: (source?: HTMLElement) => void
  onGoToMessage?: (target: ImageViewerItem) => void
  children: JSX.Element
}) {
  let triggerRef: HTMLDivElement | undefined
  const items = useImageActionItems({
    target: props.target,
    inViewer: props.inViewer,
    onOpen: () => props.onOpen?.(triggerRef?.querySelector("button") ?? undefined),
    onGoToMessage: () => (props.onGoToMessage ?? scrollToImageItem)(props.target),
  })

  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) return
        requestAnimationFrame(() => {
          if (consumeExternalFocus()) return
          triggerRef?.querySelector("button")?.focus()
        })
      }}
    >
      <ContextMenu.Trigger
        as="div"
        class="image-actions-trigger"
        ref={triggerRef}
        onKeyDown={(event: KeyboardEvent) => {
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return
          if (!(event.target instanceof HTMLElement)) return
          event.preventDefault()
          event.stopPropagation()
          const rect = event.target.getBoundingClientRect()
          event.target.dispatchEvent(
            new MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              composed: true,
              button: 2,
              clientX: rect.left + rect.width / 2,
              clientY: rect.top + rect.height / 2,
            }),
          )
        }}
      >
        {props.children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content>
          <For each={items()}>
            {(item) => (
              <ContextMenu.Item disabled={item.disabled} onSelect={item.run}>
                <ActionIcon name={item.icon} />
                <ContextMenu.ItemLabel>{item.label}</ContextMenu.ItemLabel>
                <Show when={item.description}>
                  {(description) => (
                    <ContextMenu.ItemDescription>{description()}</ContextMenu.ItemDescription>
                  )}
                </Show>
              </ContextMenu.Item>
            )}
          </For>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu>
  )
}

export function ImageActionsDropdown(props: {
  target: ImageViewerItem
  inViewer?: boolean
  onOpen?: (source?: HTMLElement) => void
  onGoToMessage?: (target: ImageViewerItem) => void
  source?: () => HTMLElement | undefined
}) {
  const i18n = useI18n()
  let triggerRef: HTMLButtonElement | undefined
  const items = useImageActionItems({
    target: props.target,
    inViewer: props.inViewer,
    onOpen: () => props.onOpen?.(props.source?.()),
    onGoToMessage: () => (props.onGoToMessage ?? scrollToImageItem)(props.target),
  })

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        as={IconButton}
        ref={triggerRef}
        data-action="image-actions-menu"
        icon="dot-grid"
        variant="ghost"
        size="small"
        class="image-actions-menu-button"
        aria-label={i18n.t("ui.imageActions.actions")}
        title={i18n.t("ui.imageActions.actions")}
      />
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (consumeExternalFocus()) return
            triggerRef?.focus()
          }}
        >
          <DropdownItems items={items} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}

export function ImageViewerDialog(props: {
  items: ImageViewerItem[]
  initialIndex: number
  onClose: () => void
  onGoToMessage?: (item: ImageViewerItem) => void
  onAttach?: () => void
  onCloseAutoFocus?: (event: Event) => void
}) {
  const i18n = useI18n()
  const data = useData()
  const [index, setIndex] = createSignal(props.initialIndex)
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [anchor, setAnchor] = createSignal({ left: 0, top: 0 })
  const [frames, setFrames] = createSignal<Record<number, ImageViewerItem>>({})
  const items = createMemo(() => props.items.map((item, position) => frames()[position] ?? item))
  const current = () => items()[index()]
  const loads = new Map<number, AbortController>()

  onCleanup(() => {
    for (const abort of loads.values()) abort.abort()
    loads.clear()
  })

  createEffect(() => {
    const position = index()
    const item = props.items[position]
    const load = data.loadFullImage
    if (!item?.full || !load || frames()[position]) return
    const abort = loads.get(position) ?? new AbortController()
    loads.set(position, abort)
    void load(item.full, { signal: abort.signal }).then(
      (full) =>
        loadImage(full.src).then(
          (image) => {
            if (abort.signal.aborted) return
            setFrames((value) => ({
              ...value,
              [position]: {
                ...item,
                src: full.src,
                mime: full.mime,
                width: image.naturalWidth,
                height: image.naturalHeight,
                full: undefined,
              },
            }))
          },
          () => {
            if (!abort.signal.aborted) showLoadFullImageFailed(i18n)
          },
        ),
      () => {
        if (!abort.signal.aborted) showLoadFullImageFailed(i18n)
      },
    )
  })

  const copyDisabledReason = () => {
    if (!current()) return i18n.t("ui.imageActions.copyImageUnavailable")
    if (!pngConversionDecision(current()).copyable) return i18n.t("ui.imageActions.copyImageUnavailable")
    if (typeof window !== "undefined" && !window.isSecureContext) {
      return i18n.t("ui.imageActions.copyImageUnavailable")
    }
    if (typeof ClipboardItem === "undefined") return i18n.t("ui.imageActions.copyImageUnavailable")
    return undefined
  }

  const openMenu = () => {
    if (typeof document === "undefined") return
    const button = document.querySelector('[data-action="image-viewer-actions"]')
    if (!(button instanceof HTMLElement)) return
    const rect = button.getBoundingClientRect()
    setAnchor({ left: rect.right, top: rect.bottom + 4 })
    setMenuOpen(true)
  }

  return (
    <ImageViewer
      items={items()}
      index={index()}
      onIndexChange={setIndex}
      onClose={props.onClose}
      copyDisabledReason={copyDisabledReason()}
      onCopy={(item) => runWithFullImage(item, data.loadFullImage, i18n, (full) => copyImageToClipboard(full, i18n))}
      onSave={(item) => runWithFullImage(item, data.loadFullImage, i18n, (full) => saveImage(full))}
      onActions={() => openMenu()}
      onCloseAutoFocus={props.onCloseAutoFocus}
      actionsMenu={(item) => (
        <ViewerActionsMenu
          target={item}
          open={menuOpen()}
          anchor={anchor()}
          onClose={() => setMenuOpen(false)}
          onGoToMessage={() => {
            setMenuOpen(false)
            if (current()) props.onGoToMessage?.(current()!)
          }}
          onAttach={props.onAttach}
        />
      )}
    />
  )
}

function scrollToImageItem(item: ImageViewerItem) {
  if (typeof document === "undefined") return
  const escape =
    typeof CSS !== "undefined" && CSS.escape
      ? CSS.escape
      : (value: string) => value.replace(/["\\]/g, "\\$&")
  const part = item.partID
    ? document.querySelector(`[data-timeline-part-id="${escape(item.partID)}"]`)
    : undefined
  const message =
    !part && item.messageID ? document.querySelector(`[data-message-id="${escape(item.messageID)}"]`) : undefined
  const target = part ?? message
  target?.scrollIntoView({ block: "center", behavior: "smooth" })
}

export function useImageGallery() {
  const data = useData()
  const i18n = useI18n()
  const dialog = useDialog()

  const open = (input: { sessionID: string; target: ImageViewerItem; source?: HTMLElement | null }) => {
    const gallery = sessionImageGallery({
      sessionID: input.sessionID,
      messages: data.store.message[input.sessionID] ?? [],
      parts: data.store.part,
      labels: {
        image: i18n.t("ui.toolMedia.image"),
        attachment: i18n.t("ui.message.attachment.alt"),
        you: i18n.t("ui.imageViewer.source.you"),
      },
    })
    const items = gallery.length > 0 ? gallery : [input.target]
    let index = items.findIndex(
      (item) => item.partID === input.target.partID && item.src === input.target.src,
    )
    if (index < 0) index = items.findIndex((item) => item.src === input.target.src)
    if (index < 0) index = 0

    const source =
      input.source ??
      (typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null))

    let restoreFocus = true
    dialog.show(
      () => (
        <ImageViewerDialog
          items={items}
          initialIndex={index}
          onClose={() => dialog.close()}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (restoreFocus) source?.focus()
          }}
          onAttach={() => {
            restoreFocus = false
            dialog.close()
          }}
          onGoToMessage={(item) => {
            dialog.close()
            setTimeout(() => scrollToImageItem(item), 160)
          }}
        />
      ),
    )
  }

  return { open }
}
