import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { SegmentedControlV2, SegmentedControlItemV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { createSignal, Show } from "solid-js"
import { createHomeController } from "./home/home-controller"
import { createHomeProjectsController } from "./home/home-projects-controller"
import { HomeUtilityNav } from "./home/home-projects-view"
import { HomeProjects } from "./home/home-projects"
import { createHomeScrollController } from "./home/home-scroll-controller"
import { createHomeSessionSearchController } from "./home/home-session-search-controller"
import { createHomeSessionsController } from "./home/home-sessions-controller"
import { createHomeSessionsTableController } from "./home/home-sessions-table-controller"
import { HomeSessions } from "./home/home-sessions"
import { HomeSessionsTable } from "./home/home-sessions-table"

type HomeTab = "projects" | "sessions"

export function NewHome() {
  const home = createHomeController()
  const projects = createHomeProjectsController(home)
  const sessions = createHomeSessionsController(home)
  const tableSessions = createHomeSessionsTableController(home)
  const search = createHomeSessionSearchController(home, sessions)
  const scroll = createHomeScrollController(sessions.data.groups)
  const [activeTab, setActiveTab] = createSignal<HomeTab>("sessions")

  return (
    <div
      class={`
        m-2 min-h-0 flex-1 self-stretch overflow-hidden rounded-[10px]
        bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]
      `}
    >
      <SegmentedControlV2
        class="flex h-11 shrink-0 items-center gap-0.5 border-b border-v2-border-border-base px-3"
        value={activeTab()}
        onChange={(value) => value && setActiveTab(value as HomeTab)}
      >
        <SegmentedControlItemV2 value="projects">
          {projects.copy.language.t("home.projects")}
        </SegmentedControlItemV2>
        <SegmentedControlItemV2 value="sessions">
          {projects.copy.language.t("home.sessions.search.sessions")}
        </SegmentedControlItemV2>
      </SegmentedControlV2>

      <ScrollView
        class="h-[calc(100%-2.75rem)] [container-type:size]"
        thumbContainer={scroll.viewport.thumbTrack}
        thumbHoverTarget={scroll.viewport.hoverTarget}
        onWheel={scroll.viewport.containOuterWheel}
      >
        <Show
          when={activeTab() === "projects"}
          fallback={
            <HomeSessionsTable
              language={projects.copy.language}
              records={tableSessions.data.records}
              server={tableSessions.session.server}
              isOpenTab={tableSessions.tab.isOpen}
              onOpenSession={(record, options) => tableSessions.session.open(record.session, options)}
            />
          }
        >
          <div
            class={`
              mx-auto grid min-h-full w-full max-w-[1080px] grid-rows-[auto_minmax(0,1fr)_auto] gap-4 px-3
              lg:grid-cols-[280px_minmax(0,720px)] lg:grid-rows-1 lg:gap-8 lg:px-6
            `}
          >
            <HomeProjects projects={projects} scroll={scroll} />
            <HomeSessions sessions={sessions} search={search} scroll={scroll} />
            <HomeUtilityNav
              class="flex lg:hidden"
              onOpenSettings={projects.utility.settings}
              onOpenHelp={projects.utility.help}
              language={projects.copy.language}
            />
          </div>
        </Show>
      </ScrollView>
    </div>
  )
}
