import { useEffect, useRef, useState } from 'react'
import './App.css'
import {
  PAPER_SIZES,
  PRESETS,
  buildAdjustmentOperations,
  defaultSettings,
  renderProcessedImage,
  renderSheet,
  type AdjustmentSettings,
  type PaperSizeKey,
  type PresetKey,
} from './engine/polaroidEngine'

type Photo = {
  id: number
  name: string
  url: string
  path: string
}

type NativeImagePickerResult = {
  canceled: boolean
  filePaths: string[]
  dataUrls?: string[]
}

type SliderProps = {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
}

function SliderControl({ label, value, min, max, step, onChange }: SliderProps) {
  return (
    <div className="slider-row">
      <div className="slider-label-row">
        <label>{label}</label>
        <span>{value.toFixed(step < 1 ? 2 : 0)}</span>
      </div>
      <input
        title={`Adjust ${label}`}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  )
}

function App() {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [preset, setPreset] = useState<PresetKey>('mini')
  const [paperSize, setPaperSize] = useState<PaperSizeKey>('A4')
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState(0)
  const [exportFormat, setExportFormat] = useState<'png' | 'jpeg' | 'pdf'>('png')
  const [exportPageCount, setExportPageCount] = useState(1)
  const [exportOrientation, setExportOrientation] = useState<'portrait' | 'landscape'>('portrait')
  const [exportAutoRotate, setExportAutoRotate] = useState(true)
  const [exportBlurBackground, setExportBlurBackground] = useState(true)
  const [exportBlurStrength, setExportBlurStrength] = useState(14)
  const [settings, setSettings] = useState<AdjustmentSettings>(defaultSettings)
  const [status, setStatus] = useState('Ready for processing')
  const [processing, setProcessing] = useState(false)
  const [lastOutputDir, setLastOutputDir] = useState<string | null>(null)
  type CropHandle = 'nw' | 'ne' | 'sw' | 'se'

  const [showExportDialog, setShowExportDialog] = useState(false)
  const [cropMode, setCropMode] = useState(false)
  const [cropAspect, setCropAspect] = useState<'Free' | 'Square' | 'Mini' | 'Wide'>('Free')
  const [cropRotation, setCropRotation] = useState(0)
  const [cropRect, setCropRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const [cropApplied, setCropApplied] = useState<{ x: number; y: number; width: number; height: number; rotation: number } | null>(null)
  const [cropRectByPhoto, setCropRectByPhoto] = useState<Record<number, { x: number; y: number; width: number; height: number } | null>>({})
  const [cropAppliedByPhoto, setCropAppliedByPhoto] = useState<Record<number, { x: number; y: number; width: number; height: number; rotation: number } | null>>({})
  const [cropCursor, setCropCursor] = useState<'crosshair' | 'move' | 'nwse-resize' | 'nesw-resize'>('crosshair')
  const [histogram, setHistogram] = useState<number[]>(new Array(32).fill(0))
  const fileInputRef = useRef<HTMLInputElement>(null)
  const previewCanvasRef = useRef<HTMLCanvasElement>(null)
  const exportPreviewCanvasRef = useRef<HTMLCanvasElement>(null)
  const processedPreviewCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const cropStartRef = useRef<{ x: number; y: number } | null>(null)
  const cropDragRef = useRef<{ mode: 'new' | 'move' | 'resize'; handle?: CropHandle; startX: number; startY: number; startRect: { x: number; y: number; width: number; height: number } } | null>(null)

  const updateSetting = <K extends keyof AdjustmentSettings>(key: K, value: AdjustmentSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }))
  }

  const getAspectValue = (aspect: 'Free' | 'Square' | 'Mini' | 'Wide') => {
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

  const clampCropRectToCanvas = (
    rect: { x: number; y: number; width: number; height: number },
    canvasWidth: number,
    canvasHeight: number,
    aspectRatio: number | null = null,
  ) => {
    let x = Math.min(Math.max(rect.x, 0), Math.max(0, canvasWidth - 8))
    let y = Math.min(Math.max(rect.y, 0), Math.max(0, canvasHeight - 8))
    let width = Math.max(10, rect.width)
    let height = Math.max(10, rect.height)

    if (x + width > canvasWidth) {
      width = Math.max(10, canvasWidth - x)
    }
    if (y + height > canvasHeight) {
      height = Math.max(10, canvasHeight - y)
    }

    if (aspectRatio) {
      const targetWidth = Math.max(10, width)
      const targetHeight = Math.max(10, height)
      const currentRatio = targetWidth / targetHeight

      if (currentRatio > aspectRatio) {
        width = targetHeight * aspectRatio
      } else {
        height = targetWidth / aspectRatio
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

  const drawCropOverlay = (
    targetCanvas: HTMLCanvasElement,
    sourceCanvas: HTMLCanvasElement,
    rect: { x: number; y: number; width: number; height: number } | null,
    enabled: boolean,
    aspect: 'Free' | 'Square' | 'Mini' | 'Wide',
  ) => {
    const context = targetCanvas.getContext('2d')
    if (!context) {
      return
    }

    context.clearRect(0, 0, targetCanvas.width, targetCanvas.height)
    context.drawImage(sourceCanvas, 0, 0, targetCanvas.width, targetCanvas.height)

    if (!enabled || !rect) {
      return
    }

    const nextRect = clampCropRectToCanvas(rect, targetCanvas.width, targetCanvas.height, getAspectValue(aspect))

    context.strokeStyle = '#67c8ff'
    context.lineWidth = 2
    context.strokeRect(nextRect.x, nextRect.y, nextRect.width, nextRect.height)

    const handleSize = 8
    const handles = [
      { x: nextRect.x, y: nextRect.y },
      { x: nextRect.x + nextRect.width, y: nextRect.y },
      { x: nextRect.x, y: nextRect.y + nextRect.height },
      { x: nextRect.x + nextRect.width, y: nextRect.y + nextRect.height },
    ]

    handles.forEach((handle) => {
      context.fillStyle = '#ffffff'
      context.fillRect(handle.x - handleSize / 2, handle.y - handleSize / 2, handleSize, handleSize)
      context.strokeStyle = '#67c8ff'
      context.lineWidth = 1
      context.strokeRect(handle.x - handleSize / 2, handle.y - handleSize / 2, handleSize, handleSize)
    })
  }

  const getHistogram = (image: HTMLCanvasElement) => {
    const context = image.getContext('2d')
    if (!context) {
      return new Array(32).fill(0)
    }

    const imageData = context.getImageData(0, 0, image.width, image.height)
    const buckets = new Array(32).fill(0)
    for (let i = 0; i < imageData.data.length; i += 4) {
      const luminance = Math.round((imageData.data[i] * 0.299 + imageData.data[i + 1] * 0.587 + imageData.data[i + 2] * 0.114) / 8)
      const bucket = Math.min(31, Math.max(0, luminance))
      buckets[bucket] += 1
    }

    const maxValue = Math.max(...buckets, 1)
    return buckets.map((value) => (value / maxValue) * 100)
  }

  const activePhoto = photos[selectedPhotoIndex] ?? photos[0]

  const syncSelectedCropState = (nextRect: { x: number; y: number; width: number; height: number } | null, nextApplied: { x: number; y: number; width: number; height: number; rotation: number } | null) => {
    if (!activePhoto) {
      setCropRect(nextRect)
      setCropApplied(nextApplied)
      return
    }

    setCropRectByPhoto((current) => ({ ...current, [activePhoto.id]: nextRect }))
    setCropAppliedByPhoto((current) => ({ ...current, [activePhoto.id]: nextApplied }))
    setCropRect(nextRect)
    setCropApplied(nextApplied)
  }

  useEffect(() => {
    if (!activePhoto) {
      setCropRect(null)
      setCropApplied(null)
      return
    }

    const nextRect = cropRectByPhoto[activePhoto.id] ?? null
    const nextApplied = cropAppliedByPhoto[activePhoto.id] ?? null
    setCropRect(nextRect)
    setCropApplied(nextApplied)
  }, [activePhoto, cropRectByPhoto, cropAppliedByPhoto])

  const handleAddPhotos = () => {
    fileInputRef.current?.click()
  }

  const appendFiles = (files: File[]) => {
    const nextPhotos = files.map((file) => ({
      id: Date.now() + Math.random(),
      name: file.name,
      url: URL.createObjectURL(file),
      path: (file as File & { path?: string }).path ?? file.name,
    }))

    if (nextPhotos.length === 0) {
      return
    }

    setPhotos((current) => {
      const next = [...current, ...nextPhotos]
      setSelectedPhotoIndex(Math.max(0, next.length - 1))
      return next
    })
    setStatus(`${nextPhotos.length} photo(s) loaded into the pipeline`)
  }

  const handleFilesSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    appendFiles(files)
    event.target.value = ''
  }

  const normalizeImageUrl = (filePath: string) => {
    const normalized = filePath.replace(/\\/g, '/')

    if (/^(blob:|data:|https?:)/i.test(normalized)) {
      return normalized
    }

    if (/^\//.test(normalized)) {
      return `file://${normalized}`
    }

    if (/^[A-Za-z]:\//.test(normalized)) {
      return `file:///${normalized}`
    }

    return `file:///${normalized}`
  }

  const handleOpenNativeDialog = async () => {
    if (!window.polaroidEngine?.openImagePicker) {
      fileInputRef.current?.click()
      return
    }

    const result = (await window.polaroidEngine.openImagePicker()) as NativeImagePickerResult
    if (!result || result.canceled || !Array.isArray(result.filePaths)) {
      return
    }

    const nextPhotos = result.filePaths.map((filePath: string, index: number) => ({
      id: Date.now() + Math.random() + index,
      name: filePath.split(/[\\/]/).pop() ?? 'photo',
      url: result.dataUrls?.[index] ?? normalizeImageUrl(filePath),
      path: filePath,
    }))

    setPhotos((current) => {
      const next = [...current, ...nextPhotos]
      setSelectedPhotoIndex(Math.max(0, next.length - 1))
      return next
    })
    setStatus(`${nextPhotos.length} photo(s) loaded from the native dialog`)
  }

  useEffect(() => {
    if (!photos.length) {
      setSelectedPhotoIndex(0)
      return
    }

    setSelectedPhotoIndex((current) => Math.min(current, photos.length - 1))
  }, [photos.length])

  const loadImageResource = (src: string) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image()
      image.crossOrigin = 'anonymous'
      image.decoding = 'async'
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error(`Unable to load image: ${src}`))
      image.src = src
    })

  const getCropRectPixels = (
    sourceWidth: number,
    sourceHeight: number,
    crop: { x: number; y: number; width: number; height: number; rotation?: number },
  ) => {
    const x = Math.round(Math.min(Math.max(crop.x, 0), 1) * sourceWidth)
    const y = Math.round(Math.min(Math.max(crop.y, 0), 1) * sourceHeight)
    const width = Math.max(1, Math.round(Math.min(Math.max(crop.width, 0), 1) * sourceWidth))
    const height = Math.max(1, Math.round(Math.min(Math.max(crop.height, 0), 1) * sourceHeight))

    const cropX = Math.min(sourceWidth - 1, Math.max(0, x))
    const cropY = Math.min(sourceHeight - 1, Math.max(0, y))
    const cropWidth = Math.min(sourceWidth - cropX, width)
    const cropHeight = Math.min(sourceHeight - cropY, height)

    return {
      x: cropX,
      y: cropY,
      width: Math.max(1, cropWidth),
      height: Math.max(1, cropHeight),
      rotation: crop.rotation ?? 0,
    }
  }

  const createCroppedCanvas = (
    sourceCanvas: HTMLCanvasElement,
    crop: { x: number; y: number; width: number; height: number; rotation?: number },
  ) => {
    const pixelRect = getCropRectPixels(sourceCanvas.width, sourceCanvas.height, crop)
    const croppedCanvas = document.createElement('canvas')
    croppedCanvas.width = pixelRect.width
    croppedCanvas.height = pixelRect.height

    const context = croppedCanvas.getContext('2d')
    if (!context) {
      return sourceCanvas
    }

    context.drawImage(
      sourceCanvas,
      pixelRect.x,
      pixelRect.y,
      pixelRect.width,
      pixelRect.height,
      0,
      0,
      croppedCanvas.width,
      croppedCanvas.height,
    )

    const rotation = ((pixelRect.rotation ?? 0) * Math.PI) / 180
    if (Math.abs(rotation) < 0.0001) {
      return croppedCanvas
    }

    const rotatedCanvas = document.createElement('canvas')
    const baseWidth = croppedCanvas.width
    const baseHeight = croppedCanvas.height
    rotatedCanvas.width = Math.ceil(baseWidth * Math.abs(Math.cos(rotation)) + baseHeight * Math.abs(Math.sin(rotation)))
    rotatedCanvas.height = Math.ceil(baseWidth * Math.abs(Math.sin(rotation)) + baseHeight * Math.abs(Math.cos(rotation)))

    const rotatedContext = rotatedCanvas.getContext('2d')
    if (!rotatedContext) {
      return croppedCanvas
    }

    rotatedContext.translate(rotatedCanvas.width / 2, rotatedCanvas.height / 2)
    rotatedContext.rotate(rotation)
    rotatedContext.drawImage(croppedCanvas, -baseWidth / 2, -baseHeight / 2)
    return rotatedCanvas
  }

  const drawCroppedPreview = (
    context: CanvasRenderingContext2D,
    image: HTMLCanvasElement,
    targetWidth: number,
    targetHeight: number,
  ) => {
    const scale = Math.min(targetWidth / image.width, targetHeight / image.height)
    const drawWidth = image.width * scale
    const drawHeight = image.height * scale
    const offsetX = (targetWidth - drawWidth) / 2
    const offsetY = (targetHeight - drawHeight) / 2
    context.clearRect(0, 0, targetWidth, targetHeight)
    context.drawImage(image, offsetX, offsetY, drawWidth, drawHeight)
  }

  useEffect(() => {
    const canvas = previewCanvasRef.current
    if (!canvas) return

    if (!photos.length) {
      canvas.width = 720
      canvas.height = 420
      const context = canvas.getContext('2d')
      if (!context) return
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.fillStyle = '#e7e7e7'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.fillStyle = '#7a7a7a'
      context.font = '300 22px Arial'
      context.textAlign = 'center'
      context.fillText('No photo loaded yet', canvas.width / 2, canvas.height / 2)
      return
    }

    const activePhoto = photos[selectedPhotoIndex] ?? photos[0]
    let cancelled = false

    loadImageResource(activePhoto.url)
      .then(async (image) => {
        if (cancelled) return

        const processed = await renderProcessedImage(image, settings)
        const canvas = previewCanvasRef.current
        if (!canvas) return

        const maxWidth = 980
        const maxHeight = 520
        const scale = Math.min(maxWidth / processed.width, maxHeight / processed.height, 1)
        canvas.width = Math.max(1, Math.round(processed.width * scale))
        canvas.height = Math.max(1, Math.round(processed.height * scale))
        const context = canvas.getContext('2d')
        if (!context) return

        processedPreviewCanvasRef.current = processed

        const activeCropApplied = activePhoto ? cropAppliedByPhoto[activePhoto.id] ?? cropApplied : cropApplied
        const displayCanvas = activeCropApplied ? createCroppedCanvas(processed, activeCropApplied) : processed

        if (displayCanvas !== processed) {
          drawCroppedPreview(context, displayCanvas, canvas.width, canvas.height)
        } else {
          context.clearRect(0, 0, canvas.width, canvas.height)
          context.drawImage(processed, 0, 0, processed.width, processed.height, 0, 0, canvas.width, canvas.height)
        }

        if (cropMode && cropRect) {
          drawCropOverlay(canvas, processed, cropRect, true, cropAspect)
        }

        setHistogram(getHistogram(displayCanvas))
      })
      .catch((error) => {
        if (!cancelled) {
          setStatus(error instanceof Error ? error.message : 'Unable to render the selected photo.')
        }
      })

    return () => { cancelled = true }
  }, [photos, preset, cropApplied, cropAspect, cropRotation, settings, selectedPhotoIndex])

  useEffect(() => {
    const canvas = previewCanvasRef.current
    const sourceCanvas = processedPreviewCanvasRef.current
    if (!canvas || !sourceCanvas) {
      return
    }

    drawCropOverlay(canvas, sourceCanvas, cropRect, cropMode, cropAspect)
  }, [cropMode, cropRect, cropAspect])

  const getCropHandleAtPoint = (x: number, y: number): CropHandle | null => {
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
    const found = handles.find((handle) => Math.abs(x - handle.x) <= hitRadius && Math.abs(y - handle.y) <= hitRadius)
    return found?.key ?? null
  }

  const getCropCursorAtPoint = (x: number, y: number) => {
    if (!cropRect) {
      return 'crosshair'
    }

    const handle = getCropHandleAtPoint(x, y)
    if (handle === 'nw' || handle === 'se') {
      return 'nwse-resize'
    }
    if (handle === 'ne' || handle === 'sw') {
      return 'nesw-resize'
    }
    if (x >= cropRect.x && x <= cropRect.x + cropRect.width && y >= cropRect.y && y <= cropRect.y + cropRect.height) {
      return 'move'
    }

    return 'crosshair'
  }

  const getCanvasPointerPosition = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = previewCanvasRef.current
    if (!canvas) {
      return { x: 0, y: 0 }
    }

    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height

    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
    }
  }

  const handleCropPointerDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!cropMode || !previewCanvasRef.current || photos.length === 0) {
      return
    }

    if (event.button !== 0) {
      return
    }

    event.preventDefault()
    event.stopPropagation()

    const { x, y } = getCanvasPointerPosition(event)

    if (cropRect) {
      const activeHandle = getCropHandleAtPoint(x, y)
      if (activeHandle) {
        cropDragRef.current = {
          mode: 'resize',
          handle: activeHandle,
          startX: x,
          startY: y,
          startRect: cropRect,
        }
        return
      }

      const left = Math.min(cropRect.x, cropRect.x + cropRect.width)
      const top = Math.min(cropRect.y, cropRect.y + cropRect.height)
      const right = Math.max(cropRect.x, cropRect.x + cropRect.width)
      const bottom = Math.max(cropRect.y, cropRect.y + cropRect.height)

      if (x >= left && x <= right && y >= top && y <= bottom) {
        cropDragRef.current = {
          mode: 'move',
          startX: x,
          startY: y,
          startRect: cropRect,
        }
        return
      }
    }

    cropStartRef.current = { x, y }
    cropDragRef.current = {
      mode: 'new',
      startX: x,
      startY: y,
      startRect: { x, y, width: 0, height: 0 },
    }
    const nextRect = { x, y, width: 0, height: 0 }
    setCropRect(nextRect)
    if (activePhoto) {
      setCropRectByPhoto((current) => ({ ...current, [activePhoto.id]: nextRect }))
    }
  }

  const handleCropPointerMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!cropMode || !previewCanvasRef.current) {
      return
    }

    const { x, y } = getCanvasPointerPosition(event)

    if (!cropDragRef.current) {
      setCropCursor(getCropCursorAtPoint(x, y))
      return
    }

    const drag = cropDragRef.current
    const canvasWidth = previewCanvasRef.current.width
    const canvasHeight = previewCanvasRef.current.height
    const aspectRatio = getAspectValue(cropAspect)

    let nextRect: { x: number; y: number; width: number; height: number }

    if (drag.mode === 'new') {
      const left = Math.min(drag.startX, x)
      const top = Math.min(drag.startY, y)
      const width = Math.max(10, Math.abs(x - drag.startX))
      const height = Math.max(10, Math.abs(y - drag.startY))
      nextRect = clampCropRectToCanvas({ x: left, y: top, width, height }, canvasWidth, canvasHeight, aspectRatio)
    } else if (drag.mode === 'move') {
      const dx = x - drag.startX
      const dy = y - drag.startY
      nextRect = clampCropRectToCanvas(
        {
          x: drag.startRect.x + dx,
          y: drag.startRect.y + dy,
          width: drag.startRect.width,
          height: drag.startRect.height,
        },
        canvasWidth,
        canvasHeight,
      )
    } else if (drag.mode === 'resize' && drag.handle) {
      const startRect = drag.startRect
      const MIN_SIZE = 10
      const anchor = {
        nw: { x: startRect.x + startRect.width, y: startRect.y + startRect.height },
        ne: { x: startRect.x, y: startRect.y + startRect.height },
        sw: { x: startRect.x + startRect.width, y: startRect.y },
        se: { x: startRect.x, y: startRect.y },
      }[drag.handle]

      let left = anchor.x
      let top = anchor.y
      let right = anchor.x
      let bottom = anchor.y

      if (drag.handle === 'nw') {
        left = Math.min(x, anchor.x - MIN_SIZE)
        top = Math.min(y, anchor.y - MIN_SIZE)
        right = anchor.x
        bottom = anchor.y
      } else if (drag.handle === 'ne') {
        right = Math.max(x, anchor.x + MIN_SIZE)
        top = Math.min(y, anchor.y - MIN_SIZE)
        left = anchor.x
        bottom = anchor.y
      } else if (drag.handle === 'sw') {
        left = Math.min(x, anchor.x - MIN_SIZE)
        bottom = Math.max(y, anchor.y + MIN_SIZE)
        right = anchor.x
        top = anchor.y
      } else if (drag.handle === 'se') {
        right = Math.max(x, anchor.x + MIN_SIZE)
        bottom = Math.max(y, anchor.y + MIN_SIZE)
        left = anchor.x
        top = anchor.y
      }

      let width = Math.abs(right - left)
      let height = Math.abs(bottom - top)

      if (width < MIN_SIZE) {
        width = MIN_SIZE
      }
      if (height < MIN_SIZE) {
        height = MIN_SIZE
      }

      if (aspectRatio) {
        if (drag.handle === 'nw' || drag.handle === 'se') {
          if (drag.handle === 'nw') {
            const adjustedWidth = height * aspectRatio
            width = Math.min(width, adjustedWidth)
            height = width / aspectRatio
            left = Math.min(anchor.x - width, anchor.x - MIN_SIZE)
            top = anchor.y - height
          } else {
            const adjustedWidth = height * aspectRatio
            width = Math.min(width, adjustedWidth)
            height = width / aspectRatio
            right = anchor.x + width
            bottom = anchor.y + height
          }
        } else {
          if (drag.handle === 'ne') {
            const adjustedHeight = width / aspectRatio
            height = Math.min(height, adjustedHeight)
            width = height * aspectRatio
            right = anchor.x + width
            top = anchor.y - height
          } else {
            const adjustedHeight = width / aspectRatio
            height = Math.min(height, adjustedHeight)
            width = height * aspectRatio
            left = anchor.x - width
            bottom = anchor.y + height
          }
        }
      }

      if (drag.handle === 'nw') {
        nextRect = {
          x: left,
          y: top,
          width: anchor.x - left,
          height: anchor.y - top,
        }
      } else if (drag.handle === 'ne') {
        nextRect = {
          x: anchor.x,
          y: top,
          width: right - anchor.x,
          height: anchor.y - top,
        }
      } else if (drag.handle === 'sw') {
        nextRect = {
          x: left,
          y: anchor.y,
          width: anchor.x - left,
          height: bottom - anchor.y,
        }
      } else {
        nextRect = {
          x: anchor.x,
          y: anchor.y,
          width: right - anchor.x,
          height: bottom - anchor.y,
        }
      }

      nextRect = clampCropRectToCanvas(nextRect, canvasWidth, canvasHeight, aspectRatio)
    } else {
      return
    }

    setCropRect(nextRect)
    if (activePhoto) {
      setCropRectByPhoto((current) => ({ ...current, [activePhoto.id]: nextRect }))
    }
    setCropCursor(getCropCursorAtPoint(x, y))
    const canvas = previewCanvasRef.current
    const sourceCanvas = processedPreviewCanvasRef.current
    if (canvas && sourceCanvas) {
      drawCropOverlay(canvas, sourceCanvas, nextRect, true, cropAspect)
    }
  }

  const handleCropPointerUp = () => {
    cropDragRef.current = null
    cropStartRef.current = null
    if (cropRect && (cropRect.width < 8 || cropRect.height < 8)) {
      setCropRect(null)
      if (activePhoto) {
        setCropRectByPhoto((current) => ({ ...current, [activePhoto.id]: null }))
      }
    }
    setCropCursor('crosshair')
  }

  const handleCropRotate = (delta: number) => {
    setCropRotation((current) => (current + delta + 360) % 360)
  }

  const handleCropApply = () => {
    if (!cropRect) {
      setStatus('Create a crop selection first.')
      return
    }

    const canvasWidth = previewCanvasRef.current?.width ?? 1
    const canvasHeight = previewCanvasRef.current?.height ?? 1
    const nextApplied = {
      x: cropRect.x / canvasWidth,
      y: cropRect.y / canvasHeight,
      width: cropRect.width / canvasWidth,
      height: cropRect.height / canvasHeight,
      rotation: cropRotation,
    }
    setCropApplied(nextApplied)
    syncSelectedCropState(null, nextApplied)
    setCropMode(false)
    setCropRect(null)
    setStatus('Crop applied to the selected image.')
  }

  const handleCropClear = () => {
    setCropApplied(null)
    setCropRect(null)
    if (activePhoto) {
      setCropRectByPhoto((current) => ({ ...current, [activePhoto.id]: null }))
      setCropAppliedByPhoto((current) => ({ ...current, [activePhoto.id]: null }))
    }
    setCropMode(false)
    setCropRotation(0)
    setStatus('Crop removed.')
  }

  const handleProcessWithRust = async () => {
    if (photos.length === 0) {
      setStatus('Select at least one photo before processing.')
      return
    }

    setProcessing(true)
    setStatus('Sending files to the Rust image engine…')

    try {
      if (!window.polaroidEngine?.processImages) {
        setStatus('Rust bridge unavailable in this environment; using preview-only mode.')
        return
      }

      const result = await window.polaroidEngine.processImages({
        files: photos.map((photo) => photo.path),
        settings: {
          exposure: settings.exposure,
          contrast: settings.contrast,
          gamma: 1,
          sharpen: settings.sharpen,
          autoRotate: true,
          format: 'jpeg',
          dpi: 300,
        },
      })

      if (!result?.ok) {
        throw new Error(result?.error ?? 'Rust processing failed.')
      }

      setLastOutputDir(result.outputDir ?? null)
      setStatus(result.message ?? 'Rust processing completed successfully.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown processing error.'
      setStatus(message)
    } finally {
      setProcessing(false)
    }
  }

  const handleExportSheet = async () => {
    if (photos.length === 0) {
      setStatus('Select at least one photo before exporting.')
      return
    }

    try {
      const images = await Promise.all(
        photos.map(async (photo, index) => {
          try {
            const image = await loadImageResource(photo.url)
            const processed = await renderProcessedImage(image, settings)
            const photoCropApplied = cropAppliedByPhoto[photo.id] ?? null

            if (index === selectedPhotoIndex && photoCropApplied) {
              const cropped = createCroppedCanvas(processed, photoCropApplied)
              const nextImage = new Image()
              nextImage.src = cropped.toDataURL('image/png')
              await new Promise<void>((resolve, reject) => {
                nextImage.onload = () => resolve()
                nextImage.onerror = () => reject(new Error(`Unable to render cropped image: ${photo.name}`))
              })
              return nextImage
            }

            return image
          } catch {
            throw new Error(`Unable to load ${photo.name}`)
          }
        }),
      )

      const sheet = await renderSheet(images, preset, settings, paperSize, exportAutoRotate)
      const mimeType = exportFormat === 'jpeg' ? 'image/jpeg' : 'image/png'
      const dataUrl = sheet.toDataURL(mimeType)
      const fileName = `${PRESETS[preset].label.toLowerCase().replace(/\s+/g, '-')}-sheet.${exportFormat === 'pdf' ? 'pdf' : exportFormat}`

      const saveResult = await window.polaroidEngine?.saveExport?.({
        dataUrl,
        format: exportFormat,
        defaultName: fileName,
      })

      if (saveResult && (!saveResult.canceled && saveResult.ok)) {
        setLastOutputDir(saveResult.filePath ?? null)
        setStatus(`Exported ${images.length} image(s) to ${saveResult.filePath ?? 'a printable sheet'}.`)
        return
      }

      if (saveResult && saveResult.canceled) {
        setStatus('Export cancelled.')
        return
      }

      const anchor = document.createElement('a')
      anchor.href = dataUrl
      anchor.download = fileName
      anchor.click()
      setLastOutputDir('browser-download')
      setStatus(`Browser export created: ${fileName}`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Export failed.')
    }
  }

  const openExportDialog = () => {
    if (photos.length === 0) {
      setStatus('Select at least one photo before exporting.')
      return
    }

    setShowExportDialog(true)
  }

  const finalizeExport = async () => {
    setShowExportDialog(false)
    await handleExportSheet()
  }

  useEffect(() => {
    const canvas = exportPreviewCanvasRef.current
    if (!canvas || !showExportDialog || photos.length === 0) {
      return
    }

    let cancelled = false

    const renderPreview = async () => {
      try {
        const images = await Promise.all(
          photos.map(async (photo, index) => {
            try {
              const image = await loadImageResource(photo.url)
              const processed = await renderProcessedImage(image, settings)
              const photoCropApplied = cropAppliedByPhoto[photo.id] ?? null

              if (index === selectedPhotoIndex && photoCropApplied) {
                const cropped = createCroppedCanvas(processed, photoCropApplied)
                const nextImage = new Image()
                nextImage.src = cropped.toDataURL('image/png')
                await new Promise<void>((resolve, reject) => {
                  nextImage.onload = () => resolve()
                  nextImage.onerror = () => reject(new Error(`Unable to build preview crop for ${photo.name}`))
                })
                return nextImage
              }

              return image
            } catch {
              return null
            }
          }),
        )

        const validImages = images.filter(Boolean) as HTMLImageElement[]
        if (!validImages.length || cancelled) {
          return
        }

        const sheet = await renderSheet(validImages, preset, settings, paperSize, exportAutoRotate)
        const previewWidth = exportOrientation === 'landscape' ? Math.max(sheet.width, 640) : Math.max(sheet.width, 420)
        const previewHeight = exportOrientation === 'landscape' ? Math.max(sheet.height, 360) : Math.max(sheet.height, 520)

        canvas.width = previewWidth
        canvas.height = previewHeight
        const context = canvas.getContext('2d')
        if (!context || cancelled) {
          return
        }

        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, canvas.width, canvas.height)

        const baseX = (canvas.width - sheet.width) / 2
        const baseY = (canvas.height - sheet.height) / 2

        if (exportBlurBackground) {
          const blurCanvas = document.createElement('canvas')
          blurCanvas.width = canvas.width
          blurCanvas.height = canvas.height
          const blurCtx = blurCanvas.getContext('2d')
          if (blurCtx) {
            blurCtx.filter = `blur(${exportBlurStrength}px)`
            blurCtx.fillStyle = '#111827'
            blurCtx.fillRect(0, 0, blurCanvas.width, blurCanvas.height)
            blurCtx.drawImage(sheet, baseX, baseY)
            blurCtx.filter = 'none'
            context.drawImage(blurCanvas, 0, 0)
          }
        }

        context.fillStyle = '#ffffff'
        context.fillRect(baseX - 18, baseY - 18, sheet.width + 36, sheet.height + 36)
        context.drawImage(sheet, baseX, baseY)

        context.fillStyle = '#e6f3ff'
        context.font = '600 18px Arial'
        context.textAlign = 'left'
        context.fillText(`Pages: ${exportPageCount}`, 16, 28)
        context.fillText(`Orientation: ${exportOrientation}`, 16, 52)
        context.fillText(`Auto rotate: ${exportAutoRotate ? 'On' : 'Off'}`, 16, 76)
      } catch {
        if (!cancelled) {
          setStatus('Unable to build the export preview.')
        }
      }
    }

    renderPreview()
    return () => { cancelled = true }
  }, [exportBlurBackground, exportBlurStrength, exportOrientation, exportPageCount, exportAutoRotate, paperSize, photos, preset, settings, showExportDialog])

  const operationSummary = buildAdjustmentOperations(settings)
  const stageLabel = activePhoto
    ? `${photos.length} photo${photos.length === 1 ? '' : 's'} | ${activePhoto.name}`
    : 'No photos loaded yet'

  return (
    <div className="app dark">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        hidden
        onChange={handleFilesSelected}
      />

      <div className="window-shell">
        <div className="menu-bar">
          <button title="Open images" onClick={handleOpenNativeDialog}>Open</button>
          <button title="Clear current selection" onClick={() => {
            setPhotos([])
            setLastOutputDir(null)
            setStatus('Ready for processing')
          }}>New</button>
          <button title="Export print sheet" onClick={openExportDialog}>Export</button>
          <button title="Run Rust process" onClick={handleProcessWithRust}>Process</button>
        </div>

        <div className="workspace-shell">
          <aside className="tool-rail">
            <button title="Select" className={`tool-button ${!cropMode ? 'active' : ''}`} aria-label="Select" onClick={() => { setCropMode(false); setCropRect(null) }}>◉</button>
            <button title="Crop" className={`tool-button ${cropMode ? 'active' : ''}`} aria-label="Crop" onClick={() => setCropMode((current) => !current)}>◧</button>
            <button title="Refresh" className="tool-button" aria-label="Refresh">⟳</button>
            <button title="Undo" className="tool-button" aria-label="Undo">↶</button>
            <button title="Redo" className="tool-button" aria-label="Redo">↷</button>
          </aside>

          <main className="main-stage">
            <div className="stage-toolbar">
              <div className="stage-label">{stageLabel}</div>
              <div className="stage-actions">
                <button title="Previous photo" onClick={() => setSelectedPhotoIndex((current) => Math.max(0, current - 1))}>−</button>
                <button title="Next photo" onClick={() => setSelectedPhotoIndex((current) => Math.min(photos.length - 1, current + 1))}>+</button>
                <button title="Add photos" onClick={handleAddPhotos}>⤢</button>
              </div>
            </div>

            <div
              className="canvas-panel"
              onDragOver={(event) => {
                event.preventDefault()
              }}
              onDrop={(event) => {
                event.preventDefault()
                const files = Array.from(event.dataTransfer?.files ?? [])
                appendFiles(files)
              }}
            >
              <canvas
                ref={previewCanvasRef}
                className={`preview-canvas ${cropMode ? 'crop-enabled' : ''}`}
                style={{ cursor: cropMode ? cropCursor : 'default' }}
                onMouseDown={handleCropPointerDown}
                onMouseMove={handleCropPointerMove}
                onMouseUp={handleCropPointerUp}
                onMouseLeave={() => {
                  setCropCursor('crosshair')
                  handleCropPointerUp()
                }}
              />
            </div>

            <div className="thumbnail-strip">
              {photos.length === 0 ? (
                <button title="Add more photos" className="thumb empty-thumb" onClick={handleAddPhotos}>+ Add</button>
              ) : (
                photos.map((photo, index) => (
                  <button
                    key={photo.id}
                    className={`thumb-card ${selectedPhotoIndex === index ? 'selected' : ''}`}
                    type="button"
                    title={`Select ${photo.name}`}
                    onClick={() => setSelectedPhotoIndex(index)}
                  >
                    <img src={photo.url} alt={photo.name} />
                  </button>
                ))
              )}
            </div>
          </main>

          <aside className="adjustments-panel">
            <div className="panel-header-block">
              <h3>Adjustments</h3>
              <div className="meta-row">
                <span>{operationSummary.length} active</span>
              </div>
              <div className="histogram" aria-label="Histogram">
                {histogram.map((value, index) => (
                  <span key={index} className="histogram-bar" style={{ height: `${Math.max(8, value)}%` }} />
                ))}
              </div>
            </div>

            <div className="preset-buttons">
              <button title="Auto adjust" className="ghost-button active">Auto</button>
              {cropRect ? (
                <button title="Apply crop" className="ghost-button" onClick={handleCropApply}>Apply Crop</button>
              ) : null}
              {cropRect || cropApplied ? (
                <button title="Clear crop" className="ghost-button" onClick={handleCropClear}>Clear</button>
              ) : null}
            </div>

            <div className="crop-panel-block">
              <label>Aspect ratio</label>
              <div className="crop-aspect-list">
                {(['Free', 'Square', 'Mini', 'Wide'] as const).map((aspect) => (
                  <button
                    key={aspect}
                    type="button"
                    className={`crop-chip ${cropAspect === aspect ? 'active' : ''}`}
                    onClick={() => setCropAspect(aspect)}
                    title={`Set ${aspect} crop ratio`}
                  >
                    {aspect}
                  </button>
                ))}
              </div>
              <div className="crop-rotate-row">
                <button type="button" title="Rotate left" className="ghost-button" onClick={() => handleCropRotate(-90)}>↺</button>
                <button type="button" title="Rotate right" className="ghost-button" onClick={() => handleCropRotate(90)}>↻</button>
                <span>{cropRotation}°</span>
              </div>
            </div>

            <div className="template-row">
              <label>Layout</label>
              <select title="Choose print layout" value={preset} onChange={(event) => setPreset(event.target.value as PresetKey)}>
                {Object.values(PRESETS).map((item) => (
                  <option key={item.key} value={item.key}>{item.label}</option>
                ))}
              </select>
            </div>

            <div className="template-row">
              <label>Paper Size</label>
              <select title="Choose paper size" value={paperSize} onChange={(event) => setPaperSize(event.target.value as PaperSizeKey)}>
                {Object.entries(PAPER_SIZES).map(([key, item]) => (
                  <option key={key} value={key}>{item.label}</option>
                ))}
              </select>
            </div>

            <div className="template-row">
              <label>Export format</label>
              <select title="Choose export format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as 'png' | 'jpeg' | 'pdf')}>
                <option value="png">PNG</option>
                <option value="jpeg">JPEG</option>
                <option value="pdf">PDF</option>
              </select>
            </div>

            <div className="action-row">
              <button title="Run Rust processing" className="action-button" onClick={handleProcessWithRust} disabled={processing || photos.length === 0}>
                {processing ? 'Processing…' : 'Rust Process'}
              </button>
              <button title="Open export sheet dialog" className="action-button" onClick={openExportDialog}>Export Sheet</button>
            </div>

            <div className="status-box">
              <span>Status</span>
              <strong>{status}</strong>
              {lastOutputDir ? <small>{lastOutputDir}</small> : null}
            </div>

            <div className="slider-stack">
              <SliderControl label="Exposure" value={settings.exposure} min={0.5} max={2} step={0.01} onChange={(value) => updateSetting('exposure', value)} />
              <SliderControl label="Brightness" value={settings.brightness} min={0.5} max={2} step={0.01} onChange={(value) => updateSetting('brightness', value)} />
              <SliderControl label="Contrast" value={settings.contrast} min={0.5} max={2} step={0.01} onChange={(value) => updateSetting('contrast', value)} />
              <SliderControl label="Levels Black" value={0} min={0} max={1} step={0.01} onChange={() => undefined} />
              <SliderControl label="Levels Mid" value={1.3} min={0.2} max={3} step={0.01} onChange={() => undefined} />
              <SliderControl label="Levels White" value={1} min={0} max={2} step={0.01} onChange={() => undefined} />
              <SliderControl label="Highlights" value={1} min={0} max={2} step={0.01} onChange={() => undefined} />
              <SliderControl label="Shadows" value={0} min={0} max={2} step={0.01} onChange={() => undefined} />
              <SliderControl label="Temperature" value={settings.temperature} min={-1} max={1} step={0.01} onChange={(value) => updateSetting('temperature', value)} />
              <SliderControl label="Vibrance" value={1} min={0} max={2} step={0.01} onChange={() => undefined} />
              <SliderControl label="Saturation" value={settings.saturation} min={0} max={2} step={0.01} onChange={(value) => updateSetting('saturation', value)} />
              <SliderControl label="Hue" value={0} min={-1} max={1} step={0.01} onChange={() => undefined} />
              <SliderControl label="Sharpness" value={settings.sharpen} min={0} max={2.5} step={0.01} onChange={(value) => updateSetting('sharpen', value)} />
              <SliderControl label="Noise Reduction" value={0} min={0} max={1} step={0.01} onChange={() => undefined} />
              <SliderControl label="Vignette" value={settings.vignette} min={0} max={1} step={0.01} onChange={(value) => updateSetting('vignette', value)} />
            </div>
          </aside>
        </div>
      </div>

      {showExportDialog ? (
        <div className="export-dialog-backdrop" onClick={() => setShowExportDialog(false)}>
          <div className="export-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="export-dialog-header">
              <div>
                <h3>Export preview</h3>
                <p>Print layout, pages, orientation, and sizing</p>
              </div>
              <button type="button" title="Close export dialog" className="close-dialog" onClick={() => setShowExportDialog(false)}>×</button>
            </div>

            <div className="export-dialog-body">
              <div className="export-controls">
                <div className="template-row compact">
                  <label>Layout</label>
                  <select title="Choose print layout" value={preset} onChange={(event) => setPreset(event.target.value as PresetKey)}>
                    {Object.values(PRESETS).map((item) => (
                      <option key={item.key} value={item.key}>{item.label}</option>
                    ))}
                  </select>
                </div>

                <div className="template-row compact">
                  <label>Paper size</label>
                  <select title="Choose paper size" value={paperSize} onChange={(event) => setPaperSize(event.target.value as PaperSizeKey)}>
                    {Object.entries(PAPER_SIZES).map(([key, item]) => (
                      <option key={key} value={key}>{item.label}</option>
                    ))}
                  </select>
                </div>

                <div className="template-row compact">
                  <label>Orientation</label>
                  <select title="Choose export orientation" value={exportOrientation} onChange={(event) => setExportOrientation(event.target.value as 'portrait' | 'landscape')}>
                    <option value="portrait">Portrait</option>
                    <option value="landscape">Landscape</option>
                  </select>
                </div>

                <div className="template-row compact">
                  <label>Pages</label>
                  <input title="Number of pages" type="number" min={1} max={10} value={exportPageCount} onChange={(event) => setExportPageCount(Math.min(10, Math.max(1, Number(event.target.value) || 1)))} />
                </div>

                <div className="toggle-row">
                  <label>Auto rotation</label>
                  <input title="Auto rotate images" type="checkbox" checked={exportAutoRotate} onChange={(event) => setExportAutoRotate(event.target.checked)} />
                </div>

                <div className="toggle-row">
                  <label>Blur background to frame</label>
                  <input title="Blur background to frame" type="checkbox" checked={exportBlurBackground} onChange={(event) => setExportBlurBackground(event.target.checked)} />
                </div>

                <div className="template-row compact">
                  <label>Blur strength</label>
                  <input title="Blur strength" type="range" min={0} max={30} step={1} value={exportBlurStrength} onChange={(event) => setExportBlurStrength(Number(event.target.value))} />
                </div>

                <div className="template-row compact">
                  <label>Export format</label>
                  <select title="Choose export format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as 'png' | 'jpeg' | 'pdf')}>
                    <option value="png">PNG</option>
                    <option value="jpeg">JPEG</option>
                    <option value="pdf">PDF</option>
                  </select>
                </div>
              </div>

              <div className="export-preview-panel">
                <canvas ref={exportPreviewCanvasRef} className="export-preview-canvas" />
              </div>
            </div>

            <div className="export-dialog-actions">
              <button type="button" title="Cancel export" className="ghost-button" onClick={() => setShowExportDialog(false)}>Cancel</button>
              <button type="button" title="Save export" className="action-button" onClick={finalizeExport}>Save export</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default App