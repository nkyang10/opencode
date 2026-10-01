import { describe, expect, test } from "bun:test"
import { CommentaryAudio, DEFAULT_HOST, DEFAULT_MAX_BYTES, DEFAULT_RETENTION, DEFAULT_VOICE, HASH_PATTERN, hashFor } from "@/session/commentary-audio"
import { settings, speech } from "@/session/commentary"

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