import type { Project } from "@opencode-ai/sdk/v2/client"
import type { LocalProject } from "@/context/layout"
import { pathKey } from "@/utils/path-key"

// A project is identified by its git repository (remote url, else the first root
// commit), so a directory without a repository resolves to the server's shared
// `global` project and never gets a project row of its own. The server records
// every opened directory under that project, and those directories are the plain
// working folders the list has to show — otherwise picking one in the folder
// selector silently does nothing.
export function isPlainFolder(project: LocalProject) {
  return !project.id
}

export function mergeProjectFolders(projects: Project[], folders: readonly string[]): LocalProject[] {
  const rows = projects.map((project) => ({ ...project, expanded: false }) satisfies LocalProject)
  const known = new Set<string>()
  for (const project of rows) {
    known.add(pathKey(project.worktree))
    for (const sandbox of project.sandboxes ?? []) known.add(pathKey(sandbox))
  }
  const seen = new Set<string>()
  const extra: LocalProject[] = []
  for (const directory of folders) {
    const key = pathKey(directory)
    if (!directory || known.has(key) || seen.has(key)) continue
    seen.add(key)
    extra.push({ worktree: directory, expanded: false })
  }
  return [...rows, ...extra]
}
