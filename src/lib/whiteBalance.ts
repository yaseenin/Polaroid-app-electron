import { clamp } from './canvasUtils'

export const WHITE_BALANCE_PRESETS = [
  { id: 'as-shot', label: 'As Shot', temperature: 0, tint: 0 },
  { id: 'auto', label: 'Auto' },
  { id: 'daylight', label: 'Daylight', temperature: 0, tint: 0 },
  { id: 'cloudy', label: 'Cloudy', temperature: 0.14, tint: 0 },
  { id: 'shade', label: 'Shade', temperature: 0.24, tint: 0 },
  { id: 'tungsten', label: 'Tungsten', temperature: -0.34, tint: 0 },
] as const

export type WhiteBalancePreset = (typeof WHITE_BALANCE_PRESETS)[number]['id']
export type WhiteBalanceValues = { temperature: number; tint: number }

function estimateWhiteBalance(red: number, green: number, blue: number, strength: number): WhiteBalanceValues {
  const rawTemperature = (blue - red) / (0.3 * Math.max(0.05, red + blue))
  const temperature = clamp(rawTemperature * strength, -0.65, 0.65)
  const correctedRed = red * (1 + temperature * 0.3)
  const correctedBlue = blue * (1 - temperature * 0.3)
  const redBlueAverage = (correctedRed + correctedBlue) / 2
  const rawTint = (green - redBlueAverage) / (0.2 * Math.max(0.05, green + redBlueAverage))
  const tint = clamp(rawTint * strength, -0.65, 0.65)

  return {
    temperature: Math.abs(temperature) < 0.01 ? 0 : temperature,
    tint: Math.abs(tint) < 0.01 ? 0 : tint,
  }
}

export function analyzeWhiteBalanceSample(red: number, green: number, blue: number): WhiteBalanceValues {
  const r = red / 255
  const g = green / 255
  const b = blue / 255
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b
  if (luminance < 0.08 || luminance > 0.92) {
    throw new Error('Choose a midtone gray or white area, avoiding highlights and deep shadows.')
  }
  return estimateWhiteBalance(r, g, b, 0.8)
}

export function combineWhiteBalance(
  current: WhiteBalanceValues,
  correction: WhiteBalanceValues,
): WhiteBalanceValues {
  const currentTintGain = 1 - current.tint * 0.2
  const correctionTintGain = 1 - correction.tint * 0.2
  const combinedTintGain = currentTintGain * correctionTintGain
  const tint = clamp((1 - combinedTintGain) / 0.2, -1, 1)

  const currentRedGain = (1 + current.temperature * 0.3) * (1 + current.tint * 0.2)
  const currentBlueGain = (1 - current.temperature * 0.3) * (1 + current.tint * 0.2)
  const correctionRedGain = (1 + correction.temperature * 0.3) * (1 + correction.tint * 0.2)
  const correctionBlueGain = (1 - correction.temperature * 0.3) * (1 + correction.tint * 0.2)
  const tintRedBlueGain = 1 + tint * 0.2
  const redTemperatureGain = currentRedGain * correctionRedGain / tintRedBlueGain
  const blueTemperatureGain = currentBlueGain * correctionBlueGain / tintRedBlueGain
  const temperature = clamp((redTemperatureGain - blueTemperatureGain) / 0.6, -1, 1)

  return { temperature, tint }
}

export function analyzeWhiteBalance(image: HTMLImageElement): { temperature: number; tint: number } {
  const scale = Math.min(1, 320 / image.naturalWidth, 320 / image.naturalHeight)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Unable to analyze the selected image for white balance.')
  context.drawImage(image, 0, 0, canvas.width, canvas.height)

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
  let midtoneCount = 0
  let neutralWeight = 0
  let neutralRed = 0
  let neutralGreen = 0
  let neutralBlue = 0
  let allRed = 0
  let allGreen = 0
  let allBlue = 0

  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 8) continue
    const red = pixels[i] / 255
    const green = pixels[i + 1] / 255
    const blue = pixels[i + 2] / 255
    const luminance = 0.299 * red + 0.587 * green + 0.114 * blue
    if (luminance < 0.08 || luminance > 0.92) continue

    midtoneCount += 1
    allRed += red
    allGreen += green
    allBlue += blue

    const chroma = Math.max(red, green, blue) - Math.min(red, green, blue)
    const weight = Math.max(0, 1 - chroma / 0.25)
    neutralWeight += weight
    neutralRed += red * weight
    neutralGreen += green * weight
    neutralBlue += blue * weight
  }

  if (midtoneCount === 0) throw new Error('No usable midtones were found for white-balance analysis.')

  const useNeutralSamples = neutralWeight >= midtoneCount * 0.02
  const red = useNeutralSamples ? neutralRed / neutralWeight : allRed / midtoneCount
  const green = useNeutralSamples ? neutralGreen / neutralWeight : allGreen / midtoneCount
  const blue = useNeutralSamples ? neutralBlue / neutralWeight : allBlue / midtoneCount

  return estimateWhiteBalance(red, green, blue, 0.65)
}
