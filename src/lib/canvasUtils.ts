import type { CropApplied, CropAspect, CropHandle, CropRect } from '../types'

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/* ------------------------------------------------------------------ */
/* Aspect ratios                                                       */
/* ------------------------------------------------------------------ */

export function getAspectValue(aspect: CropAspect): number | null {
  switch (aspect) {
    case 'Square':
      return 1
    case 'Mini':
      return 68 / 91
    case 'Wide':
      return 1.234
    default:
      return null
  }
}

/* ------------------------------------------------------------------ */
/* Rotation / fitting                                                  */
/* ------------------------------------------------------------------ */

/** Rotates 90° when the source orientation differs from the target orientation. */
export function rotateIfNeeded(
  source: HTMLCanvasElement,
  targetWidth: number,
  targetHeight: number,
  enabled: boolean,
): HTMLCanvasElement {
  if (!enabled || (source.width >= source.height) === (targetWidth >= targetHeight)) return source

  const rotated = document.createElement('canvas')
  rotated.width = source.height
  rotated.height = source.width
  const context = rotated.getContext('2d')
  if (!context) return source

  context.translate(rotated.width / 2, rotated.height / 2)
  context.rotate(Math.PI / 2)
  context.drawImage(source, -source.width / 2, -source.height / 2)
  return rotated
}

function createWhiteCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  const context = canvas.getContext('2d')
  if (context) {
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
  }
  return { canvas, context }
}

export const DEFAULT_BLUR_RADIUS = 20

/** Photo-opening-sized card:
 *  1) the whole image is resized to the opening and blurred as the background,
 *  2) the sharp, undistorted photo is centered on top of it. */
export function createBlurFillCanvas(
  source: HTMLCanvasElement,
  targetWidth: number,
  targetHeight: number,
  rotateToFit = false,
  blurRadius = DEFAULT_BLUR_RADIUS,
): HTMLCanvasElement {
  const foreground = rotateIfNeeded(source, targetWidth, targetHeight, rotateToFit)
  const { canvas, context } = createWhiteCanvas(targetWidth, targetHeight)
  if (!context) return foreground

  // Background is drawn oversized so the blurred edges do not fade to white.
  const bleed = blurRadius * 2
  context.save()
  if ('filter' in (context as unknown as Record<string, unknown>)) {
    ;(context as unknown as { filter: string }).filter = `blur(${blurRadius}px)`
    context.drawImage(foreground, -bleed, -bleed, canvas.width + bleed * 2, canvas.height + bleed * 2)
  } else {
    // Fallback when canvas blur filters are unsupported: shrink then enlarge.
    const small = document.createElement('canvas')
    small.width = Math.max(1, Math.round(canvas.width / blurRadius))
    small.height = Math.max(1, Math.round(canvas.height / blurRadius))
    const smallContext = small.getContext('2d')
    if (smallContext) {
      smallContext.imageSmoothingQuality = 'high'
      smallContext.drawImage(foreground, 0, 0, small.width, small.height)
      context.drawImage(small, -bleed, -bleed, canvas.width + bleed * 2, canvas.height + bleed * 2)
    }
  }
  context.restore()

  const fitScale = Math.min(canvas.width / foreground.width, canvas.height / foreground.height)
  const fitWidth = foreground.width * fitScale
  const fitHeight = foreground.height * fitScale
  context.drawImage(foreground, (canvas.width - fitWidth) / 2, (canvas.height - fitHeight) / 2, fitWidth, fitHeight)
  return canvas
}

/** Fits a photo into targetWidth x targetHeight WITHOUT distorting it.
 *  'contain' = whole photo visible (white bars where needed).
 *  'cover'   = photo fills the whole opening (edges are trimmed). */
export function createFitCanvas(
  source: HTMLCanvasElement,
  targetWidth: number,
  targetHeight: number,
  rotateToFit = false,
  mode: 'contain' | 'cover' = 'contain',
): HTMLCanvasElement {
  const foreground = rotateIfNeeded(source, targetWidth, targetHeight, rotateToFit)
  const { canvas, context } = createWhiteCanvas(targetWidth, targetHeight)
  if (!context) return foreground

  const pick = mode === 'cover' ? Math.max : Math.min
  const scale = pick(canvas.width / foreground.width, canvas.height / foreground.height)
  const drawWidth = foreground.width * scale
  const drawHeight = foreground.height * scale
  context.drawImage(foreground, (canvas.width - drawWidth) / 2, (canvas.height - drawHeight) / 2, drawWidth, drawHeight)
  return canvas
}

/* ------------------------------------------------------------------ */
/* Cropping                                                            */
/* ------------------------------------------------------------------ */

export function clampCropRectToCanvas(
  rect: CropRect,
  canvasWidth: number,
  canvasHeight: number,
  aspectRatio: number | null = null,
): CropRect {
  const x = clamp(rect.x, 0, Math.max(0, canvasWidth - 8))
  const y = clamp(rect.y, 0, Math.max(0, canvasHeight - 8))
  let width = Math.max(10, rect.width)
  let height = Math.max(10, rect.height)

  if (x + width > canvasWidth) width = Math.max(10, canvasWidth - x)
  if (y + height > canvasHeight) height = Math.max(10, canvasHeight - y)

  if (aspectRatio) {
    if (width / height > aspectRatio) {
      width = height * aspectRatio
    } else {
      height = width / aspectRatio
    }

    if (x + width > canvasWidth) {
      width = Math.max(10, canvasWidth - x)
      height = width / aspectRatio
    }
    if (y + height > canvasHeight) {
      height = Math.max(10, canvasHeight - y)
      width = height * aspectRatio
    }
  }

  return { x, y, width: Math.min(width, canvasWidth - x), height: Math.min(height, canvasHeight - y) }
}

/** Resizes a crop rectangle by dragging one corner; the opposite corner stays fixed. */
export function resizeCropRect(
  handle: CropHandle,
  startRect: CropRect,
  pointerX: number,
  pointerY: number,
  canvasWidth: number,
  canvasHeight: number,
  aspectRatio: number | null,
): CropRect {
  const MIN_SIZE = 10
  const px = clamp(pointerX, 0, canvasWidth)
  const py = clamp(pointerY, 0, canvasHeight)

  const anchor = {
    nw: { x: startRect.x + startRect.width, y: startRect.y + startRect.height },
    ne: { x: startRect.x, y: startRect.y + startRect.height },
    sw: { x: startRect.x + startRect.width, y: startRect.y },
    se: { x: startRect.x, y: startRect.y },
  }[handle]

  const dirX = handle === 'nw' || handle === 'sw' ? -1 : 1
  const dirY = handle === 'nw' || handle === 'ne' ? -1 : 1

  const maxWidth = dirX < 0 ? anchor.x : canvasWidth - anchor.x
  const maxHeight = dirY < 0 ? anchor.y : canvasHeight - anchor.y

  let width = Math.min(maxWidth, Math.max(MIN_SIZE, (px - anchor.x) * dirX))
  let height = Math.min(maxHeight, Math.max(MIN_SIZE, (py - anchor.y) * dirY))

  if (aspectRatio) {
    if (width / height > aspectRatio) {
      width = height * aspectRatio
    } else {
      height = width / aspectRatio
    }
  }

  return {
    x: dirX < 0 ? anchor.x - width : anchor.x,
    y: dirY < 0 ? anchor.y - height : anchor.y,
    width,
    height,
  }
}

export function drawCropOverlay(
  targetCanvas: HTMLCanvasElement,
  sourceCanvas: HTMLCanvasElement,
  rect: CropRect | null,
  enabled: boolean,
  aspect: CropAspect,
) {
  const context = targetCanvas.getContext('2d')
  if (!context) return

  context.clearRect(0, 0, targetCanvas.width, targetCanvas.height)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(sourceCanvas, 0, 0, targetCanvas.width, targetCanvas.height)

  if (!enabled || !rect) return

  const next = clampCropRectToCanvas(rect, targetCanvas.width, targetCanvas.height, getAspectValue(aspect))

  context.strokeStyle = '#67c8ff'
  context.lineWidth = 2
  context.strokeRect(next.x, next.y, next.width, next.height)

  const handleSize = 8
  const corners = [
    { x: next.x, y: next.y },
    { x: next.x + next.width, y: next.y },
    { x: next.x, y: next.y + next.height },
    { x: next.x + next.width, y: next.y + next.height },
  ]

  corners.forEach((corner) => {
    context.fillStyle = '#ffffff'
    context.fillRect(corner.x - handleSize / 2, corner.y - handleSize / 2, handleSize, handleSize)
    context.strokeStyle = '#67c8ff'
    context.lineWidth = 1
    context.strokeRect(corner.x - handleSize / 2, corner.y - handleSize / 2, handleSize, handleSize)
  })
}

export function getCropRectPixels(
  sourceWidth: number,
  sourceHeight: number,
  crop: { x: number; y: number; width: number; height: number; rotation?: number },
) {
  const x = Math.round(clamp(crop.x, 0, 1) * sourceWidth)
  const y = Math.round(clamp(crop.y, 0, 1) * sourceHeight)
  const width = Math.max(1, Math.round(clamp(crop.width, 0, 1) * sourceWidth))
  const height = Math.max(1, Math.round(clamp(crop.height, 0, 1) * sourceHeight))

  const cropX = clamp(x, 0, sourceWidth - 1)
  const cropY = clamp(y, 0, sourceHeight - 1)

  return {
    x: cropX,
    y: cropY,
    width: Math.max(1, Math.min(sourceWidth - cropX, width)),
    height: Math.max(1, Math.min(sourceHeight - cropY, height)),
    rotation: crop.rotation ?? 0,
  }
}

export function createCroppedCanvas(
  sourceCanvas: HTMLCanvasElement,
  crop: { x: number; y: number; width: number; height: number; rotation?: number },
): HTMLCanvasElement {
  const pixelRect = getCropRectPixels(sourceCanvas.width, sourceCanvas.height, crop)
  const cropped = document.createElement('canvas')
  cropped.width = pixelRect.width
  cropped.height = pixelRect.height

  const context = cropped.getContext('2d', { alpha: false })
  if (!context) return sourceCanvas

  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, cropped.width, cropped.height)
  context.imageSmoothingEnabled = true
  context.drawImage(
    sourceCanvas,
    pixelRect.x,
    pixelRect.y,
    pixelRect.width,
    pixelRect.height,
    0,
    0,
    cropped.width,
    cropped.height,
  )

  const rotation = (pixelRect.rotation * Math.PI) / 180
  if (Math.abs(rotation) < 0.0001) return cropped

  const rotated = document.createElement('canvas')
  const sin = Math.abs(Math.sin(rotation))
  const cos = Math.abs(Math.cos(rotation))
  rotated.width = Math.ceil(cropped.width * cos + cropped.height * sin)
  rotated.height = Math.ceil(cropped.width * sin + cropped.height * cos)

  const rotatedContext = rotated.getContext('2d', { alpha: false })
  if (!rotatedContext) return cropped

  rotatedContext.fillStyle = '#ffffff'
  rotatedContext.fillRect(0, 0, rotated.width, rotated.height)
  rotatedContext.translate(rotated.width / 2, rotated.height / 2)
  rotatedContext.rotate(rotation)
  rotatedContext.imageSmoothingEnabled = true
  rotatedContext.drawImage(cropped, -cropped.width / 2, -cropped.height / 2)
  return rotated
}

export type { CropApplied }

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

export const HISTOGRAM_BUCKETS = 32

export function getHistogram(image: HTMLCanvasElement): number[] {
  const context = image.getContext('2d')
  if (!context) return new Array(HISTOGRAM_BUCKETS).fill(0)

  const { data } = context.getImageData(0, 0, image.width, image.height)
  const buckets = new Array(HISTOGRAM_BUCKETS).fill(0)
  // Sample ~8,000 pixels for a sub-millisecond calculation.
  const stride = Math.max(1, Math.floor(data.length / (4 * 8000)))
  const step = stride * 4
  for (let i = 0; i < data.length; i += step) {
    const luminance = clamp(((data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 8) | 0, 0, HISTOGRAM_BUCKETS - 1)
    buckets[luminance] += 1
  }

  const maxValue = Math.max(...buckets, 1)
  return buckets.map((value) => (value / maxValue) * 100)
}

export function normalizeImageUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  if (/^(blob:|data:|https?:)/i.test(normalized)) return normalized
  if (normalized.startsWith('/')) return `file://${normalized}`
  return `file:///${normalized}`
}
