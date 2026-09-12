import { createEffect, createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { makeEventListener } from "@solid-primitives/event-listener"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { useLanguage } from "@/context/language"
import { movePull, RESET, shouldOpenPull, startPull, type DragPullState } from "./drag-down-gesture"

type TKey = NonNullable<Parameters<ReturnType<typeof useLanguage>["t"]>[0]>

export interface DragDownAction {
  id: string
  labelKey: TKey
  icon: string
  onSelect: () => void
  confirmKey?: TKey
}

export function DragDownMenu(props: {
  actions: DragDownAction[]
  class?: string
  children: JSX.Element
}) {
  const language = useLanguage()
  const [pos, setPos] = createSignal<{ top: number; left: number } | null>(null)

  let containerRef!: HTMLDivElement
  let start: { x: number; y: number } | undefined
  let pull: DragPullState | undefined

  const isInteractive = (target: EventTarget | null) =>
    target instanceof Element &&
    !!target.closest('button, a, [role="button"], [contenteditable="true"], [data-titlebar-tab-slot]')

  const onPointerDown = (ev: PointerEvent) => {
    if (ev.button !== 0 || isInteractive(ev.target)) return
    start = { x: ev.clientX, y: ev.clientY }
    pull = startPull()
    containerRef.setPointerCapture(ev.pointerId)
  }

  const onPointerMove = (ev: PointerEvent) => {
    if (!start || !pull) return
    const dx = ev.clientX - start.x
    const dy = ev.clientY - start.y
    const next = movePull(pull, dx, dy)
    if (next === RESET) releasePointer(ev.pointerId)
    else pull = next
  }

  const openMenu = () => {
    const rect = containerRef.getBoundingClientRect()
    const menuHeight = 180
    const dropBelow = rect.bottom + 6 + menuHeight < window.innerHeight
    const top = dropBelow ? rect.bottom + 6 : Math.max(6, rect.top - 6 - menuHeight)
    setPos({ top, left: rect.left + rect.width / 2 })
  }

  const closeMenu = () => setPos(null)

  const onPointerUp = (ev: PointerEvent) => {
    if (!start || !pull) return
    if (shouldOpenPull(pull)) openMenu()
    releasePointer(ev.pointerId)
  }

  const onPointerCancel = (ev: PointerEvent) => releasePointer(ev.pointerId)

  const onPointerLeave = (ev: PointerEvent) => {
    if (start && pull && ev.buttons === 0) releasePointer(ev.pointerId)
  }

  const releasePointer = (pointerId: number) => {
    start = undefined
    pull = undefined
    try {
      containerRef.releasePointerCapture(pointerId)
    } catch {}
  }

  const runAction = (action: DragDownAction) => {
    closeMenu()
    if (action.confirmKey) {
      if (window.confirm(language.t(action.confirmKey))) action.onSelect()
    } else {
      action.onSelect()
    }
  }

  createEffect(() => {
    if (!pos()) return
    return onCleanup(
      makeEventListener(window, "keydown", (ev) => {
        if (ev.key === "Escape") closeMenu()
      }),
    )
  })

  return (
    <div
      ref={containerRef}
      data-slot="drag-down-hit"
      class={props.class ?? "relative min-w-0"}
      style={{ "touch-action": "pan-x" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={onPointerLeave}
    >
      {props.children}

      <Show when={pos()}>
        {(position) => (
          <Portal>
            <div class="fixed inset-0 z-[59]" onPointerDown={closeMenu} />
            <div
              class="fixed z-[60]"
              style={{ left: `${position().left}px`, top: `${position().top}px`, transform: "translateX(-50%)" }}
            >
              <div data-component="menu-v2-content" class="min-w-44">
                <For each={props.actions}>
                  {(action) => (
                    <button type="button" data-component="menu-v2-item" class="cursor-pointer" onClick={() => runAction(action)}>
                      <span data-slot="menu-v2-item-content">
                        <span class="flex size-4 flex-none items-center justify-center text-v2-icon-icon-muted">
                          <IconV2 name={action.icon} size="small" />
                        </span>
                        {language.t(action.labelKey)}
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Portal>
        )}
      </Show>
    </div>
  )
}
