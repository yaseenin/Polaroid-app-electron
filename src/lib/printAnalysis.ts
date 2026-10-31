import type { AdjustmentSettings } from '../engine/polaroidEngine'
import { clamp } from './canvasUtils'

/** Prints come out darker and flatter than a screen, so aim a little brighter than "correct". */
const PRINT_TARGET_MEDIAN = 0.52
const PRINT_SHARPEN = 0.3

/**
 * Analyzes a photo and returns adjustment settings tuned for printing.
 * Follows the engine's processing order: gain (exposure * brightness) -> contrast -> levels
 * -> highlights -> shadows -> saturation -> temperature.
 */
export function analyzeForPrint(image: HTMLImageElement, base: AdjustmentSettings): AdjustmentSettings {
  const scale = Math.min(1, 256 / image.naturalWidth, 256 / image.naturalHeight)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Unable to analyze the selected image.')
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data

  const bins = new Array(256).fill(0)
  let count = 0
  let satSum = 0
  let neutralCount = 0
  let nr = 0
  let nb = 0

  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 8) continue
    const r = pixels[i] / 255
    const g = pixels[i + 1] / 255
    const b = pixels[i + 2] / 255
    const lum = 0.299 * r + 0.587 * g + 0.114 * b
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    bins[Math.min(255, Math.round(lum * 255))]++
    count++
    satSum += max > 0.05 ? (max - min) / max : 0
    // White balance only from truly near-gray midtones, so skin or colored scenes aren't "corrected".
    if (lum > 0.12 && lum < 0.88 && max - min < 0.12) {
      nr += r
      nb += b
      neutralCount++
    }
  }
  if (count === 0) throw new Error('The selected image contains no visible pixels.')

  const pct = (p: number) => {
    let sum = 0
    for (let i = 0; i < 256; i++) {
      sum += bins[i]
      if (sum >= p * count) return i / 255
    }
    return 1
  }
  const p1 = pct(0.01)
  const p5 = pct(0.05)
  const p10 = pct(0.1)
  const median = pct(0.5)
  const p95 = pct(0.95)
  const p99 = pct(0.99)

  // 1. Exposure (engine gain = exposure * brightness, so brightness stays 1).
  //    Brighten toward the print target, but never push the top 1% far past white.
  const wanted = PRINT_TARGET_MEDIAN / Math.max(0.08, median)
  const clipLimit = 1.1 / Math.max(0.25, p99)
  const exposure = clamp(Math.min(wanted, clipLimit), 0.85, 1.8)

  // 2. Contrast (engine: luminance around 0.5, applied after gain).
  const spread = (p95 - p5) * exposure
  const contrast = spread < 0.45 ? 1.18 : spread < 0.6 ? 1.1 : spread > 0.9 ? 0.97 : 1.03
  const tone = (v: number) => clamp((v * exposure - 0.5) * contrast + 0.5, 0, 1)

  // 3. Black point (engine applies levels after gain + contrast).
  const levelsBlack = clamp(tone(p1) * 0.8, 0, 0.06)
  const afterLevels = (v: number) => clamp((tone(v) - levelsBlack) / (1 - levelsBlack), 0, 1)

  // 4. Shadows / highlights, judged on the values the engine will actually see.
  const p10After = afterLevels(p10)
  const p95After = afterLevels(p95)
  const p99After = afterLevels(p99)
  const shadows = clamp((0.2 - p10After) * 1.8, 0, 0.45)
  const highlights = p99After > 0.98 ? 0.85 : p95After > 0.9 ? 0.93 : 1

  // 5. Saturation only; the engine's "vibrance" is just another saturation multiplier.
  const meanSat = satSum / count
  const saturation = meanSat < 0.2 ? 1.15 : meanSat < 0.35 ? 1.08 : 1.03

  // 6. White balance: engine does r *= 1 + 0.3t, b *= 1 - 0.3t. Apply 60% of the full correction.
  let temperature = 0
  if (neutralCount > count * 0.03) {
    const r = nr / neutralCount
    const b = nb / neutralCount
    const full = (b - r) / (0.3 * Math.max(0.05, r + b))
    if (Math.abs(full) > 0.03) temperature = clamp(full * 0.6, -0.2, 0.2)
  }

  return {
    ...base,
    exposure,
    brightness: 1,
    contrast,
    levelsBlack,
    levelsMid: 1,
    levelsWhite: 1,
    highlights,
    shadows,
    temperature,
    vibrance: 1,
    saturation,
    hue: 0,
    sharpen: PRINT_SHARPEN,
    noiseReduction: 0,
    vignette: 0,
  }
}
