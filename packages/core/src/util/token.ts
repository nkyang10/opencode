export * as Token from "./token"

const CHARS_PER_TOKEN = 4
const IMAGE_TOKEN_DIVISOR = 750

export const estimate = (input: string) => Math.max(0, Math.round(input.length / CHARS_PER_TOKEN))

export const estimateImage = (input: { readonly width: number; readonly height: number }) =>
  Math.max(1, Math.ceil((input.width * input.height) / IMAGE_TOKEN_DIVISOR))
