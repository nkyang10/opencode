import type { Component, JSX } from "solid-js"
import "../settings-v2.css"

export interface SettingsRowV2Props {
  title: string | JSX.Element
  description: string | JSX.Element
  children: JSX.Element
  /**
   * Put the control on its own full-width line under the copy instead of beside it. A switch or a select
   * belongs in the row, but a textarea or anything else multi-line is unreadable in a 220px column.
   */
  stacked?: boolean
}

export const SettingsRowV2: Component<SettingsRowV2Props> = (props) => {
  return (
    <div data-component="settings-v2-row" data-stacked={props.stacked ? "" : undefined}>
      <div data-slot="settings-v2-row-copy">
        <div data-slot="settings-v2-row-title">{props.title}</div>
        <div data-slot="settings-v2-row-description">{props.description}</div>
      </div>
      <div data-slot="settings-v2-row-control">{props.children}</div>
    </div>
  )
}
