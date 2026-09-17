import type { SkillV2Info } from "@opencode-ai/sdk/v2/client"
import { useQuery, useMutation, useQueryClient } from "@tanstack/solid-query"
import { createMemo } from "solid-js"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import type { HomeController } from "./home-controller"

export type { SkillV2Info } from "@opencode-ai/sdk/v2/client"

const SKILLS_QUERY_KEY = ["home", "skills"] as const

export function createHomeSkillsController(home: HomeController) {
  const language = useLanguage()
  const queryClient = useQueryClient()

  const focusedContext = () => home.server.focusedContext()
  const client = () => focusedContext()?.sdk.client

  const skillList = useQuery<SkillV2Info[]>(() => ({
    queryKey: SKILLS_QUERY_KEY,
    enabled: !!client(),
    queryFn: async ({ signal }) => {
      const current = client()
      if (!current) return []
      const result = await current.v2.skill.list({}, { signal })
      return (result.data as { data?: SkillV2Info[] } | undefined)?.data ?? []
    },
  }))

  const refresh = () => queryClient.invalidateQueries({ queryKey: SKILLS_QUERY_KEY })

  const sorted = createMemo(() =>
    [...(skillList.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
  )

  const update = useMutation(() => ({
    mutationFn: ({ name, content }: { name: string; content: string }) =>
      client()!.v2.skill.update({ name, content }, { throwOnError: true }),
    onSuccess: refresh,
  }))

  const setEnabled = useMutation(() => ({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      client()!.v2.skill.setEnabled({ name, enabled }, { throwOnError: true }),
    onSuccess: refresh,
  }))

  const remove = useMutation(() => ({
    mutationFn: ({ name }: { name: string }) =>
      client()!.v2.skill.remove({ name }, { throwOnError: true }),
    onSuccess: () => {
      refresh()
      showToast({ variant: "success", title: language.t("home.skills.deleted") })
    },
  }))

  return {
    skills: sorted,
    loading: skillList.isPending,
    update,
    enabled: setEnabled,
    remove,
    refresh,
  }
}

export type HomeSkillsController = ReturnType<typeof createHomeSkillsController>

