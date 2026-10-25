import type { SkillV2Info } from "@opencode-ai/sdk/v2/client"
import { useQuery, useMutation, useQueryClient } from "@tanstack/solid-query"
import { createMemo } from "solid-js"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import type { HomeController } from "./home-controller"

export type { SkillV2Info } from "@opencode-ai/sdk/v2/client"

export function createHomeSkillsController(home: HomeController) {
  const language = useLanguage()
  const queryClient = useQueryClient()
  const focusedContext = () => home.server.focusedContext()
  const client = () => focusedContext()?.sdk.client
  const directory = () => home.project.newSession()?.worktree ?? home.server.focusedSync().data.path.directory
  const key = () => ["home", "skills", focusedContext()?.sdk.scope, directory()] as const
  const location = () => (directory() ? { directory: directory() } : undefined)
  const failed = () => showToast({ title: language.t("common.requestFailed") })

  const skillList = useQuery(() => ({
    queryKey: key(),
    enabled: !!client() && !!directory(),
    queryFn: async ({ signal }) => {
      const current = client()
      if (!current) return []
      const result = await current.v2.skill.list({ location: location() }, { signal, throwOnError: true })
      return result.data.data
    },
  }))
  const refresh = () => queryClient.invalidateQueries({ queryKey: key() })
  const sorted = createMemo(() => [...(skillList.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)))

  const update = useMutation(() => ({
    mutationFn: async ({ name, content }: { name: string; content: string }) => {
      const queryKey = key()
      await client()!.v2.skill.update({ name, content, location: location() }, { throwOnError: true })
      await queryClient.invalidateQueries({ queryKey })
    },
    onSuccess: () => showToast({ variant: "success", title: language.t("home.skills.updated") }),
    onError: failed,
  }))
  const setEnabled = useMutation(() => ({
    mutationFn: async ({ name, enabled }: { name: string; enabled: boolean }) => {
      const queryKey = key()
      await client()!.v2.skill.setEnabled({ name, enabled, location: location() }, { throwOnError: true })
      await queryClient.invalidateQueries({ queryKey })
    },
    onError: failed,
  }))
  const remove = useMutation(() => ({
    mutationFn: async ({ name }: { name: string }) => {
      const queryKey = key()
      await client()!.v2.skill.remove({ name, location: location() }, { throwOnError: true })
      await queryClient.invalidateQueries({ queryKey })
    },
    onSuccess: () => showToast({ variant: "success", title: language.t("home.skills.deleted") }),
    onError: failed,
  }))

  return {
    skills: sorted,
    directory,
    scope: () => `${focusedContext()?.sdk.scope}:${directory()}`,
    loading: () => skillList.isPending,
    error: () => skillList.isError,
    update,
    enabled: setEnabled,
    remove,
    refresh,
  }
}

export type HomeSkillsController = ReturnType<typeof createHomeSkillsController>
