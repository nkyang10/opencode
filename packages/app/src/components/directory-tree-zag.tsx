import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { useMachine, normalizeProps } from "@zag-js/solid"
import * as treeView from "@zag-js/tree-view"
import type { DirectoryPickerMode } from "./directory-picker-domain"

type Listing = { name: string; type: "file" | "directory" }

export type DirectoryTreeZagApi = {
  expand: (values: string[]) => void
  select: (value: string) => void
  reset: () => void
  /** Expand each ancestor (relative trailing-slash values, leaf last) then select the leaf once loaded. */
  reveal: (values: string[]) => void
}

interface DirectoryTreeZagProps {
  root: () => string
  policy: DirectoryPickerMode
  /** Fetch the raw listing for a relative tree path ("" for the root). */
  list: (relative: string) => Promise<Listing[] | undefined>
  onSelect: (path: string) => void
  ref?: (api: DirectoryTreeZagApi) => void
}

type ZagNode = {
  value: string
  label?: string
  childrenCount?: number
  children?: unknown[]
}
type VisibleNodeItem = { node: ZagNode; indexPath: number[] }
type NodeProps = { node: ZagNode; indexPath: number[] }

const ROOT_VALUE = "\u0000dir-picker-root"
const revealTimers = new Set<ReturnType<typeof setInterval>>()

function toNode(path: string): ZagNode {
  const isBranch = path.endsWith("/")
  const label = path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? path
  return isBranch ? { value: path, label, childrenCount: 1 } : { value: path, label }
}

export function DirectoryTreeZag(props: DirectoryTreeZagProps) {
  const [collection, setCollection] = createSignal(treeView.collection.empty())

  const buildCollection = () =>
    treeView.collection({
      rootNode: { value: ROOT_VALUE, label: props.root(), childrenCount: 1 },
    })

  // Rebuild a fresh collection whenever the filesystem root changes.
  createEffect(
    on(
      props.root,
      () => setCollection(buildCollection()),
      { defer: false },
    ),
  )

  const listChildren = async (value: string) => {
    const relative = value === ROOT_VALUE ? "" : value
    const nodes = await props.list(relative)
    if (!nodes) return []
    return props.policy.entries(relative, nodes).map(toNode)
  }

  const machineProps = createMemo<treeView.Props>(() => ({
    id: "directory-picker-v2",
    collection: collection(),
    selectionMode: "single",
    expandOnClick: true,
    loadChildren: (details) => listChildren(details.node?.value ?? ROOT_VALUE),
    onSelectionChange: (details) => {
      const path = details.selectedValue.at(-1)
      if (path) props.onSelect(path)
    },
  }))

  const service = useMachine(treeView.machine, machineProps)
  const api = createMemo(() => treeView.connect(service, normalizeProps))

  // Auto-expand the hidden filesystem root so its children render immediately.
  createEffect(
    on(
      collection,
      () => {
        if (collection().rootNode) api().expand([ROOT_VALUE])
      },
      { defer: true },
    ),
  )

  function expand(values: string[]) {
    api().expand(Array.from(new Set([...api().expandedValue, ...values])))
  }
  function select(value: string) {
    api().setSelectedValue([value])
    props.onSelect(value)
  }
  function reset() {
    api().setExpandedValue([])
    api().setSelectedValue([])
  }

  function reveal(values: string[]) {
    const ancestors = values.slice(0, -1)
    const leaf = values.at(-1)
    if (!leaf) return
    // Synchronize the collection to the current root before revealing, in case the
    // root prop changed after the last collection build (e.g. navigate() then reveal()).
    setCollection(buildCollection())
    api().expand([ROOT_VALUE, ...ancestors])
    void waitForNodes([ROOT_VALUE, ...ancestors]).then(() => {
      api().setSelectedValue([leaf])
      props.onSelect(leaf)
    })
  }

  function waitForNodes(values: string[]): Promise<void> {
    return new Promise((resolvePromise) => {
      const check = () => {
        const present = new Set(api().collection.flatten().map((item) => item.value))
        return values.every((v) => v === ROOT_VALUE || present.has(v))
      }
      if (check()) {
        resolvePromise()
        return
      }
      const timer = setInterval(() => {
        if (check()) {
          clearInterval(timer)
          revealTimers.delete(timer)
          resolvePromise()
        }
      }, 60)
      revealTimers.add(timer)
      setTimeout(() => clearInterval(timer), 8000)
    })
  }

  props.ref?.({
    expand,
    select,
    reset,
    reveal,
  })

  onCleanup(() => {
    for (const timer of revealTimers) clearInterval(timer)
  })

  const visible = createMemo<VisibleNodeItem[]>(() => api().getVisibleNodes() as VisibleNodeItem[])
  const depth = (indexPath: number[]) => indexPath.length

  return (
    <div class="directory-picker-v2-tree" role="tree" {...api().getRootProps()}>
      <For each={visible()}>
        {(entry) => {
          const node = entry.node
          const indexPath = entry.indexPath
          const propsFor = { node, indexPath } satisfies NodeProps
          const state = api().getNodeState(propsFor)
          const isBranch = state.isBranch
          return (
            <div
              class="directory-picker-v2-row"
              style={{ "padding-left": `${(depth(indexPath) - 1) * 14 + 8}px` }}
            >
              <Show when={isBranch} fallback={null}>
                <button {...api().getBranchProps(propsFor)}>
                  <span
                    class={
                      state.expanded ? "directory-picker-v2-chevron is-open" : "directory-picker-v2-chevron"
                    }
                  >
                    ▸
                  </span>
                  <span {...api().getBranchTextProps(propsFor)}>{String(node.label)}</span>
                </button>
              </Show>
              <Show when={!isBranch}>
                <button {...api().getItemProps(propsFor)}>
                  <span class="directory-picker-v2-chevron" style={{ visibility: "hidden" }} />
                  <span {...api().getItemTextProps(propsFor)}>{String(node.label)}</span>
                </button>
              </Show>
            </div>
          )
        }}
      </For>
    </div>
  )
}
