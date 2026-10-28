import { describe, expect, test } from "bun:test"
import { imageDimensions } from "../src/image/dimensions"

const png = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
    "base64",
  ),
)
const gif = new Uint8Array(
  Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"),
)
const jpeg = new Uint8Array(
  Buffer.from(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
    "base64",
  ),
)
const webpLossy = new Uint8Array(
  Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64"),
)

const webpLossless = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x11, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c, 0x05, 0x00, 0x00,
  0x00, 0x2f, 0x01, 0x80, 0x00, 0x00,
])

const webpExtended = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58, 0x0a, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x2b, 0x01, 0x00, 0xc7, 0x00, 0x00,
])

const zeroJpeg = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x00, 0x00, 0x00, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03,
  0x11, 0x01,
])

function mutate(source: Uint8Array, offset: number, values: number[]) {
  const bytes = new Uint8Array(source)
  bytes.set(values, offset)
  return bytes
}

describe("imageDimensions", () => {
  test("reads PNG, GIF, JPEG and WebP headers", () => {
    expect(imageDimensions(png)).toEqual({ mime: "image/png", width: 1, height: 1 })
    expect(imageDimensions(gif)).toEqual({ mime: "image/gif", width: 1, height: 1 })
    expect(imageDimensions(jpeg)).toEqual({ mime: "image/jpeg", width: 1, height: 1 })
    expect(imageDimensions(webpLossy)).toEqual({ mime: "image/webp", width: 1, height: 1 })
  })

  test("reads WebP lossless and extended headers", () => {
    expect(imageDimensions(webpLossless)).toEqual({ mime: "image/webp", width: 2, height: 3 })
    expect(imageDimensions(webpExtended)).toEqual({ mime: "image/webp", width: 300, height: 200 })
  })

  test("rejects unknown magic bytes and empty input", () => {
    expect(imageDimensions(new Uint8Array())).toBeUndefined()
    expect(imageDimensions(new Uint8Array([0x42, 0x4d, 0x01, 0x02, 0x03, 0x04]))).toBeUndefined()
    expect(imageDimensions(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]))).toBeUndefined()
    expect(imageDimensions(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).toBeUndefined()
  })

  test("rejects truncated headers", () => {
    expect(imageDimensions(png.subarray(0, 20))).toBeUndefined()
    expect(imageDimensions(gif.subarray(0, 9))).toBeUndefined()
    expect(imageDimensions(jpeg.subarray(0, 20))).toBeUndefined()
    expect(imageDimensions(webpLossy.subarray(0, 22))).toBeUndefined()
    expect(imageDimensions(webpLossless.subarray(0, 24))).toBeUndefined()
    expect(imageDimensions(webpExtended.subarray(0, 29))).toBeUndefined()
  })

  test("rejects zero dimensions", () => {
    expect(imageDimensions(mutate(png, 16, [0, 0, 0, 0]))).toBeUndefined()
    expect(imageDimensions(mutate(png, 20, [0, 0, 0, 0]))).toBeUndefined()
    expect(imageDimensions(mutate(gif, 6, [0, 0]))).toBeUndefined()
    expect(imageDimensions(mutate(gif, 8, [0, 0]))).toBeUndefined()
    expect(imageDimensions(zeroJpeg)).toBeUndefined()
    expect(imageDimensions(mutate(webpLossy, 26, [0, 0]))).toBeUndefined()
    expect(imageDimensions(mutate(webpLossy, 28, [0, 0]))).toBeUndefined()
  })
})
