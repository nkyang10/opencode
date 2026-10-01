import { describe, expect, test } from "bun:test"
import {
  CommentaryAudio,
  DEFAULT_HOST,
  DEFAULT_MAX_BYTES,
  DEFAULT_RETENTION,
  DEFAULT_VOICE,
  HASH_PATTERN,
  hashFor,
  parseVoices,
} from "@/session/commentary-audio"
import { hostsOf, settings, speech } from "@/session/commentary"

describe("hashFor", () => {
  test("is 32 lowercase hex characters, which is what the route and the column both validate", () => {
    const hash = hashFor("cantonese", "The utils dir is packed.")
    expect(hash).toMatch(HASH_PATTERN)
    expect(hash).toHaveLength(32)
  })

  test("is stable, so a repeated line reuses the file instead of rendering it again", () => {
    expect(hashFor("cantonese", "same words")).toBe(hashFor("cantonese", "same words"))
  })

  test("differs for different text", () => {
    expect(hashFor("cantonese", "one")).not.toBe(hashFor("cantonese", "two"))
  })

  // Changing the voice has to invalidate the store. Without the voice in the hash, a config change would
  // keep replaying what the previous voice said for the same words.
  test("differs for a different voice, because the voice is part of the identity", () => {
    expect(hashFor("cantonese", "same words")).not.toBe(hashFor("en-male", "same words"))
  })

  test("does not collide across the voice boundary", () => {
    // Concatenation without a separator would make ("ab", "c") and ("a", "bc") hash the same string.
    expect(hashFor("a", "bc")).not.toBe(hashFor("ab", "c"))
  })

  // Measured 2026-10-01 on 192.168.1.162: `:8880` and `:8881` both answer to `cantonese` and return different
  // audio for the same words (untagged 48 kbps vs 64 kbps with an ID3 tag). Hashing the voice alone would let
  // one endpoint's recording be served for a line the other endpoint was asked to speak.
  test("differs for a different endpoint, because two services answer to one voice name", () => {
    expect(hashFor("cantonese", "same words", "192.168.1.162:8880")).not.toBe(
      hashFor("cantonese", "same words", "192.168.1.162:8881"),
    )
  })

  test("does not collide across the endpoint boundary either", () => {
    expect(hashFor("a", "bc", "h1")).not.toBe(hashFor("ab", "c", "h1"))
    expect(hashFor("a", "b", "h1")).not.toBe(hashFor("a", "b", "h1:c"))
  })
})

describe("sound file management", () => {
  test("the retention window matches what the panel shows, so audio and text age out together", () => {
    // 15 in the panel and 100 on disk would mean the audio for a line you can no longer read outstays it by
    // 85 lines. The two numbers are one decision.
    expect(DEFAULT_RETENTION).toBe(15)
  })

  test("an absent section keeps the same window", () => {
    expect(speech(undefined).retention).toBe(DEFAULT_RETENTION)
    expect(speech({}).retention).toBe(DEFAULT_RETENTION)
  })

  test("the ceiling is a real ceiling", () => {
    expect(DEFAULT_MAX_BYTES).toBeGreaterThan(0)
    expect(DEFAULT_MAX_BYTES).toBeLessThanOrEqual(1024 * 1024 * 1024)
  })
})

describe("review findings", () => {
  test("the two special-line settings default on, because silence reads as a crash", () => {
    expect(settings(undefined).special).toBe(true)
  })

  test("the special-line floor is long enough that a flapping session cannot spam", () => {
    // Busy/idle alternation is common around tool boundaries; a floor measured in seconds would narrate it.
    expect(settings(undefined).specialMinGap).toBeGreaterThanOrEqual(30_000)
  })
})

describe("speech settings", () => {
  test("an absent section speaks at the shipped defaults", () => {
    expect(speech(undefined)).toEqual({
      host: DEFAULT_HOST,
      voice: DEFAULT_VOICE,
      retention: DEFAULT_RETENTION,
      maxBytes: DEFAULT_MAX_BYTES,
      // The picker needs somewhere to look even when nobody configured a second endpoint.
      hosts: [DEFAULT_HOST],
    })
  })

  test("an empty section is the same as no section", () => {
    expect(speech({})).toEqual(speech(undefined))
  })

  test("reads the configured host and voice", () => {
    expect(speech({ speech: { host: "10.0.0.9:9000", voice: "en-female" } })).toMatchObject({
      host: "10.0.0.9:9000",
      voice: "en-female",
    })
  })

  // A config file that has the section but no value for a key must not produce an empty host, which would
  // be a request to `http:///v1/audio/speech`.
  test("a blank host or voice falls back rather than becoming an empty request", () => {
    expect(speech({ speech: { host: "   ", voice: "  " } })).toMatchObject({
      host: DEFAULT_HOST,
      voice: DEFAULT_VOICE,
    })
  })

  test("the retention caps can be raised from config", () => {
    expect(speech({ speech: { retention: 5, maxBytes: 1024 } })).toMatchObject({ retention: 5, maxBytes: 1024 })
  })
})
describe("which endpoints the voice picker offers", () => {
  test("the default host is always offered, because a client that never opened the picker still renders", () => {
    expect(hostsOf(undefined)).toEqual([DEFAULT_HOST])
    expect(hostsOf({})).toEqual([DEFAULT_HOST])
  })

  test("configured hosts follow the default, deduplicated case-insensitively", () => {
    expect(
      hostsOf({ host: "10.0.0.9:9000", hosts: ["10.0.0.10:9000", "10.0.0.9:9000", "  ", "10.0.0.9:9000 "] }),
    ).toEqual(["10.0.0.9:9000", "10.0.0.10:9000"])
  })

  test("a host listed only in `hosts` is still offered", () => {
    expect(hostsOf({ hosts: ["192.168.1.162:8881"] })).toEqual([DEFAULT_HOST, "192.168.1.162:8881"])
  })

  test("blank entries never become an endpoint", () => {
    expect(hostsOf({ host: "   ", hosts: ["", "  "] })).toEqual([DEFAULT_HOST])
  })
})

describe("folding a voice catalogue", () => {
  // The two builds disagree on shape, and both are in the wild. Reading only one of these loses names.
  const azure = {
    data: [
      { name: "zh-HK-HiuMaanNeural", locale: "zh-HK" },
      { name: "en-US-AvaNeural", locale: "en-US", friendly_name: "Ava" },
    ],
    aliases: { cantonese: "zh-HK-HiuMaanNeural", "en-female": "en-US-AvaNeural" },
  }
  const baked = {
    data: [
      {
        name: "canto-tts-nano-v1",
        locale: "zh-HK",
        friendly_name: "canto-tts baked default voice",
        aliases: ["cantonese", "nova", "canto"],
      },
    ],
    aliases: { cantonese: "canto-tts-nano-v1", nova: "canto-tts-nano-v1" },
  }

  test("reads the flat alias map the Azure-compatible build sends", () => {
    const voices = parseVoices(azure)
    expect(voices.map((voice) => voice.name)).toEqual(["zh-HK-HiuMaanNeural", "en-US-AvaNeural"])
    expect(voices[0]!.aliases).toEqual(["cantonese"])
    expect(voices[1]!.friendly).toBe("Ava")
  })

  test("reads the per-entry aliases the newer build sends, and does not duplicate the flat map", () => {
    const voices = parseVoices(baked)
    expect(voices).toHaveLength(1)
    // `cantonese` and `nova` arrive twice — once on the entry, once in the flat map — and appear once.
    expect(voices[0]!.aliases).toEqual(["canto", "cantonese", "nova"])
    expect(voices[0]!.friendly).toBe("canto-tts baked default voice")
  })

  test("an alias that is also a real voice name is dropped, so the picker cannot list a voice twice", () => {
    const voices = parseVoices({
      data: [{ name: "cantonese" }, { name: "nova" }],
      aliases: { cantonese: "nova" },
    })
    expect(voices.map((voice) => voice.name)).toEqual(["cantonese", "nova"])
    expect(voices.find((voice) => voice.name === "nova")!.aliases).toEqual(["cantonese"])
  })

  test("an alias pointing at a voice the endpoint never listed is ignored, not invented", () => {
    const voices = parseVoices({ data: [{ name: "a" }], aliases: { ghost: "not-listed" } })
    expect(voices).toEqual([{ name: "a", aliases: [] }])
  })

  test("a shape it does not recognise yields nothing rather than throwing", () => {
    expect(parseVoices(undefined)).toEqual([])
    expect(parseVoices(null)).toEqual([])
    expect(parseVoices("nope")).toEqual([])
    expect(parseVoices({})).toEqual([])
    expect(parseVoices({ data: "nope" })).toEqual([])
    expect(parseVoices({ data: [{ locale: "zh-HK" }] })).toEqual([])
  })
})
