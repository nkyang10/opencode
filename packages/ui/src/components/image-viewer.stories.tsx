// @ts-nocheck
import { createSignal, onMount } from "solid-js"
import * as mod from "./image-viewer"
import { Button } from "./button"
import { useDialog } from "../context/dialog"

const docs = `### Overview
Full-screen image viewer with a gallery, pointer-anchored zoom, panning and image actions.

Use \`useDialog().show\` and pass the complete gallery plus the selected index.

### API
- Required: \`items\`, \`index\`, \`onIndexChange\`, \`onClose\`.
- Optional: \`onCopy\`, \`onSave\`, \`onActions\`, \`copyDisabledReason\`.

### Variants and states
- Fit-to-viewport open, 10%–800% zoom, fit and 100% presets.
- Toolbar hides zoom and file controls below 640px; header keeps title, actions and close.

### Behavior
- Wheel or trackpad pinch zooms around the pointer.
- Drag or arrow keys pan while zoomed; arrow keys navigate at fit.
- Double-click toggles fit and 100%; from 200% the image is pixelated.

### Accessibility
- Kobalte dialog traps focus. Zoom changes are announced politely.
- Controls use localized labels and shortcuts.

### Theming/tokens
- Uses \`data-component="image-viewer"\` and slot attributes.
`

const items = [
  {
    src: "https://placehold.co/960x640/png?text=First",
    alt: "First image",
    caption: "First image",
    filename: "first.png",
    mime: "image/png",
    width: 960,
    height: 640,
    source: "read · src/first.png",
  },
  {
    src: "https://placehold.co/640x960/png?text=Second",
    alt: "Second image",
    caption: "Second image",
    filename: "second.png",
    mime: "image/png",
    width: 640,
    height: 960,
    source: "screenshot · firefox",
  },
]

function Story() {
  const dialog = useDialog()
  const [index, setIndex] = createSignal(0)
  const open = () =>
    dialog.show(() => (
      <mod.ImageViewer
        items={items}
        index={index()}
        onIndexChange={setIndex}
        onClose={() => dialog.close()}
        onCopy={() => {}}
        onSave={() => {}}
        onActions={() => {}}
      />
    ))

  onMount(open)

  return (
    <Button variant="secondary" onClick={open}>
      Open image viewer
    </Button>
  )
}

export default {
  title: "UI/ImageViewer",
  id: "components-image-viewer",
  component: mod.ImageViewer,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component: docs,
      },
    },
  },
}

export const Basic = {
  render: () => <Story />,
}
