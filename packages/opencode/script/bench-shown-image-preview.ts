import { Effect } from "effect"
import { make } from "@opencode-ai/core/image/photon"

const LIMITS = { autoResize: true, maxWidth: 2_000, maxHeight: 2_000, maxBase64Bytes: 5 * 1024 * 1024 }
const RUNS = 9

/**
 * M12a baseline for the cost of asking `normalize` for a browser preview alongside the full frame. Both runtimes run the
 * same bounded algorithm (`packages/core/src/image/photon.ts` and the twin in `src/image/image.ts` share the constants),
 * so one measurement covers both. The delta between the columns is the preview; the base column is the cost the tool
 * already paid before M12.
 */
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0

const screenshot = (photon: Awaited<typeof import("@silvia-odwyer/photon-node")>, width: number, height: number) => {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4
      const band = Math.floor(y / 48) % 2 === 0 ? 246 : 236
      // Block-quantized jitter keeps the PNG the size of a real screenshot; a flat gradient compresses to nothing and
      // would measure the skip path instead of the preview path.
      const blockX = x >> 3
      const blockY = y >> 3
      const jitter = ((blockX * 7 + blockY * 13 + blockX * blockY) % 41) - 20
      rgba[offset] = band - Math.floor((x / width) * 12) + jitter
      rgba[offset + 1] = band - Math.floor((y / height) * 18) + jitter
      rgba[offset + 2] = band + 4 + jitter
      rgba[offset + 3] = 255
    }
  }
  const image = new photon.PhotonImage(rgba, width, height)
  const png = Buffer.from(image.get_bytes())
  image.free()
  return png
}

const measure = async (preview: boolean, png: Buffer) => {
  const content = {
    uri: "file:///shot.png",
    content: png.toString("base64"),
    mime: "image/png",
    encoding: "base64" as const,
  }
  const normalize = await Effect.runPromise(make)
  const timings: number[] = []
  let bytes = 0
  let previewBytes = 0
  for (let run = 0; run <= RUNS; run++) {
    const started = performance.now()
    const result = await Effect.runPromise(normalize("shot.png", content, { ...LIMITS, preview }))
    if (run > 0) timings.push(performance.now() - started)
    bytes = Buffer.byteLength(result.content, "utf-8")
    previewBytes = "preview" in result && result.preview ? result.preview.bytes : 0
  }
  return { base: median(timings), fullBytes: bytes, previewBytes }
}

const photon = await import("@silvia-odwyer/photon-node")

for (const [width, height] of [
  [1_280, 720],
  [2_880, 1_800],
]) {
  const png = screenshot(photon, width, height)
  const without = await measure(false, png)
  const withPreview = await measure(true, png)
  console.log(
    `${width}x${height} source=${png.length}B`,
    `normalize ${without.base.toFixed(1)}ms`,
    `+preview ${withPreview.base.toFixed(1)}ms`,
    `delta ${(withPreview.base - without.base).toFixed(1)}ms`,
    `full=${without.fullBytes}B`,
    `preview=${withPreview.previewBytes}B`,
  )
}
