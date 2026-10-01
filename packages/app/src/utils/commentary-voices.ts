/**
 * s090: the voice picker beside the commentary title.
 *
 * **A voice is not a name, it is a (service, name) pair.** Measured 2026-10-01 on 192.168.1.162: `:8880`
 * proxies Azure's 322 voices and `:8881` bakes exactly one, and *both answer to `cantonese`* with different
 * audio for the same words (untagged 48 kbps vs 64 kbps with an ID3 tag). So the picker's value carries the
 * endpoint, the store holds the pair together, and the lease sends both — a picker that offered a flat list of
 * names would produce lines that come back text-only, silently, whenever the pick and the configured endpoint
 * disagreed.
 *
 * Pure and separate from the component because `packages/app` has no `*.test.tsx`: this is the part with the
 * rules in it, so this is the part that can be tested.
 */

export interface CommentaryVoice {
  readonly name: string
  readonly locale?: string
  readonly friendly?: string
  readonly aliases: readonly string[]
}

/** One endpoint's answer. `error` is set instead of `voices` when that endpoint could not be asked. */
export interface CommentaryVoiceSource {
  readonly host: string
  readonly voices: readonly CommentaryVoice[]
  readonly error?: string
}

/**
 * The route's whole answer. `default` is the pair the server's config resolves to, sent rather than guessed:
 * the picker is showing the truth about what the next line will be spoken in.
 */
export interface VoiceCatalogue {
  readonly default: { readonly host: string; readonly voice: string }
  readonly sources: readonly CommentaryVoiceSource[]
}

export interface VoiceOption {
  readonly host: string
  readonly voice: string
  /** What the reader sees: the voice name, and the endpoint when more than one is on offer. */
  readonly label: string
  /** The alias the service resolved this voice by, when the name alone would be ambiguous. */
  readonly alias?: string
  /** Every name this endpoint accepts for it, so the picker can show the ones worth knowing. */
  readonly aliases: readonly string[]
  /**
   * The service's own human description — "Microsoft HiuMaan Online (Natural) - Chinese (Hong Kong SAR)".
   * `zh-HK-HiuMaanNeural` tells a reader nothing; this tells them what they will actually hear, and it is
   * also what makes the filter box worth having.
   */
  readonly description?: string
}

/**
 * The options, in the order a reader would look for them: the configured default's own endpoint first, then
 * any others, and alphabetical within each so the list does not reshuffle between fetches.
 *
 * The **selected** option is the reader's pick when there is one, and otherwise the pair the server reports as
 * its default. An option that is picked but no longer offered (a voice removed from a service, or an endpoint
 * deleted from the config) is still listed, at the top and marked, because a picker that silently jumps to a
 * different voice is a picker that has changed the narration without saying so.
 */
/**
 * The DOM identity of one (endpoint, voice) pair.
 *
 * A newline was the obvious separator because neither part can contain one — and it is the one character
 * guaranteed to be invalid inside a quoted CSS attribute value. Kobalte's list keyboard delegate builds
 * `[data-key="${key}"]` **unescaped** (`@kobalte/core` `list-keyboard-delegate.ts`), so opening the picker
 * threw `SyntaxError: Failed to execute 'querySelector'… is not a valid selector` and the picker was unusable.
 * `|` cannot appear in a hostname (RFC 1035), a port, or a voice name, so it separates just as unambiguously
 * and survives the selector.
 */
export function voiceKey(host: string, voice: string) {
  return `${host}|${voice}`
}

export function voiceOptions(input: {
  sources: readonly CommentaryVoiceSource[]
  picked?: { host?: string; voice?: string }
  /** The `(host, voice)` the server config resolves to, used when nothing has been picked. */
  fallback?: { host?: string; voice?: string }
}) {
  const options: VoiceOption[] = []
  const seen = new Set<string>()
  for (const source of input.sources) {
    if (source.error) continue
    const names = [...source.voices].sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of names) {
      const key = voiceKey(source.host, entry.name)
      if (seen.has(key)) continue
      seen.add(key)
      options.push({
        host: source.host,
        voice: entry.name,
        label: entry.name,
        description: entry.friendly,
        aliases: entry.aliases,
      })
    }
  }

  const wanted = input.picked?.voice
    ? { host: input.picked.host ?? "", voice: input.picked.voice }
    : input.fallback?.voice
      ? { host: input.fallback.host ?? "", voice: input.fallback.voice }
      : undefined

  const selected =
    wanted === undefined
      ? undefined
      : options.find((option) => option.host === wanted.host && option.voice === wanted.voice) ??
        // A voice offered under several names on one service: the config may name an alias.
        options.find((option) => option.host === wanted.host && option.aliases.includes(wanted.voice)) ??
        // Unresolvable, but still shown so the reader is not left with a picker that disagrees with the
        // narration they are hearing.
        { host: wanted.host, voice: wanted.voice, label: wanted.voice, aliases: [] as string[] }

  return { options, selected }
}

/** The label to show: the name, plus the endpoint as soon as there is more than one to tell apart. */
/**
 * What the reader sees for one voice.
 *
 * The service's own description leads, because `zh-HK-HiuMaanNeural` tells a reader nothing about what they
 * will hear while "Chinese (Hong Kong SAR)" is exactly the answer. The technical name stays attached: it is
 * what the filter matches, and it is what someone pasting a voice into a config file needs.
 */
export function optionLabel(option: VoiceOption, hosts: number) {
  const name = option.description ? `${option.description} · ${option.label}` : option.label
  return hosts > 1 ? `${name} — ${option.host}` : name
}

/** Which endpoints could not be asked, for the one line the picker shows instead of pretending they are empty. */
export function unavailableHosts(sources: readonly CommentaryVoiceSource[]) {
  return sources.filter((source) => source.error !== undefined).map((source) => source.host)
}
