import { createSimpleContext } from "@opencode-ai/ui/context"
import type { ImageSource } from "@opencode-ai/session-ui/context"
import { dataUrlToBlob, isCopyableImage } from "@opencode-ai/session-ui/image-actions-helpers"
import { createSignal } from "solid-js"

type AttachHandler = (image: ImageSource) => void | Promise<void>

export type ComposerAttachTarget = {
  addAttachments(files: File[]): void
  restoreFocus(): void
}

export const { use: useImageActions, provider: ImageActionsProvider } = createSimpleContext({
  name: "ImageActions",
  init: () => {
    const [attach, setAttach] = createSignal<AttachHandler>()
    return {
      get attach() {
        return attach()
      },
      registerAttach(handler: AttachHandler) {
        setAttach(() => handler)
        return () => setAttach((current) => (current === handler ? undefined : current))
      },
      attachImage(image: ImageSource) {
        return attach()?.(image)
      },
    }
  },
})

export function createComposerAttachHandler(target: ComposerAttachTarget): AttachHandler {
  return (image) => {
    target.addAttachments([dataUrlToFile(image)])
    // The action menu restores focus to its trigger when it closes, so wait one frame
    // before asking the composer to take focus back.
    requestAnimationFrame(() => target.restoreFocus())
  }
}

export function dataUrlToFile(image: ImageSource): File {
  const blob = dataUrlToBlob(image.src)
  const mime = image.mime ?? blob.type
  const name = filename(image.filename, mime)
  return new File([blob], name, { type: mime })
}

export function openImageInNewTab(image: ImageSource) {
  if (!isCopyableImage(image)) throw new Error("Unsupported image")
  const url = URL.createObjectURL(dataUrlToBlob(image.src))
  const link = document.createElement("a")
  link.href = url
  link.target = "_blank"
  link.rel = "noopener noreferrer"
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function filename(value: string | undefined, mime: string) {
  const name = value?.split(/[\\/]/).pop()?.trim()
  if (name) return name
  const ext = mime.split("/")[1]?.replace("jpeg", "jpg") || "png"
  return `image.${ext}`
}
