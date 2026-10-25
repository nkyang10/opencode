import { displayName } from "@/pages/layout/helpers"
import type { PromptProject } from "./prompt-project-selector"

export function sortPromptProjects(projects: readonly PromptProject[]) {
  return projects.toSorted(
    (a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0) || displayName(a).localeCompare(displayName(b)),
  )
}
