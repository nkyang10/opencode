import type { Message, Session, Part, SnapshotFileDiff, SessionStatus, Provider } from "@opencode-ai/sdk/v2"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import { createSimpleContext } from "@opencode-ai/ui/context"
import type { ShownImageAddress } from "@opencode-ai/ui/image-viewer"
import { PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"

export type NormalizedProviderListResponse = {
  all: Map<string, Provider>
  defaultModel?: {
    providerID: string
    modelID: string
  } | null
  default: {
    [key: string]: string
  }
  connected: Array<string>
}

type Data = {
  agent?: {
    name: string
    color?: string
  }[]
  provider?: NormalizedProviderListResponse
  session: Session[]
  session_status: {
    [sessionID: string]: SessionStatus
  }
  session_diff: {
    [sessionID: string]: (SnapshotFileDiff | FileDiffInfo)[]
  }
  session_diff_preload?: {
    [sessionID: string]: PreloadMultiFileDiffResult<any>[]
  }
  message: {
    [sessionID: string]: Message[]
  }
  part: {
    [messageID: string]: Part[]
  }
  part_text_accum_delta?: {
    [partID: string]: string
  }
}

export type NavigateToSessionFn = (sessionID: string) => void

export type SessionHrefFn = (sessionID: string) => string

export type ImageSource = {
  src: string
  filename?: string
  mime?: string
  path?: string
}

export const { use: useData, provider: DataProvider } = createSimpleContext({
  name: "Data",
  init: (props: {
    data: Data
    directory: string
    sessionID?: string
    onNavigateToSession?: NavigateToSessionFn
    onSessionHref?: SessionHrefFn
    onAttachImage?: (image: ImageSource) => void | Promise<void>
    onOpenImageInNewTab?: (image: ImageSource) => void
    onRevealPath?: (path: string) => boolean | Promise<boolean>
    onLoadFullImage?: (address: ShownImageAddress, options?: { signal?: AbortSignal }) => Promise<ImageSource>
  }) => {
    return {
      get store() {
        return props.data
      },
      get directory() {
        return props.directory
      },
      get sessionID() {
        return props.sessionID
      },
      navigateToSession: props.onNavigateToSession,
      sessionHref: props.onSessionHref,
      attachImage: props.onAttachImage,
      openImageInNewTab: props.onOpenImageInNewTab,
      revealPath: props.onRevealPath,
      loadFullImage: props.onLoadFullImage,
    }
  },
})
