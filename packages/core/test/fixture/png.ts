import { deflateSync } from "node:zlib"

export type Rgba = readonly [number, number, number, number]

export function createPng(
  width: number,
  height: number,
  pixels: ReadonlyArray<Rgba> | Rgba,
) {
  const raw = new Uint8Array(height * (1 + width * 4))
  let offset = 0
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0
    for (let x = 0; x < width; x++) {
      const pixel = Array.isArray(pixels) ? pixels[(y * width + x) % pixels.length]! : pixels
      raw[offset++] = pixel[0]
      raw[offset++] = pixel[1]
      raw[offset++] = pixel[2]
      raw[offset++] = pixel[3]
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr(width, height)),
    chunk("IDAT", deflateSync(Buffer.from(raw))),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

function ihdr(width: number, height: number) {
  const body = Buffer.alloc(13)
  body.writeUInt32BE(width, 0)
  body.writeUInt32BE(height, 4)
  body[8] = 8
  body[9] = 6
  return body
}

function chunk(type: string, data: Buffer) {
  const typeBytes = Buffer.from(type, "ascii")
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0)
  return Buffer.concat([length, typeBytes, data, crc])
}

function crc32(data: Buffer) {
  let crc = ~0
  for (const byte of data) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}
