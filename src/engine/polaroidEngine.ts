export type PresetKey = 'mini' | 'instax-max' | 'polaroid-600'
export type PaperSizeKey = 'A4' | '13x19' | '13x9.5'

export type AdjustmentSettings = {
  exposure: number
  brightness: number
  contrast: number
  levelsBlack: number
  levelsMid: number
  levelsWhite: number
  highlights: number
  shadows: number
  saturation: number
  vibrance: number
  hue: number
  sharpen: number
  noiseReduction: number
  temperature: number
  vignette: number
  fillBlur?: boolean
}

export type AdjustmentOperation = {
  type:
  | 'exposure'
  | 'brightness'
  | 'contrast'
  | 'levelsBlack'
  | 'levelsMid'
  | 'levelsWhite'
  | 'highlights'
  | 'shadows'
  | 'saturation'
  | 'vibrance'
  | 'hue'
  | 'sharpen'
  | 'noiseReduction'
  | 'temperature'
  | 'vignette'
  value: number
}

export type PresetDefinition = {
  key: PresetKey
  label: string
  frameW: number
  frameH: number
  photoW: number
  photoH: number
  offsetX: number
  offsetY: number
}

export const defaultSettings: AdjustmentSettings = {
  exposure: 1,
  brightness: 1.3,
  contrast: 1.1,
  levelsBlack: 0,
  levelsMid: 1,
  levelsWhite: 1,
  highlights: 1,
  shadows: 0,
  saturation: 1.15,
  vibrance: 1,
  hue: 0,
  sharpen: 0,
  noiseReduction: 0,
  temperature: 0,
  vignette: 0,
  fillBlur: false,
}

export const PRESETS: Record<PresetKey, PresetDefinition> = {
  mini: {
    key: 'mini',
    label: 'Mini',
    frameW: 630,
    frameH: 1020,
    photoW: 550,
    photoH: 700,
    offsetX: 40,
    offsetY: 60,
  },
  'instax-max': {
    key: 'instax-max',
    label: 'Instax Max',
    frameW: 1253,
    frameH: 1015,
    photoW: 1170,
    photoH: 732,
    offsetX: 41,
    offsetY: 61,
  },
  'polaroid-600': {
    key: 'polaroid-600',
    label: 'Polaroid 600',
    frameW: 1015,
    frameH: 1251,
    photoW: 920,
    photoH: 920,
    offsetX: 47,
    offsetY: 73,
  },
}

export const PAPER_SIZES: Record<PaperSizeKey, { label: string; width: number; height: number }> = {
  A4: { label: 'A4', width: 2480, height: 3508 },
  '13x19': { label: '13x19', width: 3900, height: 5700 },
  '13x9.5': { label: '13x9.5', width: 3900, height: 2850 },
}

export function buildAdjustmentOperations(settings: AdjustmentSettings): AdjustmentOperation[] {
  const operations: AdjustmentOperation[] = []

  if (settings.exposure !== 1) operations.push({ type: 'exposure', value: settings.exposure })
  if (settings.brightness !== 1) operations.push({ type: 'brightness', value: settings.brightness })
  if (settings.contrast !== 1) operations.push({ type: 'contrast', value: settings.contrast })
  if (settings.levelsBlack !== 0) operations.push({ type: 'levelsBlack', value: settings.levelsBlack })
  if (settings.levelsMid !== 1) operations.push({ type: 'levelsMid', value: settings.levelsMid })
  if (settings.levelsWhite !== 1) operations.push({ type: 'levelsWhite', value: settings.levelsWhite })
  if (settings.highlights !== 1) operations.push({ type: 'highlights', value: settings.highlights })
  if (settings.shadows !== 0) operations.push({ type: 'shadows', value: settings.shadows })
  if (settings.saturation !== 1) operations.push({ type: 'saturation', value: settings.saturation })
  if (settings.vibrance !== 1) operations.push({ type: 'vibrance', value: settings.vibrance })
  if (settings.hue !== 0) operations.push({ type: 'hue', value: settings.hue })
  if (settings.temperature !== 0) operations.push({ type: 'temperature', value: settings.temperature })
  if (settings.sharpen > 0) operations.push({ type: 'sharpen', value: settings.sharpen })
  if (settings.noiseReduction > 0) operations.push({ type: 'noiseReduction', value: settings.noiseReduction })
  if (settings.vignette > 0) operations.push({ type: 'vignette', value: settings.vignette })

  return operations
}

export function fitImageToFrame(
  imageWidth: number,
  imageHeight: number,
  preset: PresetDefinition,
): { scale: number; width: number; height: number; offsetX: number; offsetY: number } {
  const scale = Math.min(preset.photoW / imageWidth, preset.photoH / imageHeight)
  const width = Math.round(imageWidth * scale)
  const height = Math.round(imageHeight * scale)

  return {
    scale,
    width,
    height,
    offsetX: preset.offsetX + (preset.photoW - width) / 2,
    offsetY: preset.offsetY + (preset.photoH - height) / 2,
  }
}

export interface GridOffset {
  offsetX: number
  offsetY: number
}

export function buildSheetLayout(
  preset: PresetDefinition,
  imageCount: number,
  paperSize: PaperSizeKey = 'A4',
  offset: GridOffset = { offsetX: 0, offsetY: 0 },
): {
  cols: number
  rows: number
  sheetW: number
  sheetH: number
  marginX: number
  marginY: number
  markLength: number
} {
  const { width: baseW, height: baseH } = PAPER_SIZES[paperSize]
  const gridPresets: Record<string, [number, number, boolean]> = {
    'A4:mini': [5, 2, true],
    'A4:instax-max': [2, 2, true],
    'A4:polaroid-600': [2, 2, false],
    '13x19:polaroid-600': [5, 3, true],
  }

  const presetKey = `${paperSize}:${preset.key}`
  let cols = Math.max(1, Math.ceil(Math.sqrt(imageCount)))
  let rows = Math.max(1, Math.ceil(imageCount / cols))
  let sheetW = baseW
  let sheetH = baseH

  const presetMatch = gridPresets[presetKey]
  if (presetMatch) {
    const [presetCols, presetRows, forceLandscape] = presetMatch
    cols = presetCols
    rows = presetRows
    if (forceLandscape) {
      sheetW = baseH
      sheetH = baseW
    } else {
      sheetW = baseW
      sheetH = baseH
    }
  } else {
    const colsBySize = Math.max(1, Math.floor(baseW / preset.frameW))
    const rowsBySize = Math.max(1, Math.floor(baseH / preset.frameH))
    const gridW = colsBySize * preset.frameW
    const gridH = rowsBySize * preset.frameH

    if (gridW <= baseW && gridH <= baseH) {
      sheetW = baseW
      sheetH = baseH
      cols = colsBySize
      rows = rowsBySize
    } else {
      sheetW = baseH
      sheetH = baseW
      cols = Math.max(1, Math.floor(sheetW / preset.frameW))
      rows = Math.max(1, Math.floor(sheetH / preset.frameH))
    }
  }

  const gridW = cols * preset.frameW
  const gridH = rows * preset.frameH
  const resolvedSheetW = Math.max(sheetW, gridW + 80)
  const resolvedSheetH = Math.max(sheetH, gridH + 80)
  const markLength = 40

  return {
    cols,
    rows,
    sheetW: resolvedSheetW,
    sheetH: resolvedSheetH,
    marginX: (resolvedSheetW - gridW) / 2 + offset.offsetX,
    marginY: (resolvedSheetH - gridH) / 2 + offset.offsetY,
    markLength,
  }
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

const rgbToHsl = (r: number, g: number, b: number) => {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  let hue = 0
  const lightness = (max + min) / 2
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1))

  if (delta !== 0) {
    if (max === r) hue = ((g - b) / delta) % 6
    else if (max === g) hue = (b - r) / delta + 2
    else hue = (r - g) / delta + 4
    hue *= 60
  }

  if (hue < 0) hue += 360

  return { h: hue, s: saturation, l: lightness }
}

const hslToRgb = (h: number, s: number, l: number) => {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2

  let r = 0
  let g = 0
  let b = 0

  if (h >= 0 && h < 60) [r, g, b] = [c, x, 0]
  else if (h >= 60 && h < 120) [r, g, b] = [x, c, 0]
  else if (h >= 120 && h < 180) [r, g, b] = [0, c, x]
  else if (h >= 180 && h < 240) [r, g, b] = [0, x, c]
  else if (h >= 240 && h < 300) [r, g, b] = [x, 0, c]
  else[r, g, b] = [c, 0, x]

  return { r: r + m, g: g + m, b: b + m }
}

let sharedBuffer: Float32Array | null = null
function getSharedBuffer(size: number): Float32Array {
  if (!sharedBuffer || sharedBuffer.length < size) {
    sharedBuffer = new Float32Array(size)
  }
  return sharedBuffer
}

let sharedConvBuffer: Float32Array | null = null
function getSharedConvBuffer(size: number): Float32Array {
  if (!sharedConvBuffer || sharedConvBuffer.length < size) {
    sharedConvBuffer = new Float32Array(size)
  }
  return sharedConvBuffer
}

function applyProcessingToPixels(source: Uint8ClampedArray, width: number, height: number, settings: AdjustmentSettings) {
  const operations = buildAdjustmentOperations(settings)
  if (operations.length === 0) {
    return
  }

  const gain = settings.exposure * settings.brightness
  const hasGain = gain !== 1
  const contrast = settings.contrast
  const hasContrast = contrast !== 1

  const hasLevels = settings.levelsBlack !== 0 || settings.levelsMid !== 1 || settings.levelsWhite !== 1
  let toneLut: Float32Array | null = null
  if (hasLevels) {
    toneLut = new Float32Array(1025)
    const lower = Math.min(settings.levelsBlack, settings.levelsWhite)
    const upper = Math.max(settings.levelsBlack, settings.levelsWhite)
    const safeRange = Math.max(0.0001, upper - lower)
    const invGamma = 1 / Math.max(0.05, settings.levelsMid)
    for (let i = 0; i <= 1024; i += 1) {
      const normalized = clamp01((i / 1024 - lower) / safeRange)
      toneLut[i] = clamp01(Math.pow(normalized, invGamma))
    }
  }

  const highlightStrength = settings.highlights
  const hasHighlights = highlightStrength !== 1
  const highlightAmount = highlightStrength - 1
  const highlightIntensity = Math.abs(highlightAmount) * 0.9

  const shadowAmount = Math.max(-1, Math.min(1, settings.shadows))
  const hasShadows = shadowAmount !== 0

  const vibranceFactor = 1 + (settings.vibrance - 1) * 0.9
  const saturationFactor = settings.saturation * vibranceFactor
  const hasSat = saturationFactor !== 1

  const hasHue = settings.hue !== 0
  const hueRot = settings.hue * 360

  const hasTemp = settings.temperature !== 0
  const tempAmount = settings.temperature * 0.3
  const tempR = 1 + tempAmount
  const tempB = 1 - tempAmount

  const hasVignette = settings.vignette > 0
  const vignetteStrength = settings.vignette
  const cx = width / 2
  const cy = height / 2
  const maxDistance = Math.hypot(cx, cy)
  const invMaxDist = 1 / Math.max(1, maxDistance)
  const dx2 = new Float32Array(width)
  if (hasVignette) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - cx
      dx2[x] = dx * dx
    }
  }

  const totalChannels = width * height * 4
  const data = getSharedBuffer(totalChannels)
  const inv255 = 1 / 255

  for (let y = 0; y < height; y += 1) {
    const dy = y - cy
    const dy2 = dy * dy
    const rowOffset = y * width * 4
    for (let x = 0; x < width; x += 1) {
      const index = rowOffset + (x << 2)
      let r = source[index] * inv255
      let g = source[index + 1] * inv255
      let b = source[index + 2] * inv255
      data[index + 3] = source[index + 3] * inv255

      if (hasGain) {
        r = clamp01(r * gain)
        g = clamp01(g * gain)
        b = clamp01(b * gain)
      }

      if (hasContrast) {
        // Adjust contrast using luminance, applying the same offset to each
        // channel so contrast does not directly scale RGB color differences.
        const luminance = 0.299 * r + 0.587 * g + 0.114 * b
        const adjustedLuminance = clamp01((luminance - 0.5) * contrast + 0.5)
        const offset = adjustedLuminance - luminance
        r = clamp01(r + offset)
        g = clamp01(g + offset)
        b = clamp01(b + offset)
      }

      if (toneLut) {
        r = toneLut[(r * 1024 + 0.5) | 0]
        g = toneLut[(g * 1024 + 0.5) | 0]
        b = toneLut[(b * 1024 + 0.5) | 0]
      }

      if (hasHighlights) {
        const tone = (r + g + b) * 0.3333333333333333
        const highlightLift = Math.max(0, tone - 0.5) * 2
        const lift = highlightIntensity * highlightLift
        if (highlightAmount > 0) {
          r = clamp01(r + (1 - r) * lift)
          g = clamp01(g + (1 - g) * lift)
          b = clamp01(b + (1 - b) * lift)
        } else {
          r = clamp01(r - r * lift)
          g = clamp01(g - g * lift)
          b = clamp01(b - b * lift)
        }
      }

      if (hasShadows) {
        // Positive values lift dark areas; negative values deepen them.
        // The squared shadow mask keeps midtones and highlights mostly unchanged.
        const luminance = 0.299 * r + 0.587 * g + 0.114 * b
        const shadowMask = (1 - luminance) * (1 - luminance)
        if (shadowAmount > 0) {
          const lift = shadowAmount * 0.5 * shadowMask
          r = clamp01(r + lift)
          g = clamp01(g + lift)
          b = clamp01(b + lift)
        } else {
          const factor = 1 + shadowAmount * 0.8 * shadowMask
          r = clamp01(r * factor)
          g = clamp01(g * factor)
          b = clamp01(b * factor)
        }
      }

      if (hasSat) {
        const luminance = 0.299 * r + 0.587 * g + 0.114 * b
        r = clamp01(luminance + (r - luminance) * saturationFactor)
        g = clamp01(luminance + (g - luminance) * saturationFactor)
        b = clamp01(luminance + (b - luminance) * saturationFactor)
      }

      if (hasHue) {
        const { h, s, l } = rgbToHsl(r, g, b)
        const rotatedHue = (h + hueRot + 360) % 360
        const { r: hr, g: hg, b: hb } = hslToRgb(rotatedHue, s, l)
        r = clamp01(hr)
        g = clamp01(hg)
        b = clamp01(hb)
      }

      if (hasTemp) {
        r = clamp01(r * tempR)
        b = clamp01(b * tempB)
      }

      if (hasVignette) {
        const dist = Math.sqrt(dx2[x] + dy2) * invMaxDist
        const vig = clamp01(1 - dist * vignetteStrength)
        r = clamp01(r * vig)
        g = clamp01(g * vig)
        b = clamp01(b * vig)
      }

      data[index] = r
      data[index + 1] = g
      data[index + 2] = b
    }
  }

  if (settings.noiseReduction > 0) {
    const temp = getSharedConvBuffer(totalChannels)
    temp.set(data.subarray(0, totalChannels))
    const strength = clamp01(settings.noiseReduction / 2)
    const invStrength = 1 - strength
    const invSamples = 1 / 9

    for (let y = 1; y < height - 1; y += 1) {
      const rowOffset = y * width * 4
      for (let x = 1; x < width - 1; x += 1) {
        const index = rowOffset + (x << 2)
        let sumR = 0
        let sumG = 0
        let sumB = 0

        for (let yy = y - 1; yy <= y + 1; yy += 1) {
          const nRow = yy * width * 4
          for (let xx = x - 1; xx <= x + 1; xx += 1) {
            const nIndex = nRow + (xx << 2)
            sumR += temp[nIndex]
            sumG += temp[nIndex + 1]
            sumB += temp[nIndex + 2]
          }
        }

        data[index] = clamp01(temp[index] * invStrength + sumR * invSamples * strength)
        data[index + 1] = clamp01(temp[index + 1] * invStrength + sumG * invSamples * strength)
        data[index + 2] = clamp01(temp[index + 2] * invStrength + sumB * invSamples * strength)
      }
    }
  }

  if (settings.sharpen > 0) {
    const temp = getSharedConvBuffer(totalChannels)
    temp.set(data.subarray(0, totalChannels))
    const amount = settings.sharpen
    const invSamples = 1 / 9

    for (let y = 1; y < height - 1; y += 1) {
      const rowOffset = y * width * 4
      for (let x = 1; x < width - 1; x += 1) {
        const index = rowOffset + (x << 2)
        let sumR = 0
        let sumG = 0
        let sumB = 0

        for (let yy = y - 1; yy <= y + 1; yy += 1) {
          const nRow = yy * width * 4
          for (let xx = x - 1; xx <= x + 1; xx += 1) {
            const nIndex = nRow + (xx << 2)
            sumR += temp[nIndex]
            sumG += temp[nIndex + 1]
            sumB += temp[nIndex + 2]
          }
        }

        const baseR = temp[index]
        const baseG = temp[index + 1]
        const baseB = temp[index + 2]

        data[index] = clamp01(baseR + (baseR - sumR * invSamples) * amount)
        data[index + 1] = clamp01(baseG + (baseG - sumG * invSamples) * amount)
        data[index + 2] = clamp01(baseB + (baseB - sumB * invSamples) * amount)
      }
    }
  }

  for (let index = 0; index < totalChannels; index += 4) {
    source[index] = (data[index] * 255 + 0.5) | 0
    source[index + 1] = (data[index + 1] * 255 + 0.5) | 0
    source[index + 2] = (data[index + 2] * 255 + 0.5) | 0
  }
}

export async function renderProcessedImage(
  image: HTMLImageElement | HTMLCanvasElement,
  settings: AdjustmentSettings,
): Promise<HTMLCanvasElement> {
  const width = 'naturalWidth' in image ? image.naturalWidth : image.width
  const height = 'naturalHeight' in image ? image.naturalHeight : image.height

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Canvas 2D context is not available.')
  }

  context.drawImage(image, 0, 0)

  // Early return if settings are at default values
  if (buildAdjustmentOperations(settings).length === 0) {
    return canvas
  }

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height)
  applyProcessingToPixels(imageData.data, canvas.width, canvas.height, settings)
  context.putImageData(imageData, 0, 0)

  return canvas
}

function rotateCanvas90(source: HTMLCanvasElement, direction: 1 | -1): HTMLCanvasElement {
  const rotated = document.createElement('canvas')
  rotated.width = direction === 1 ? source.height : source.width
  rotated.height = direction === 1 ? source.width : source.height

  const context = rotated.getContext('2d')
  if (!context) {
    return source
  }

  context.translate(rotated.width / 2, rotated.height / 2)
  context.rotate((direction * 90 * Math.PI) / 180)
  context.drawImage(source, -source.width / 2, -source.height / 2)

  return rotated
}

export async function renderPolaroidCard(
  sourceImage: HTMLImageElement | HTMLCanvasElement,
  presetKey: PresetKey,
  settings: AdjustmentSettings,
  autoRotate = false,
): Promise<HTMLCanvasElement> {
  const preset = PRESETS[presetKey]
  const processed = await renderProcessedImage(sourceImage, settings)
  const imageIsLandscape = processed.width >= processed.height
  const cardIsLandscape = preset.frameW >= preset.frameH
  const shouldRotate = autoRotate && imageIsLandscape !== cardIsLandscape

  const rotatedSource = shouldRotate ? rotateCanvas90(processed, imageIsLandscape ? 1 : -1) : processed
  const fit = fitImageToFrame(rotatedSource.width, rotatedSource.height, preset)

  const cardCanvas = document.createElement('canvas')
  cardCanvas.width = preset.frameW
  cardCanvas.height = preset.frameH

  const context = cardCanvas.getContext('2d')
  if (!context) {
    throw new Error('Unable to initialize the Polaroid card canvas.')
  }

  const x = fit.offsetX
  const y = fit.offsetY

  context.clearRect(0, 0, preset.frameW, preset.frameH)

  if (settings.fillBlur) {
    context.save()
    context.filter = 'blur(20px)'
    context.drawImage(rotatedSource, 0, 0, rotatedSource.width, rotatedSource.height, 0, 0, preset.frameW, preset.frameH)
    context.restore()
  }

  if (settings.fillBlur) {
    // Keep the full image visible over the blurred fill so the fill shows
    // through anywhere the source aspect ratio does not match the photo area.
    context.drawImage(rotatedSource, 0, 0, rotatedSource.width, rotatedSource.height, x, y, fit.width, fit.height)
  } else {
    // Preserve the default fill-to-frame crop when blur fill is disabled.
    context.save()
    context.beginPath()
    context.rect(preset.offsetX, preset.offsetY, preset.photoW, preset.photoH)
    context.clip()
    context.drawImage(rotatedSource, 0, 0, rotatedSource.width, rotatedSource.height, preset.offsetX, preset.offsetY, preset.photoW, preset.photoH)
    context.restore()
  }

  return cardCanvas
}

export async function renderSheet(
  sourceImages: (HTMLImageElement | HTMLCanvasElement)[],
  presetKey: PresetKey,
  settings: AdjustmentSettings,
  paperSize: PaperSizeKey = 'A4',
  autoRotate = false,
  offset: GridOffset = { offsetX: 0, offsetY: 0 },
): Promise<HTMLCanvasElement> {
  const preset = PRESETS[presetKey]
  const layout = buildSheetLayout(preset, sourceImages.length || 1, paperSize, offset)
  const sheetCanvas = document.createElement('canvas')
  sheetCanvas.width = Math.round(layout.sheetW)
  sheetCanvas.height = Math.round(layout.sheetH)

  const context = sheetCanvas.getContext('2d')
  if (!context) {
    throw new Error('Unable to initialize the export sheet canvas.')
  }

  context.clearRect(0, 0, sheetCanvas.width, sheetCanvas.height)
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, sheetCanvas.width, sheetCanvas.height)

  const cards = await Promise.all(
    sourceImages.map((image) => renderPolaroidCard(image, presetKey, settings, autoRotate)),
  )

  const usedCols = Math.max(1, Math.ceil(cards.length / layout.rows))
  const usedRows = usedCols > 1 ? layout.rows : Math.max(1, cards.length)

  for (let index = 0; index < cards.length; index += 1) {
    const col = Math.floor(index / layout.rows)
    const row = index % layout.rows
    const x = layout.marginX + col * preset.frameW
    const y = layout.marginY + row * preset.frameH

    context.drawImage(cards[index], x, y)
  }

  const gridW = usedCols * preset.frameW
  const gridH = usedRows * preset.frameH
  context.strokeStyle = '#000000'
  context.lineWidth = 2

  for (let i = 0; i <= usedCols; i += 1) {
    const x = layout.marginX + i * preset.frameW
    context.beginPath()
    context.moveTo(x, layout.marginY - layout.markLength)
    context.lineTo(x, layout.marginY)
    context.moveTo(x, layout.marginY + gridH)
    context.lineTo(x, layout.marginY + gridH + layout.markLength)
    context.stroke()
  }

  for (let i = 0; i <= usedRows; i += 1) {
    const y = layout.marginY + i * preset.frameH
    context.beginPath()
    context.moveTo(layout.marginX - layout.markLength, y)
    context.lineTo(layout.marginX, y)
    context.moveTo(layout.marginX + gridW, y)
    context.lineTo(layout.marginX + gridW + layout.markLength, y)
    context.stroke()
  }

  return sheetCanvas
}
