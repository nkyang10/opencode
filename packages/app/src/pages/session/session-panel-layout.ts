export function sessionPanelLayout(input: {
  review: boolean
  terminal: boolean
  files: boolean
  /**
   * FE-028: the commentary column. It lives inside the side panel, so a commentary-only view has to make
   * that panel visible — otherwise the toggle sets the store, the button lights up, and nothing renders.
   */
  commentary?: boolean
}) {
  return {
    visible: input.review || input.terminal || input.files || input.commentary === true,
    stacked: input.review && input.terminal,
  }
}
