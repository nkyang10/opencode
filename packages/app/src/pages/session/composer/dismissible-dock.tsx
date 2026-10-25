import { Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useLanguage } from "@/context/language"

export function DismissibleDock(props: { identity: string; children: JSX.Element; onDismiss?: () => void }) {
  const language = useLanguage()
  const [state, setState] = createStore({ dismissed: undefined as string | undefined })
  return (
    <Show when={state.dismissed !== props.identity}>
      <div class="relative" data-component="dismissible-dock">
        <div class="flex justify-end">
          <IconButton
            data-action="dismiss-dock"
            type="button"
            icon="close"
            variant="ghost"
            aria-label={language.t("common.dismiss")}
            onClick={() => {
              setState("dismissed", props.identity)
              props.onDismiss?.()
            }}
          />
        </div>
        {props.children}
      </div>
    </Show>
  )
}
