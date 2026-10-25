import { DismissibleDock } from "./dismissible-dock"
import { Show, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { SessionPermissionDock } from "@/pages/session/composer/session-permission-dock"
import { SessionQuestionDock } from "@/pages/session/composer/session-question-dock"
import { SessionFollowupDock } from "@/pages/session/composer/session-followup-dock"
import { SessionRevertDock } from "@/pages/session/composer/session-revert-dock"
import { SessionTodoDock } from "@/pages/session/composer/session-todo-dock"
import type { SessionComposerRegionController } from "./session-composer-region-controller"

export function SessionComposerRegion(props: {
  controller: SessionComposerRegionController
  promptInput: JSX.Element
}) {
  const language = useLanguage()
  const controller = props.controller
  const settings = useSettings()
  const rolled = () => {
    const revert = controller.revert()
    return revert?.items.length ? revert : undefined
  }

  return (
    <div
      ref={controller.setDockRef}
      data-component="session-prompt-dock"
      classList={{
        "w-full shrink-0 flex flex-col justify-center items-center pb-3 pointer-events-none": true,
        "bg-v2-background-bg-base": settings.general.newLayoutDesigns(),
        "bg-background-stronger": !settings.general.newLayoutDesigns(),
      }}
    >
      <div
        classList={{
          "w-full px-3 pointer-events-auto": true,
          "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": controller.centered(),
        }}
      >
        <Show when={controller.state.questionRequest()} keyed>
          {(request) => (
            <DismissibleDock identity={`question:${controller.sessionKey()}:${request.id}`}>
              <SessionQuestionDock request={request} onSubmit={controller.onResponseSubmit} />
            </DismissibleDock>
          )}
        </Show>

        <Show when={controller.state.permissionRequest()} keyed>
          {(request) => (
            <DismissibleDock identity={`permission:${controller.sessionKey()}:${request.id}`}>
              <SessionPermissionDock
                request={request}
                responding={controller.state.permissionResponding()}
                onDecide={(response) => {
                  controller.onResponseSubmit()
                  controller.state.decide(response)
                }}
              />
            </DismissibleDock>
          )}
        </Show>

        <Show when={controller.showComposer()}>
          <Show when={controller.dock()}>
            <div
              classList={{
                "overflow-hidden": true,
                "pointer-events-none": controller.dockProgress() < 0.98,
              }}
              style={{
                "max-height": `${controller.dockHeight() * controller.dockProgress()}px`,
              }}
            >
              <div ref={controller.setDockBodyRef}>
                <DismissibleDock
                  identity={`todo:${controller.sessionKey()}:${JSON.stringify(controller.state.todos())}`}
                  onDismiss={controller.dismissTodo}
                >
                  <SessionTodoDock
                    todos={controller.state.todos()}
                    collapsed={controller.todo.collapsed()}
                    onToggle={controller.todo.onToggle}
                    collapseLabel={language.t("session.todo.collapse")}
                    expandLabel={language.t("session.todo.expand")}
                    dockProgress={controller.dockProgress()}
                  />
                </DismissibleDock>
              </div>
            </div>
          </Show>
          <Show
            when={controller.promptReady()}
            fallback={
              <>
                <Show when={rolled()} keyed>
                  {(revert) => (
                    <div class="pb-2">
                      <DismissibleDock
                        identity={`revert:${controller.sessionKey()}:${revert.items.map((x) => x.id).join(",")}`}
                      >
                        <SessionRevertDock
                          items={revert.items}
                          restoring={revert.restoring}
                          disabled={revert.disabled}
                          onRestore={revert.onRestore}
                        />
                      </DismissibleDock>
                    </div>
                  )}
                </Show>
                <div
                  class="w-full min-h-32 md:min-h-40 rounded-md border border-border-weak-base bg-background-base/50 px-4 py-3 text-text-weak whitespace-pre-wrap pointer-events-none"
                  style={{ "margin-top": `${-36 * controller.dockProgress()}px` }}
                >
                  {controller.handoffPrompt() || language.t("prompt.loading")}
                </div>
              </>
            }
          >
            <Show when={rolled()} keyed>
              {(revert) => (
                <div
                  style={{
                    "margin-top": `${-36 * controller.dockProgress()}px`,
                  }}
                >
                  <DismissibleDock
                    identity={`revert:${controller.sessionKey()}:${revert.items.map((x) => x.id).join(",")}`}
                  >
                    <SessionRevertDock
                      items={revert.items}
                      restoring={revert.restoring}
                      disabled={revert.disabled}
                      onRestore={revert.onRestore}
                    />
                  </DismissibleDock>
                </div>
              )}
            </Show>
            <div
              classList={{
                "relative z-[70]": true,
              }}
              style={{
                "margin-top": `${-controller.lift()}px`,
              }}
            >
              <Show when={controller.followup()?.items.length}>
                <DismissibleDock
                  identity={`followup:${controller.sessionKey()}:${controller
                    .followup()!
                    .items.map((x) => x.id)
                    .join(",")}`}
                >
                  <SessionFollowupDock
                    items={controller.followup()!.items}
                    sending={controller.followup()!.sending}
                    onSend={controller.followup()!.onSend}
                    onEdit={controller.followup()!.onEdit}
                  />
                </DismissibleDock>
              </Show>
              <Show when={controller.child()}>
                <DismissibleDock identity={`child:${controller.sessionKey()}`}>
                  <div
                    ref={controller.setPromptRef}
                    class="w-full rounded-[12px] border border-border-weak-base bg-background-base p-3 text-16-regular text-text-weak"
                  >
                    <span>{language.t("session.child.notice")} </span>
                    <Show when={controller.parentID()}>
                      <button
                        type="button"
                        class="text-text-base transition-colors hover:text-text-strong"
                        onClick={controller.openParent}
                      >
                        {language.t("session.child.backToParent")}
                      </button>
                    </Show>
                  </div>
                </DismissibleDock>
              </Show>
              {props.promptInput}
            </div>
          </Show>
        </Show>
      </div>
    </div>
  )
}
