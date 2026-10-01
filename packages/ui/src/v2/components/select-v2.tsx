import { Select as Kobalte } from "@kobalte/core/select"
import fuzzysort from "fuzzysort"
import { Show, createMemo, createSignal, onCleanup, splitProps, type ComponentProps, type JSX } from "solid-js"
import "./select-v2.css"

function groupOptions<T>(options: T[], groupBy?: (x: T) => string): { category: string; options: T[] }[] {
  if (!groupBy) {
    return [{ category: "", options }]
  }
  const map = new Map<string, T[]>()
  for (const opt of options) {
    const key = groupBy(opt)
    const arr = map.get(key)
    if (arr) arr.push(opt)
    else map.set(key, [opt])
  }
  return [...map.entries()].map(([category, opts]) => ({ category, options: opts }))
}

const ChevronDown = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path
      d="M11 9.5L8 6.5L5 9.5"
      stroke="currentColor"
      stroke-width="1"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
)

const CheckSmall = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path
      d="M3.53564 8.17857L6.39279 11.75L12.4642 4.25"
      stroke="currentColor"
      stroke-width="1"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
)

export type SelectV2Props<T> = Omit<
  ComponentProps<typeof Kobalte<T, { category: string; options: T[] }>>,
  "value" | "onSelect" | "children" | "options" | "itemComponent" | "sectionComponent" | "defaultValue" | "multiple"
> & {
  placeholder?: string
  options: T[]
  /** Selected option (single selection). */
  current?: T
  value?: (x: T) => string
  label?: (x: T) => string
  groupBy?: (x: T) => string
  onSelect?: (value: T | null) => void
  onHighlight?: (value: T | undefined) => void | (() => void)
  /** `base` / `large` match text-input-v2; `inline` is a compact settings-row trigger. */
  appearance?: "base" | "large" | "inline"
  /**
   * Show a type-to-filter field above the list. Opt-in, because a dropdown with a search box is wrong for the
   * dozen selects that have five options, and changing them all to find out is not an acceptable trade.
   *
   * `filterTerms` supplies whatever else is worth matching on — a voice's human description, its aliases —
   * so the query can be "cantonese" as well as "zh-HK-HiuMaanNeural".
   */
  filterable?: boolean
  filterPlaceholder?: string
  filterTerms?: (x: T) => string | readonly string[]
  invalid?: boolean
  numeric?: boolean
  children?: (item: T) => JSX.Element
  valueClass?: string
}

export function SelectV2<T>(props: SelectV2Props<T>) {
  const [local, others] = splitProps(props, [
    "class",
    "classList",
    "placeholder",
    "options",
    "current",
    "value",
    "label",
    "groupBy",
    "onSelect",
    "onHighlight",
    "onOpenChange",
    "children",
    "appearance",
    "filterable",
    "filterPlaceholder",
    "filterTerms",
    "invalid",
    "numeric",
    "disabled",
    "valueClass",
    "placement",
    "gutter",
    "sameWidth",
    "flip",
    "slide",
    "fitViewport",
  ])

  const inline = () => (local.appearance ?? "base") === "inline"

  const state: { key?: string; cleanup?: void | (() => void) } = {}

  const stop = () => {
    state.cleanup?.()
    state.cleanup = undefined
    state.key = undefined
  }

  const keyFor = (item: T) => (local.value ? local.value(item) : String(item as string))

  const move = (item: T | undefined) => {
    if (!local.onHighlight) return
    if (!item) {
      stop()
      return
    }
    const key = keyFor(item)
    if (state.key === key) return
    state.cleanup?.()
    state.cleanup = local.onHighlight(item)
    state.key = key
  }

  onCleanup(stop)

  const [query, setQuery] = createSignal("")
  const filtered = createMemo(() => {
    if (!local.filterable) return local.options
    const q = query().trim()
    if (!q) return local.options
    // fuzzysort, the same matcher `useFilteredList` uses: "hkmn" finds `zh-HK-HiuMaanNeural`, which a
    // substring test cannot, and results come back ranked — the order a reader expects from a search.
    //
    // fuzzysort's `keys` takes property paths, not accessor functions, so the searchable text is built once
    // per option and matched on its own field. The label, the technical name and the caller's extra terms
    // are all joined: which of them matched is not the reader's problem.
    const rows = local.options.map((option) => {
      const extra = local.filterTerms?.(option)
      const base = [
        local.label ? local.label(option) : String(option as string),
        local.value ? local.value(option) : String(option as string),
      ]
      return { option, text: [...base, ...(extra ? (typeof extra === "string" ? [extra] : extra) : [])].join(" ") }
    })
    return fuzzysort.go(q, rows, { keys: ["text"] }).map((row) => row.obj.option)
  })

  const grouped = createMemo(() => groupOptions(filtered(), local.groupBy))

  return (
    <Kobalte<T, { category: string; options: T[] }>
      {...others}
      multiple={false}
      allowDuplicateSelectionEvents={false}
      disabled={local.disabled}
      data-component="select-v2-root"
      placement={local.placement ?? (inline() ? "bottom-end" : "bottom-start")}
      gutter={local.gutter ?? 4}
      sameWidth={local.sameWidth ?? !inline()}
      flip={local.flip ?? true}
      slide={local.slide ?? true}
      fitViewport={local.fitViewport ?? false}
      value={local.current}
      options={grouped()}
      optionValue={(x) => (local.value ? local.value(x) : String(x as string))}
      optionTextValue={(x) => (local.label ? local.label(x) : String(x as string))}
      optionGroupChildren="options"
      placeholder={local.placeholder}
      sectionComponent={(sectionProps) => (
        <Kobalte.Section>
          <Show when={sectionProps.section.rawValue.category}>
            <div data-slot="menu-v2-group-label">{sectionProps.section.rawValue.category}</div>
          </Show>
        </Kobalte.Section>
      )}
      itemComponent={(itemProps) => (
        <Kobalte.Item
          {...itemProps}
          data-component="menu-v2-item"
          onPointerEnter={() => move(itemProps.item.rawValue)}
          onPointerMove={() => move(itemProps.item.rawValue)}
          onFocus={() => move(itemProps.item.rawValue)}
        >
          <Kobalte.ItemLabel data-slot="menu-v2-item-content" as="span">
            {local.children
              ? local.children(itemProps.item.rawValue)
              : local.label
                ? local.label(itemProps.item.rawValue)
                : String(itemProps.item.rawValue as string)}
          </Kobalte.ItemLabel>
          <Kobalte.ItemIndicator data-slot="menu-v2-item-indicator" forceMount>
            <CheckSmall />
          </Kobalte.ItemIndicator>
        </Kobalte.Item>
      )}
      onChange={(next) => {
        const v = next == null ? null : Array.isArray(next) ? ((next[0] as T) ?? null) : (next as T)
        local.onSelect?.(v)
        stop()
      }}
      onOpenChange={(open) => {
        local.onOpenChange?.(open)
        // A stale query would silently hide most of the list the next time it opens.
        if (!open) {
          stop()
          setQuery("")
        }
      }}
    >
      <Kobalte.Trigger
        as="div"
        data-component="select-v2"
        data-appearance={local.appearance ?? "base"}
        data-invalid={local.invalid ? "" : undefined}
        data-numeric={local.numeric ? "" : undefined}
        disabled={local.disabled}
        data-disabled={local.disabled ? "" : undefined}
        classList={{
          ...local.classList,
          [local.class ?? ""]: !!local.class,
        }}
      >
        <div data-slot="select-v2-value">
          <Kobalte.Value<T> data-slot="select-v2-value-text" class={local.valueClass}>
            {(st) => {
              const selected = st.selectedOption()
              if (local.label && selected != null) return local.label(selected)
              return selected != null ? (selected as string) : ""
            }}
          </Kobalte.Value>
        </div>
        <span data-slot="select-v2-chevron" aria-hidden="true">
          <ChevronDown />
        </span>
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content data-component="menu-v2-content" data-slot="select-v2-content">
          {local.filterable && (
            <input
              // Kobalte's Select owns the keyboard: a keypress that reaches it is treated as typeahead and
              // the menu closes on some paths. The field has to keep the event for itself.
              onKeyDown={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              data-slot="select-v2-filter"
              data-component="select-v2-filter"
              type="text"
              role="searchbox"
              aria-label={local.filterPlaceholder}
              placeholder={local.filterPlaceholder}
              value={query()}
              // `preventDefault` stops the Select from moving focus or typeahead-matching as you type.
              onInput={(event) => {
                event.preventDefault()
                setQuery(event.currentTarget.value)
              }}
              class="select-v2-filter"
            />
          )}
          <Kobalte.Listbox data-slot="select-v2-listbox" />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}
