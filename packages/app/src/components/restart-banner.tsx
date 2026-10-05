import { useRestart } from "@/context/restart"
import { useLanguage } from "@/context/language"
import { Show } from "solid-js"

// The restart window, made visible (s100). A pill pinned to the bottom of the
// viewport — the same corner `ProviderTip` occupies on the new-session page, chosen
// because it collides with nothing: not the tab strip, not the composer's keys.
//
// The seconds come from the restart context's local ticker; this component never
// asks the server for the time, so the number keeps falling with the server dead.
// `pointer-events-none` on the wrapper keeps the pill from shielding controls.

export function RestartBanner() {
  const restart = useRestart()
  const language = useLanguage()

  return (
    <Show when={restart.phase() !== "idle"}>
      <div class="pointer-events-none fixed inset-x-0 bottom-16 z-50 flex justify-center px-10">
        <div
          class="pointer-events-auto flex h-8 max-w-full items-center gap-2 rounded-[10px] border border-v2-border-border-base bg-v2-background-bg-layer-01 px-3 text-[13px] leading-none tracking-[-0.04px] text-v2-text-text-base shadow-[0_4px_16px_rgb(0_0_0/0.12)]"
          role="status"
        >
          <span class="size-2 shrink-0 rounded-full bg-v2-background-bg-accent" aria-hidden="true" />
          <span class="truncate">
            <Show
              when={restart.phase() === "draining"}
              fallback={<span>{language.t("app.server.retrying")}</span>}
            >
              {language.t("restart.window.countdown", {
                seconds: Math.ceil((restart.remaining() ?? 0) / 1000),
              })}
            </Show>
          </span>
        </div>
      </div>
    </Show>
  )
}