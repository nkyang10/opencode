import { Button as Kobalte } from "@kobalte/core/button"
import { type ComponentProps, splitProps } from "solid-js"
import { JSX } from "solid-js"
import "./icon-button-v2.css"

export interface IconButtonV2Props
  extends ComponentProps<typeof Kobalte>,
    Pick<ComponentProps<"button">, "class" | "classList"> {
  // temporary
  /**
   * A static element, or a getter for one that changes with state.
   *
   * Passing `icon={<Icon name={someSignal() ? "a" : "b"} />}` looks reactive and is not: the element is built
   * once, when the button is created, so the signal is read a single time and the glyph never changes. A mute
   * button that does not flip its icon is exactly that bug. The getter form makes it re-evaluate.
   */
  icon?: JSX.Element | (() => JSX.Element)
  // icon: IconProps["name"]
  size?: "small" | "normal" | "large"
  // iconSize?: IconProps["size"]
  variant?: "neutral" | "contrast" | "ghost" | "ghost-muted"
  state?: "rest" | "hover" | "pressed"
}

export function IconButtonV2(props: ComponentProps<"button"> & IconButtonV2Props) {
  const [split, rest] = splitProps(props, ["variant", "size", "iconSize", "class", "classList", "state", "icon"])
  return (
    <Kobalte
      {...rest}
      data-component="icon-button-v2"
      // data-icon={props.icon}
      data-size={split.size || "normal"}
      data-variant={split.variant || "neutral"}
      data-state={split.state}
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      {typeof split.icon === "function" ? split.icon() : split.icon}
      {/*<Icon name={props.icon} size={split.iconSize ?? (split.size === "large" ? "normal" : "small")} />*/}
    </Kobalte>
  )
}
