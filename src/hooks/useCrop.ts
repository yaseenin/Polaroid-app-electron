import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  type SetStateAction,
} from 'react'
import {
  clamp,
  clampCropRectToCanvas,
  createRotatedCanvas,
  drawCropOverlay,
  fitCropRectToAspect,
  getAspectValue,
  resizeCropRect,
} from '../lib/canvasUtils'
import { MAX_PREVIEW_CANVAS } from '../lib/editorConstants'
import type { CropApplied, CropAspect, CropCursor, CropGuide, CropHandle, CropRect, CropStep } from '../types'

type CropDrag = {
  mode: 'new' | 'move' | 'resize'
  handle?: CropHandle
  startX: number
  startY: number
  startRect: CropRect
  startAspectBase?: CropRect
}

type Args = {
  activePhotoId: number | undefined
  previewCanvasRef: RefObject<HTMLCanvasElement | null>
  processedPreviewCanvasRef: RefObject<HTMLCanvasElement | null>
  cropAppliedByPhoto: Record<number, CropApplied | null>
  setCropAppliedByPhoto: Dispatch<SetStateAction<Record<number, CropApplied | null>>>
  customAspectRatio: number
  recordHistory: () => void
  setStatus: (message: string) => void
}

export function useCrop({
  activePhotoId,
  previewCanvasRef,
  processedPreviewCanvasRef,
  cropAppliedByPhoto,
  setCropAppliedByPhoto,
  customAspectRatio,
  recordHistory,
  setStatus,
}: Args) {
  const [cropMode, setCropMode] = useState(false)
  const [cropAspect, setCropAspect] = useState<CropAspect>('Free')
  const [cropRotation, setCropRotation] = useState(0)
  const [cropStraighten, setCropStraighten] = useState(0)
  const [cropGuide, setCropGuide] = useState<CropGuide>('Thirds')
  const [cropCursor, setCropCursor] = useState<CropCursor>('crosshair')
  const [cropRectByPhoto, setCropRectByPhoto] = useState<Record<number, CropRect | null>>({})

  const cropDragRef = useRef<CropDrag | null>(null)
  const cropRectRef = useRef<CropRect | null>(null)
  const cropAspectBaseByPhotoRef = useRef<Record<number, CropRect>>({})
  const cropCanvasSizeByPhotoRef = useRef<Record<number, { width: number; height: number }>>({})

  const cropRect = activePhotoId !== undefined ? cropRectByPhoto[activePhotoId] ?? null : null
  const cropApplied = activePhotoId !== undefined ? cropAppliedByPhoto[activePhotoId] ?? null : null
  cropRectRef.current = cropRect

  const setCropRectFor = useCallback(
    (photoId: number, rect: CropRect | null, aspectBase = rect) => {
      setCropRectByPhoto((current) => ({ ...current, [photoId]: rect }))
      const canvas = previewCanvasRef.current
      if (rect && aspectBase) {
        cropAspectBaseByPhotoRef.current[photoId] = aspectBase
        if (canvas) cropCanvasSizeByPhotoRef.current[photoId] = { width: canvas.width, height: canvas.height }
      } else {
        delete cropAspectBaseByPhotoRef.current[photoId]
        delete cropCanvasSizeByPhotoRef.current[photoId]
      }
    },
    [previewCanvasRef],
  )

  const toggleCropMode = () => {
    if (cropMode) {
      setCropMode(false)
      return
    }

    setCropRotation(0)
    setCropStraighten(0)
    setCropMode(true)
  }

  const changeCropAspect = (aspect: CropAspect) => {
    setCropAspect(aspect)

    const ratio = getAspectValue(aspect, customAspectRatio)
    if (activePhotoId === undefined || !cropRect) return
    const aspectBase = cropAspect === 'Free'
      ? cropRect
      : cropAspectBaseByPhotoRef.current[activePhotoId] ?? cropRect
    const nextRect = aspect === 'Free' ? aspectBase : fitCropRectToAspect(aspectBase, ratio)
    setCropRectFor(activePhotoId, nextRect, aspectBase)
  }

  useEffect(() => {
    if (cropAspect !== 'Custom' || activePhotoId === undefined || !cropRect) return
    const aspectBase = cropAspectBaseByPhotoRef.current[activePhotoId] ?? cropRect
    const nextRect = fitCropRectToAspect(aspectBase, customAspectRatio)
    if (
      Math.abs(nextRect.x - cropRect.x) < 0.5 &&
      Math.abs(nextRect.y - cropRect.y) < 0.5 &&
      Math.abs(nextRect.width - cropRect.width) < 0.5 &&
      Math.abs(nextRect.height - cropRect.height) < 0.5
    ) return
    setCropRectFor(activePhotoId, nextRect, aspectBase)
  }, [activePhotoId, cropAspect, cropRect, customAspectRatio, setCropRectFor])

  const setCropAppliedFor = useCallback(
    (photoId: number, applied: CropApplied | null) =>
      setCropAppliedByPhoto((current) => ({ ...current, [photoId]: applied })),
    [setCropAppliedByPhoto],
  )

  // Show the active photo's saved rotation whenever another photo becomes active.
  useEffect(() => {
    setCropRotation(cropApplied?.rotation ?? 0)
    setCropStraighten(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePhotoId])

  // Redraw only the crop overlay while cropping. (Outside crop mode the preview effect owns the canvas,
  // otherwise the uncropped image would flash onto a cropped canvas.)
  useEffect(() => {
    const canvas = previewCanvasRef.current
    const source = processedPreviewCanvasRef.current
    if (!cropMode || !canvas || !source) return
    const rotatedSource = createRotatedCanvas(source, cropStraighten, true)
    const scale = Math.min(MAX_PREVIEW_CANVAS / rotatedSource.width, MAX_PREVIEW_CANVAS / rotatedSource.height, 1)
    const width = Math.max(1, Math.round(rotatedSource.width * scale))
    const height = Math.max(1, Math.round(rotatedSource.height * scale))
    let displayRect = cropRect

    const previousSize = activePhotoId === undefined
      ? undefined
      : cropCanvasSizeByPhotoRef.current[activePhotoId]
    let scaledBase: CropRect | null = null
    if (
      cropRect &&
      activePhotoId !== undefined &&
      previousSize &&
      (previousSize.width !== width || previousSize.height !== height)
    ) {
      const scaleX = width / previousSize.width
      const scaleY = height / previousSize.height
      const scaleRect = (rect: CropRect): CropRect => ({
        x: rect.x * scaleX,
        y: rect.y * scaleY,
        width: rect.width * scaleX,
        height: rect.height * scaleY,
      })
      scaledBase = scaleRect(cropAspectBaseByPhotoRef.current[activePhotoId] ?? cropRect)
      displayRect = scaleRect(cropRect)
      displayRect = clampCropRectToCanvas(
        displayRect,
        width,
        height,
        getAspectValue(cropAspect, customAspectRatio),
      )
    }

    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    if (activePhotoId !== undefined && displayRect && scaledBase) {
      setCropRectFor(activePhotoId, displayRect, scaledBase)
    } else if (activePhotoId !== undefined) {
      cropCanvasSizeByPhotoRef.current[activePhotoId] = { width, height }
    }
    drawCropOverlay(
      canvas,
      rotatedSource,
      displayRect,
      true,
      cropAspect,
      customAspectRatio,
      cropGuide,
    )
  }, [
    activePhotoId,
    cropMode,
    cropRect,
    cropAspect,
    cropRotation,
    cropStraighten,
    cropGuide,
    customAspectRatio,
    previewCanvasRef,
    processedPreviewCanvasRef,
    setCropRectFor,
  ])

  /* ---- Pointer interaction ---- */
  const getHandleAtPoint = (x: number, y: number): CropHandle | null => {
    if (!cropRect) return null
    const left = Math.min(cropRect.x, cropRect.x + cropRect.width)
    const top = Math.min(cropRect.y, cropRect.y + cropRect.height)
    const right = Math.max(cropRect.x, cropRect.x + cropRect.width)
    const bottom = Math.max(cropRect.y, cropRect.y + cropRect.height)

    const handles: Array<{ key: CropHandle; x: number; y: number }> = [
      { key: 'nw', x: left, y: top },
      { key: 'ne', x: right, y: top },
      { key: 'sw', x: left, y: bottom },
      { key: 'se', x: right, y: bottom },
    ]

    const hitRadius = 14
    return handles.find((h) => Math.abs(x - h.x) <= hitRadius && Math.abs(y - h.y) <= hitRadius)?.key ?? null
  }

  const getCursorAtPoint = (x: number, y: number): CropCursor => {
    if (!cropRect) return 'crosshair'
    const handle = getHandleAtPoint(x, y)
    if (handle === 'nw' || handle === 'se') return 'nwse-resize'
    if (handle === 'ne' || handle === 'sw') return 'nesw-resize'
    if (x >= cropRect.x && x <= cropRect.x + cropRect.width && y >= cropRect.y && y <= cropRect.y + cropRect.height) {
      return 'move'
    }
    return 'crosshair'
  }

  const getCanvasPointerPosition = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const canvas = previewCanvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    }
  }

  const onMouseDown = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!cropMode || !previewCanvasRef.current || activePhotoId === undefined || event.button !== 0) return

    event.preventDefault()
    event.stopPropagation()
    const { x, y } = getCanvasPointerPosition(event)

    if (cropRect) {
      const handle = getHandleAtPoint(x, y)
      if (handle) {
        cropDragRef.current = {
          mode: 'resize',
          handle,
          startX: x,
          startY: y,
          startRect: cropRect,
          startAspectBase: cropAspectBaseByPhotoRef.current[activePhotoId] ?? cropRect,
        }
        return
      }

      if (x >= cropRect.x && x <= cropRect.x + cropRect.width && y >= cropRect.y && y <= cropRect.y + cropRect.height) {
        cropDragRef.current = {
          mode: 'move',
          startX: x,
          startY: y,
          startRect: cropRect,
          startAspectBase: cropAspectBaseByPhotoRef.current[activePhotoId] ?? cropRect,
        }
        return
      }
    }

    const startRect = { x, y, width: 0, height: 0 }
    cropDragRef.current = { mode: 'new', startX: x, startY: y, startRect }
    setCropRectFor(activePhotoId, startRect)
  }

  const onMouseMove = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const canvas = previewCanvasRef.current
    if (!cropMode || !canvas || activePhotoId === undefined) return

    const { x, y } = getCanvasPointerPosition(event)
    const drag = cropDragRef.current
    if (!drag) {
      setCropCursor(getCursorAtPoint(x, y))
      return
    }

    const aspectRatio = getAspectValue(cropAspect, customAspectRatio)
    let nextRect: CropRect
    let aspectBase: CropRect

    if (drag.mode === 'new') {
      aspectBase = clampCropRectToCanvas({
        x: Math.min(drag.startX, x),
        y: Math.min(drag.startY, y),
        width: Math.max(10, Math.abs(x - drag.startX)),
        height: Math.max(10, Math.abs(y - drag.startY)),
      }, canvas.width, canvas.height)
      nextRect = clampCropRectToCanvas(
        aspectBase,
        canvas.width,
        canvas.height,
        aspectRatio,
      )
    } else if (drag.mode === 'move') {
      const width = Math.min(drag.startRect.width, canvas.width)
      const height = Math.min(drag.startRect.height, canvas.height)
      const startAspectBase = drag.startAspectBase ?? drag.startRect
      const baseWidth = Math.min(startAspectBase.width, canvas.width)
      const baseHeight = Math.min(startAspectBase.height, canvas.height)
      aspectBase = {
        x: clamp(startAspectBase.x + (x - drag.startX), 0, canvas.width - baseWidth),
        y: clamp(startAspectBase.y + (y - drag.startY), 0, canvas.height - baseHeight),
        width: baseWidth,
        height: baseHeight,
      }
      nextRect = {
        x: clamp(drag.startRect.x + (x - drag.startX), 0, canvas.width - width),
        y: clamp(drag.startRect.y + (y - drag.startY), 0, canvas.height - height),
        width,
        height,
      }
    } else if (drag.handle) {
      aspectBase = resizeCropRect(drag.handle, drag.startRect, x, y, canvas.width, canvas.height, null)
      nextRect = clampCropRectToCanvas(aspectBase, canvas.width, canvas.height, aspectRatio)
    } else {
      return
    }

    const unchanged =
      cropRect &&
      Math.abs(nextRect.x - cropRect.x) < 0.5 &&
      Math.abs(nextRect.y - cropRect.y) < 0.5 &&
      Math.abs(nextRect.width - cropRect.width) < 0.5 &&
      Math.abs(nextRect.height - cropRect.height) < 0.5

    if (unchanged) {
      setCropCursor(getCursorAtPoint(x, y))
      return
    }

    setCropRectFor(activePhotoId, nextRect, aspectBase)
    setCropCursor(getCursorAtPoint(x, y))
    const source = processedPreviewCanvasRef.current
    if (source) {
      drawCropOverlay(
        canvas,
        createRotatedCanvas(source, cropStraighten, true),
        nextRect,
        true,
        cropAspect,
        customAspectRatio,
        cropGuide,
      )
    }
  }

  const onMouseUp = () => {
    cropDragRef.current = null
    if (activePhotoId !== undefined && cropRect && (cropRect.width < 8 || cropRect.height < 8)) {
      setCropRectFor(activePhotoId, null)
    }
    setCropCursor('crosshair')
  }

  const onMouseLeave = () => {
    setCropCursor('crosshair')
    onMouseUp()
  }

  /* ---- Actions ---- */
  const handleCropRotate = (delta: number) => {
    recordHistory()
    setCropRotation((current) => (current + delta + 360) % 360)
  }

  const handleRotatePhoto = (delta: number) => {
    if (cropMode) {
      handleCropRotate(delta)
      return
    }
    if (activePhotoId === undefined) return
    recordHistory()
    const base: CropApplied = cropApplied ?? { x: 0, y: 0, width: 1, height: 1, rotation: 0 }
    if (base.steps?.length) {
      setCropAppliedFor(activePhotoId, {
        ...base,
        steps: [...base.steps, { x: 0, y: 0, width: 1, height: 1, rotation: delta, expand: true }],
      })
    } else {
      const rotation = ((((base.rotation ?? 0) + delta) % 360) + 360) % 360
      setCropAppliedFor(activePhotoId, { ...base, rotation })
      setCropRotation(rotation)
    }
  }

  const handleCropApply = () => {
    if (activePhotoId === undefined || !cropRect) {
      setStatus('Create a crop selection first.')
      return
    }

    const canvasWidth = previewCanvasRef.current?.width ?? 1
    const canvasHeight = previewCanvasRef.current?.height ?? 1
    recordHistory()
    const base: CropApplied = cropApplied ?? { x: 0, y: 0, width: 1, height: 1, rotation: 0 }
    const steps: CropStep[] = [
      ...(base.steps ?? []),
      {
        x: cropRect.x / canvasWidth,
        y: cropRect.y / canvasHeight,
        width: cropRect.width / canvasWidth,
        height: cropRect.height / canvasHeight,
        rotation: cropStraighten,
        expand: true,
      },
    ]
    if (cropRotation % 360 !== 0) {
      steps.push({ x: 0, y: 0, width: 1, height: 1, rotation: cropRotation, expand: true })
    }
    setCropAppliedFor(activePhotoId, {
      ...base,
      steps,
    })
    setCropRectFor(activePhotoId, null)
    setCropMode(false)
    setStatus('Crop applied to the selected image.')
  }

  const handleCropClear = () => {
    recordHistory()
    if (activePhotoId !== undefined) {
      setCropRectFor(activePhotoId, null)
      setCropAppliedFor(activePhotoId, null)
    }
    setCropMode(false)
    setCropRotation(0)
    setCropStraighten(0)
    setStatus('Crop removed.')
  }

  return {
    cropMode,
    setCropMode,
    toggleCropMode,
    cropAspect,
    setCropAspect: changeCropAspect,
    cropRotation,
    setCropRotation,
    cropStraighten,
    setCropStraighten,
    cropGuide,
    setCropGuide,
    cropCursor,
    cropRect,
    cropRectRef,
    cropApplied,
    cropRectByPhoto,
    setCropRectByPhoto,
    setCropRectFor,
    setCropAppliedFor,
    canvasHandlers: { onMouseDown, onMouseMove, onMouseUp, onMouseLeave },
    handleCropRotate,
    handleRotatePhoto,
    handleCropApply,
    handleCropClear,
  }
}
