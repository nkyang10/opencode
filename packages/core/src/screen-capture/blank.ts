export * as ScreenCaptureBlank from "./blank"

import { inflateSync } from "node:zlib"
import { imageDimensions } from "../image/dimensions"

const MAX_BYTES = 50 * 1024 * 1024

export function isLikelyBlankPng(bytes: Uint8Array) {
  const image = pngHeader(bytes)
  if (!image || bytes.length > MAX_BYTES) return false
  const idat = idatBytes(bytes)
  if (!idat) return false
  const pixels = decodePng(idat, image)
  if (!pixels) return false
  return isUniform(pixels, image.width, image.height, image.channels)
}

function pngHeader(bytes: Uint8Array) {
  const dimensions = imageDimensions(bytes)
  if (dimensions?.mime !== "image/png" || bytes.length < 33) return
  const bitDepth = bytes[24] ?? 0
  const colorType = bytes[25] ?? 0
  const compression = bytes[26] ?? 0
  const filter = bytes[27] ?? 0
  const interlace = bytes[28] ?? 0
  const channels = channelsFor(colorType, bitDepth)
  if (!channels || compression !== 0 || filter !== 0 || interlace !== 0) return
  return { width: dimensions.width, height: dimensions.height, bitDepth, channels }
}

function channelsFor(colorType: number, bitDepth: number) {
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]
  if (!channels || (bitDepth !== 8 && bitDepth !== 16)) return
  return channels * (bitDepth === 16 ? 2 : 1)
}

function idatBytes(bytes: Uint8Array) {
  const chunks: Uint8Array[] = []
  let offset = 8
  while (offset + 8 <= bytes.length) {
    const length = uint32BE(bytes, offset)
    const type = ascii(bytes, offset + 4, 4)
    const start = offset + 8
    const end = start + length
    if (end > bytes.length) return
    if (type === "IDAT") chunks.push(bytes.subarray(start, end))
    if (type === "IEND") break
    offset = end + 4
  }
  if (chunks.length === 0) return
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let written = 0
  for (const chunk of chunks) {
    out.set(chunk, written)
    written += chunk.length
  }
  return out
}

function uint32BE(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] ?? 0) << 24 | (bytes[offset + 1] ?? 0) << 16 | (bytes[offset + 2] ?? 0) << 8 | (bytes[offset + 3] ?? 0)) >>> 0
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function decodePng(idat: Uint8Array, image: { width: number; height: number; channels: number }) {
  try {
    const inflated = new Uint8Array(inflateSync(idat))
    const stride = image.width * image.channels
    const expected = image.height * (stride + 1)
    if (inflated.length < expected) return
    const out = new Uint8Array(stride)
    const rows: Uint8Array[] = []
    for (let row = 0; row < image.height; row++) {
      const sourceOffset = row * (stride + 1)
      const filter = inflated[sourceOffset] ?? 0
      const source = inflated.subarray(sourceOffset + 1, sourceOffset + 1 + stride)
      const previous = row === 0 ? undefined : rows[row - 1]
      unfilter(filter, source, previous, out, image.channels)
      const copy = out.slice()
      rows.push(copy)
    }
    return rows
  } catch {
    return
  }
}

function unfilter(
  filter: number,
  source: Uint8Array,
  previous: Uint8Array | undefined,
  out: Uint8Array,
  channels: number,
) {
  for (let i = 0; i < source.length; i++) {
    const left = i >= channels ? out[i - channels]! : 0
    const up = previous?.[i] ?? 0
    const upperLeft = previous && i >= channels ? previous[i - channels]! : 0
    const raw = source[i] ?? 0
    out[i] = raw + (filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, upperLeft))
  }
}

function paeth(a: number, b: number, c: number) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function isUniform(rows: ReadonlyArray<Uint8Array>, width: number, height: number, channels: number) {
  if (width <= 0 || height <= 0) return false
  const first = rows[0]?.subarray(0, channels)
  if (!first) return false
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y]
    if (!row) return false
    for (let x = 0; x < width; x++) {
      for (let channel = 0; channel < channels; channel++) {
        if (row[x * channels + channel] !== first[channel]) return false
      }
    }
  }
  return true
}
