export function modelVisible(input: {
  providerID: string
  visibility?: "show" | "hide"
  latest: boolean
  validRelease: boolean
}) {
  if (input.visibility) return input.visibility === "show"
  if (input.providerID === "opencode" || input.providerID === "opencode-go") return false
  return input.latest || !input.validRelease
}
