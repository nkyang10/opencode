type CommandKeybind = {
  keybindParts: (id: string) => string[]
}

export function reviewTooltipKeybind(command: CommandKeybind, _translate?: (key: string) => string) {
  return command.keybindParts("review.toggle")
}

export function newTabTooltipKeybind(command: CommandKeybind, _translate?: (key: string) => string) {
  return command.keybindParts("tab.new")
}

export function commentaryTooltipKeybind(command: CommandKeybind, _translate?: (key: string) => string) {
  return command.keybindParts("commentary.toggle")
}
