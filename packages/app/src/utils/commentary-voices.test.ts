import { describe, expect, test } from "bun:test"
import {
  optionLabel,
  unavailableHosts,
  voiceOptions,
  type CommentaryVoiceSource,
} from "./commentary-voices"

// The two services measured on 192.168.1.162, 2026-10-01. They are the reason an option is a pair.
const azure: CommentaryVoiceSource = {
  host: "192.168.1.162:8880",
  voices: [
    { name: "en-US-AvaNeural", locale: "en-US", friendly: "Ava", aliases: ["en-female"] },
    { name: "zh-HK-HiuMaanNeural", locale: "zh-HK", aliases: ["cantonese"] },
  ],
}
const baked: CommentaryVoiceSource = {
  host: "192.168.1.162:8881",
  voices: [{ name: "canto-tts-nano-v1", locale: "zh-HK", friendly: "canto-tts baked default voice", aliases: ["cantonese", "nova"] }],
}

describe("the picker's options", () => {
  test("an endpoint that could not be asked contributes nothing, and the others still do", () => {
    const { options } = voiceOptions({
      sources: [azure, { host: "192.168.1.162:8881", voices: [], error: "connection refused" }],
    })
    // Empty is not the same as unavailable: the reader is told which host is missing, not handed a shorter
    // list that looks like the service has fewer voices.
    expect(options.map((option) => option.voice)).toEqual(["en-US-AvaNeural", "zh-HK-HiuMaanNeural"])
    expect(unavailableHosts([azure, { host: "192.168.1.162:8881", voices: [], error: "connection refused" }])).toEqual([
      "192.168.1.162:8881",
    ])
  })

  test("the same voice name on two services is two options, because they are different recordings", () => {
    const { options } = voiceOptions({ sources: [azure, baked] })
    const cantonese = options.filter((option) => option.aliases.includes("cantonese"))
    expect(cantonese.map((option) => `${option.host}/${option.voice}`)).toEqual([
      "192.168.1.162:8880/zh-HK-HiuMaanNeural",
      "192.168.1.162:8881/canto-tts-nano-v1",
    ])
  })

  test("options are alphabetical within an endpoint, so the list does not reshuffle between fetches", () => {
    const { options } = voiceOptions({
      sources: [{ host: "h", voices: [{ name: "zeta", aliases: [] }, { name: "alpha", aliases: [] }] }],
    })
    expect(options.map((option) => option.voice)).toEqual(["alpha", "zeta"])
  })

  test("a duplicated (host, voice) from one response is listed once", () => {
    const { options } = voiceOptions({
      sources: [{ host: "h", voices: [{ name: "a", aliases: [] }, { name: "a", aliases: [] }] }],
    })
    expect(options).toHaveLength(1)
  })
})

describe("what the picker shows as chosen", () => {
  test("with nothing picked it shows the server's own default, so the reader sees the truth", () => {
    const { selected } = voiceOptions({
      sources: [azure, baked],
      fallback: { host: "192.168.1.162:8880", voice: "cantonese" },
    })
    // The config names an alias, and the option it means is the real voice on that endpoint.
    expect(selected).toMatchObject({ host: "192.168.1.162:8880", voice: "zh-HK-HiuMaanNeural" })
  })

  test("a pick wins over the default", () => {
    const { selected } = voiceOptions({
      sources: [azure, baked],
      picked: { host: "192.168.1.162:8881", voice: "canto-tts-nano-v1" },
      fallback: { host: "192.168.1.162:8880", voice: "cantonese" },
    })
    expect(selected).toMatchObject({ host: "192.168.1.162:8881", voice: "canto-tts-nano-v1" })
  })

  test("a picked voice named by alias still resolves to the voice it means", () => {
    const { selected } = voiceOptions({
      sources: [baked],
      picked: { host: "192.168.1.162:8881", voice: "nova" },
    })
    expect(selected).toMatchObject({ host: "192.168.1.162:8881", voice: "canto-tts-nano-v1" })
  })

  test("a pick nothing offers is still shown, rather than the picker jumping to another voice", () => {
    // The service removed a voice, or the endpoint left the config. Silently switching would change the
    // narration without saying so, and the reader would have no way to notice.
    const { selected } = voiceOptions({
      sources: [baked],
      picked: { host: "192.168.1.162:8880", voice: "zh-HK-HiuMaanNeural" },
    })
    expect(selected).toMatchObject({ host: "192.168.1.162:8880", voice: "zh-HK-HiuMaanNeural" })
  })

  test("nothing picked and nothing configured selects nothing", () => {
    expect(voiceOptions({ sources: [azure] }).selected).toBeUndefined()
  })
})

describe("the label", () => {
  test("the endpoint joins the label only when there is more than one to tell apart", () => {
    const option = { host: "192.168.1.162:8881", voice: "canto-tts-nano-v1", label: "canto-tts-nano-v1", aliases: [] }
    expect(optionLabel(option, 1)).toBe("canto-tts-nano-v1")
    expect(optionLabel(option, 2)).toBe("canto-tts-nano-v1 — 192.168.1.162:8881")
  })
})
