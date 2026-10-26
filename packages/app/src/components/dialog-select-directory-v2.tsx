import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import { createPickerDirectory, fetchDirectoryRoots } from "@/utils/directory-picker"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { ServerConnection, useServer } from "@/context/server"
import type { Path } from "@opencode-ai/sdk/v2/client"
import {
  absoluteTreePath,
  activeTreeNavigation,
  advanceTreePreload,
  nextSuggestionIndex,
  pickerFileSearchQuery,
  pickerAbsoluteInput,
  pickerMode,
  preloadTreeDirectories,
  cleanPickerInput,
  createPriorityTaskQueue,
  createDirectorySearch,
  currentPickerSuggestions,
  displayPickerPath,
  pickerParent,
  pickerRoot,
  pickerRootSelection,
  pickerRelativePath,
  pickerLocationRoots,
} from "./directory-picker-domain"
import { DirectoryTreeZag, type DirectoryTreeZagApi } from "./directory-tree-zag"
import "./dialog-select-directory-v2.css"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { getFilename } from "@opencode-ai/core/util/path"

interface DialogSelectDirectoryV2Props {
  title?: string
  multiple?: boolean
  onSelect: (result: string | string[] | null) => void
  server: ServerConnection.Any
  mode?: "directory" | "file"
  start?: string
}

export function DialogSelectDirectoryV2(props: DialogSelectDirectoryV2Props) {
  const platform = usePlatform()
  const global = useGlobal()
  const { sync, sdk } = global.ensureServerCtx(props.server)
  const server = useServer()
  const dialog = useDialog()
  const language = useLanguage()
  const policy = pickerMode(props.mode ?? "directory", props.start)
  const action = {
    file: language.t("dialog.directory.action.selectFile"),
    directory: language.t("dialog.directory.action.selectFolder"),
  }
  const [folder, setFolder] = createStore({ computer: false, naming: false, name: "", busy: false, error: false })
  const [roots] = createResource(
    () => props.server.http,
    (http) => fetchDirectoryRoots({ server: http, fetch: platform.fetch }),
  )
  const [location, setLocation] = createStore({ root: "", revision: 0 })
  const root = () => location.root
  const [input, setInput] = createSignal("")
  // The textbox shows the current path; only what the user actually typed drives the
  // suggestion search. A tree click or a navigation moves the path without searching,
  // so picking a folder never fires a search for the path it just selected.
  const [searchInput, setSearchInput] = createSignal("")
  const [selected, setSelected] = createSignal("")
  const [suggestionsOpen, setSuggestionsOpen] = createSignal(false)
  const [activeSuggestion, setActiveSuggestion] = createSignal(-1)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal(false)
  const [rootValid, setRootValid] = createSignal(false)
  const listings = new Map<string, Promise<Array<{ name: string; type: "file" | "directory" }> | undefined>>()
  const loads = createPriorityTaskQueue<Array<{ name: string; type: "file" | "directory" }> | undefined>(3)
  const advanced = new Set<string>()
  let treeApi: DirectoryTreeZagApi | undefined
  let pathArea: HTMLDivElement | undefined
  let navigation = 0
  let disposed = false
  onCleanup(() => {
    disposed = true
  })

  const missingBase = createMemo(() => !(sync.data.path.home || sync.data.path.directory))
  const [fallbackPath] = createResource(
    () => (missingBase() ? true : undefined),
    async (): Promise<Path | undefined> => {
      if ((await sdk.protocol) !== "v1") return
      return sdk.client.path
        .get()
        .then((result) => result.data)
        .catch(() => undefined)
    },
    { initialValue: undefined },
  )
  const home = createMemo(() => sync.data.path.home || fallbackPath()?.home || "")
  const lastOpened = () => server.projects.forServer(ServerConnection.key(props.server)).last() ?? ""
  const start = createMemo(
    () =>
      props.start ||
      lastOpened() ||
      sync.data.path.directory ||
      sync.data.path.home ||
      fallbackPath()?.directory ||
      fallbackPath()?.home,
  )
  const search = createDirectorySearch({ sdk, home, base: () => root() || start() })
  const [suggestions] = createResource(searchInput, async (value) => {
    const cleaned = cleanPickerInput(value)
    const typed = cleaned.replace(/\/+$/, "")
    const current = displayPickerPath(root(), value, home()).replace(/\/+$/, "")
    if (!cleaned || (root() && typed === current)) return { query: value, items: [] }
    const directories = (await search(value)).map((absolute) => ({ absolute, type: "directory" as const }))
    if (!policy.includeFiles) return { query: value, items: directories.slice(0, 5) }
    const base = pickerRoot(cleaned) || root() || start()
    if (!base) return { query: value, items: directories.slice(0, 5) }
    const files = await sdk.api.file
      .find({
        location: { directory: base },
        query: pickerFileSearchQuery(base, value, home()),
        type: "file",
        limit: 20,
      })
      .then((result) => result.data)
      .catch(() => [])
    const results = [
      ...directories,
      ...files.map((entry) => ({ absolute: absoluteTreePath(base, entry.path), type: "file" as const })),
    ]
    return {
      query: value,
      items: Array.from(new Map(results.map((result) => [result.absolute, result])).values()).slice(0, 8),
    }
  })
  const currentSuggestions = createMemo(() => currentPickerSuggestions(suggestions(), searchInput()))

  async function load(path: string, generation: number, eager = false) {
    const key = path.replace(/\/+$/, "")
    setError(false)
    const absolute = absoluteTreePath(root(), key)
    const existing = listings.get(key)
    if (existing && !eager) loads.promote(`${generation}:${key}`)
    const request =
      existing ??
      loads.schedule(`${generation}:${key}`, eager ? "background" : "user", () => {
        if (!activeTreeNavigation(generation, navigation)) return Promise.resolve(undefined)
        return sdk.api.file
          .list({ location: { directory: absolute } })
          .then((result) =>
            result.data.map((entry) => ({
              name: getFilename(entry.path.replace(/[\\/]+$/, "")),
              type: entry.type,
            })),
          )
          .catch(() => undefined)
      })
    listings.set(key, request)
    const nodes = await request
    if (!activeTreeNavigation(generation, navigation)) return false
    if (!nodes) {
      listings.delete(key)
      if (!key) setError(true)
      return false
    }
    if (!eager && advanceTreePreload(advanced, key)) {
      for (const directory of preloadTreeDirectories(key, nodes)) void load(directory, generation, true)
    }
    return true
  }

  async function navigate(path: string) {
    const value = policy.navigation(pickerAbsoluteInput(cleanPickerInput(path), home(), root() || start() || home()))
    if (!value || folder.busy) return
    const token = ++navigation
    setFolder({ computer: false, naming: false, error: false })
    setLoading(true)
    setRootValid(false)
    setSelected("")
    setSuggestionsOpen(false)
    setActiveSuggestion(-1)
    setSearchInput("")
    setLocation({ root: value, revision: token })
    setInput(displayPickerPath(value, value, home()))
    listings.clear()
    advanced.clear()
    const valid = await load("", token)
    if (!activeTreeNavigation(token, navigation)) return
    setRootValid(valid)
    setLoading(false)
    return valid ? token : undefined
  }

  // Reveals a possibly-deep absolute path inside the tree that is rooted at the
  // filesystem root: expands each ancestor and selects the target, so the user
  // still sees the tree listing from "/" (or "X:") instead of jumping into it.
  async function reveal(path: string) {
    const absolute = pickerAbsoluteInput(cleanPickerInput(path), home(), root() || start() || home())
    if (!absolute) return
    const fileTreeRoot = policy.includeFiles ? props.start : pickerRoot(absolute)
    if (!fileTreeRoot) return navigate(absolute)
    const rel = pickerRelativePath(fileTreeRoot, absolute)
    if (rel === undefined) return
    const token = await navigate(fileTreeRoot)
    if (!token || !activeTreeNavigation(token, navigation)) return
    if (!rel) {
      if (!policy.includeFiles) setSelected(pickerRootSelection(fileTreeRoot) ?? "")
      return
    }
    setLoading(true)
    const segments = rel.split("/").filter(Boolean)
    const targets: string[] = []
    let acc = ""
    let revealed = true
    for (let i = 0; i < segments.length; i++) {
      // Directory rows in the tree store a trailing slash.
      const suffix = policy.includeFiles && i === segments.length - 1 ? "" : "/"
      const lookup = (acc ? `${acc}/${segments[i]}` : segments[i]) + suffix
      targets.push(lookup)
      const valid = await load(acc, token)
      if (!activeTreeNavigation(token, navigation)) return
      if (!valid) {
        revealed = false
        break
      }
      acc = acc ? `${acc}/${segments[i]}` : segments[i]
    }
    setLoading(false)
    if (!revealed) {
      setError(true)
      return
    }
    treeApi?.reveal(targets)
    setSelected(policy.selection(root(), targets.at(-1) ?? "") ?? "")
    setInput(displayPickerPath(absolute, absolute, home()))
    setSearchInput("")
    setSuggestionsOpen(false)
    setActiveSuggestion(-1)
  }

  function complete() {
    const items = currentSuggestions()
    const match = items[activeSuggestion()] ?? items[0]
    if (!match) return
    const value = displayPickerPath(match.absolute, input(), home())
    setInput(match.type === "directory" && !value.endsWith("/") ? value + "/" : value)
    if (match.type === "file") {
      setSelected(policy.selection(root(), pickerFileSearchQuery(root(), match.absolute, home())) ?? "")
      setSuggestionsOpen(false)
      setActiveSuggestion(-1)
    }
  }

  function chooseSuggestion(suggestion: { absolute: string; type: "file" | "directory" }) {
    if (suggestion.type === "directory") {
      // navigate() clears the selection synchronously before it awaits, so the
      // suggestion is re-selected here as the folder the tree is now rooted at.
      void navigate(suggestion.absolute)
      setSelected(pickerRootSelection(root()) ?? "")
      return
    }
    setInput(displayPickerPath(suggestion.absolute, input(), home()))
    setSelected(policy.selection(root(), pickerFileSearchQuery(root(), suggestion.absolute, home())) ?? "")
    setSuggestionsOpen(false)
    setActiveSuggestion(-1)
  }

  function moveSuggestion(delta: -1 | 1) {
    setSuggestionsOpen(true)
    setActiveSuggestion((current) => nextSuggestionIndex(current, delta, currentSuggestions().length))
  }

  function activeSuggestionValue() {
    const items = currentSuggestions()
    return items[activeSuggestion()] ?? items[0]
  }

  const keyActions: Partial<Record<string, () => void>> = {
    ArrowDown: () => moveSuggestion(1),
    ArrowUp: () => moveSuggestion(-1),
    Enter: () => {
      const suggestion = activeSuggestionValue()
      if (suggestion) chooseSuggestion(suggestion)
      if (!suggestion) void reveal(input())
    },
    Tab: complete,
  }

  function handleInputKey(event: KeyboardEvent) {
    const action = keyActions[event.key]
    if (!action) return
    if (event.key === "Tab" && event.shiftKey) return
    event.preventDefault()
    action()
  }

  function resolve() {
    const path = policy.result(selected(), rootValid())
    if (!path || folder.busy) return
    props.onSelect(props.multiple ? [path] : path)
    dialog.close()
  }

  async function openSubdirectory() {
    const parent = policy.result(selected(), rootValid())
    if (!parent || folder.busy || !folder.name.trim()) return
    setFolder({ busy: true, error: false })
    await createPickerDirectory({ server: props.server.http, fetch: platform.fetch, parent, name: folder.name })
      .then((directory) => {
        if (disposed) return
        props.onSelect(props.multiple ? [directory] : directory)
        dialog.close()
      })
      .catch(() => setFolder("error", true))
      .finally(() => setFolder("busy", false))
  }

  function showRoot() {
    if (!roots() || policy.includeFiles) {
      void navigate(policy.includeFiles ? props.start || root() : pickerRoot(root()) || root())
      return
    }
    navigation++
    setSelected("")
    setLoading(false)
    setFolder({ computer: true, naming: false, error: false })
  }

  onMount(() => {
    const closeSuggestions = (event: PointerEvent) => {
      if (pathArea?.contains(event.target as Node)) return
      setSuggestionsOpen(false)
      setActiveSuggestion(-1)
    }
    document.addEventListener("pointerdown", closeSuggestions)
    onCleanup(() => document.removeEventListener("pointerdown", closeSuggestions))
  })

  function listDirectory(relative: string): Promise<Array<{ name: string; type: "file" | "directory" }> | undefined> {
    const key = relative.replace(/\/+$/, "")
    return load(key, navigation).then((valid) =>
      valid ? listings.get(key)?.then((nodes) => nodes ?? undefined) : undefined,
    )
  }

  function handleTreeSelect(path: string) {
    // `path` is relative to the tree root, so the textbox needs the absolute path —
    // otherwise it would show "home/mark" for the row at "/home/mark".
    const absolute = absoluteTreePath(root(), path)
    setSelected(path ? (policy.selection(root(), path) ?? "") : "")
    setInput(displayPickerPath(absolute, absolute, home()))
    setSearchInput("")
    setSuggestionsOpen(false)
    setActiveSuggestion(-1)
  }

  createEffect(() => {
    const path = start()
    if (!path || root()) return
    void navigate(policy.includeFiles ? path : pickerRoot(path) || path)
  })

  return (
    <Dialog size="large" class="directory-picker-v2">
      <DialogHeader>
        <DialogTitle>{props.title ?? language.t("command.project.open")}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="directory-picker-v2-body pt-4!">
        <div class="directory-picker-v2-path" ref={pathArea}>
          <TextInputV2
            value={input()}
            autofocus
            autocomplete="off"
            spellcheck={false}
            class="!w-full"
            onInput={(event) => {
              const value = cleanPickerInput(event.currentTarget.value)
              setInput(value)
              setSearchInput(value)
              setSelected("")
              setSuggestionsOpen(true)
              setActiveSuggestion(-1)
            }}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={suggestionsOpen()}
            aria-controls="directory-picker-v2-suggestions"
            aria-activedescendant={
              activeSuggestion() >= 0 ? `directory-picker-v2-suggestion-${activeSuggestion()}` : undefined
            }
            onKeyDown={handleInputKey}
          />
          <div class="directory-picker-v2-actions">
            <ButtonV2 size="small" variant="ghost" onClick={() => void navigate(home())}>
              ~
            </ButtonV2>
            <ButtonV2 size="small" variant="ghost" onClick={showRoot}>
              {language.t("dialog.directory.root")}
            </ButtonV2>
            <ButtonV2
              size="small"
              variant="ghost"
              onClick={() => (root() === pickerRoot(root()) ? showRoot() : void navigate(pickerParent(root())))}
            >
              {language.t("dialog.directory.parent")}
            </ButtonV2>
          </div>
          <Show when={suggestionsOpen() && currentSuggestions().length > 0}>
            <div id="directory-picker-v2-suggestions" role="listbox" class="directory-picker-v2-suggestions">
              <For each={currentSuggestions()}>
                {(suggestion, index) => (
                  <button
                    id={`directory-picker-v2-suggestion-${index()}`}
                    data-directory-path={suggestion.absolute}
                    role="option"
                    aria-selected={index() === activeSuggestion()}
                    data-active={index() === activeSuggestion() ? "" : undefined}
                    onPointerMove={() => setActiveSuggestion(index())}
                    onClick={() => chooseSuggestion(suggestion)}
                  >
                    {displayPickerPath(suggestion.absolute, input(), home())}
                    {suggestion.type === "directory" ? "/" : ""}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
        <div class="directory-picker-v2-browser" aria-busy={folder.busy}>
          <Show when={!policy.includeFiles}>
            <nav class="directory-picker-v2-locations" aria-label={language.t("dialog.directory.root")}>
              <ButtonV2 variant="ghost" disabled={folder.busy} onClick={showRoot}>
                {language.t(roots()?.windows ? "dialog.directory.computer" : "dialog.directory.root")}
              </ButtonV2>
              <div class="directory-picker-v2-drives">
                <For each={pickerLocationRoots(roots()?.roots ?? [], root())}>
                  {(directory) => (
                    <ButtonV2
                      variant="ghost"
                      data-root-path={directory}
                      aria-current={!folder.computer && pickerRoot(root()) === directory ? "location" : undefined}
                      disabled={folder.busy}
                      onClick={() => void navigate(directory)}
                    >
                      {directory}
                    </ButtonV2>
                  )}
                </For>
              </div>
            </nav>
          </Show>
          <Show when={!folder.computer}>
            <ButtonV2
              variant="ghost"
              disabled={policy.includeFiles || !rootValid() || folder.busy}
              onClick={() => {
                setSelected(pickerRootSelection(root()) ?? "")
                setInput(displayPickerPath(root(), root(), home()))
                setSearchInput("")
                setSuggestionsOpen(false)
              }}
            >
              {displayPickerPath(root(), root(), "")}
            </ButtonV2>
            <Show when={loading()}>
              <div class="directory-picker-v2-state">{language.t("common.loading")}</div>
            </Show>
            <Show when={!loading() && error()}>
              <div class="directory-picker-v2-state">{language.t("dialog.directory.readError")}</div>
            </Show>
            <Show when={location.revision} keyed>
              {(_revision) => (
                <DirectoryTreeZag
                  root={root}
                  policy={policy}
                  list={listDirectory}
                  onSelect={handleTreeSelect}
                  ref={(api) => {
                    treeApi = api
                  }}
                />
              )}
            </Show>
          </Show>
        </div>
        <div class="directory-picker-v2-selection">{policy.result(selected(), rootValid())}</div>
        <Show when={folder.naming}>
          <TextInputV2
            value={folder.name}
            autofocus
            disabled={folder.busy}
            placeholder={language.t("dialog.directory.subdirectory.name")}
            aria-label={language.t("dialog.directory.subdirectory.name")}
            onInput={(event) => setFolder({ name: event.currentTarget.value, error: false })}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                void openSubdirectory()
              }
            }}
          />
          <Show when={folder.error}>
            <p role="alert">{language.t("dialog.directory.subdirectory.error")}</p>
          </Show>
        </Show>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" disabled={folder.busy} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <Show when={!policy.includeFiles && roots()}>
          <ButtonV2
            variant="neutral"
            disabled={folder.busy || !policy.result(selected(), rootValid()) || (folder.naming && !folder.name.trim())}
            onClick={() =>
              folder.naming ? void openSubdirectory() : setFolder({ naming: true, name: "", error: false })
            }
          >
            {language.t("dialog.directory.subdirectory.open")}
          </ButtonV2>
        </Show>
        <ButtonV2
          variant="contrast"
          disabled={folder.busy || !policy.result(selected(), rootValid())}
          onClick={resolve}
        >
          {action[policy.action]}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
