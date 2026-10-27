export type Dimensions = {
  mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp"
  width: number
  height: number
}

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

const startsWith = (bytes: Uint8Array, prefix: readonly number[], offset = 0) =>
  prefix.every((value, index) => bytes[offset + index] === value)

const ascii = (bytes: Uint8Array, offset: number, length: number) =>
  String.fromCharCode(...bytes.subarray(offset, offset + length))

const uint16BE = (bytes: Uint8Array, offset: number) => (bytes[offset] << 8) | bytes[offset + 1]

const uint16LE = (bytes: Uint8Array, offset: number) => bytes[offset] | (bytes[offset + 1] << 8)

const uint24LE = (bytes: Uint8Array, offset: number) =>
  bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)

const uint32BE = (bytes: Uint8Array, offset: number) =>
  ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0

function valid(dimensions: Dimensions | undefined) {
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) return undefined
  return dimensions
}

export function imageDimensions(bytes: Uint8Array): Dimensions | undefined {
  return valid(png(bytes) ?? gif(bytes) ?? jpeg(bytes) ?? webp(bytes))
}

function png(bytes: Uint8Array): Dimensions | undefined {
  if (bytes.length < 24) return
  if (!startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return
  if (ascii(bytes, 12, 4) !== "IHDR") return

  return {
    mime: "image/png",
    width: uint32BE(bytes, 16),
    height: uint32BE(bytes, 20),
  }
}

function gif(bytes: Uint8Array): Dimensions | undefined {
  if (bytes.length < 10) return
  if (ascii(bytes, 0, 6) !== "GIF87a" && ascii(bytes, 0, 6) !== "GIF89a") return

  return {
    mime: "image/gif",
    width: uint16LE(bytes, 6),
    height: uint16LE(bytes, 8),
  }
}

function jpeg(bytes: Uint8Array): Dimensions | undefined {
  if (bytes.length < 4) return
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return

  let offset = 2
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) return
    const marker = bytes[offset + 1]
    if (marker === 0xff) {
      offset += 1
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    if (marker === 0xd9) return
    if (offset + 4 > bytes.length) return

    const length = uint16BE(bytes, offset + 2)
    if (length < 2 || offset + 2 + length > bytes.length) return
    if (SOF_MARKERS.has(marker)) {
      if (length < 7) return
      return {
        mime: "image/jpeg",
        height: uint16BE(bytes, offset + 5),
        width: uint16BE(bytes, offset + 7),
      }
    }
    offset += 2 + length
  }
}

function webp(bytes: Uint8Array): Dimensions | undefined {
  if (bytes.length < 20) return
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return
  const chunk = ascii(bytes, 12, 4)

  if (chunk === "VP8 ") {
    if (bytes.length < 30) return
    // The lossy bitstream starts with a 3-byte frame tag before the start code.
    if (!startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) return
    return {
      mime: "image/webp",
      width: uint16LE(bytes, 26) & 0x3fff,
      height: uint16LE(bytes, 28) & 0x3fff,
    }
  }

  if (chunk === "VP8L") {
    if (bytes.length < 25) return
    if (bytes[20] !== 0x2f) return
    const size = uint24LE(bytes, 21) | (bytes[24] << 24)
    return {
      mime: "image/webp",
      width: (size & 0x3fff) + 1,
      height: ((size >>> 14) & 0x3fff) + 1,
    }
  }

  if (chunk === "VP8X") {
    if (bytes.length < 30) return
    return {
      mime: "image/webp",
      width: uint24LE(bytes, 24) + 1,
      height: uint24LE(bytes, 27) + 1,
    }
  }
}

export * as ImageDimensions from "./dimensions"
