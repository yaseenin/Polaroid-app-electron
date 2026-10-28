import { useCallback, useEffect, useRef, useState } from 'react'

import './App.css'

import {
  PRESETS,
  buildAdjustmentOperations,
  buildSheetLayout,
  defaultSettings,
  renderProcessedImage,
  renderSheet,
  type AdjustmentSettings,
  type PaperSizeKey,
  type PresetKey,
} from './engine/polaroidEngine'

import { ExportDialog } from './components/ExportDialog'

import { SliderControl } from './components/SliderControl'

import {
  HISTOGRAM_BUCKETS,
  clamp,
  clampCropRectToCanvas,
  createBlurFillCanvas,
  createCroppedCanvas,
  createFitCanvas,
  drawCropOverlay,
  getAspectValue,
  getHistogram,
  normalizeImageUrl,
  resizeCropRect,
} from './lib/canvasUtils'

import type {
  BuildCard,
  CropApplied,
  CropAspect,
  CropCursor,
  CropHandle,
  CropRect,
  EditorSnapshot,
  ExportFormat,
  ExportOrientation,
  NativeImagePickerResult,
  Photo,
  SavedProject,
} from './types'

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Explicit neutral values: no adjustment at all. New photos start here, and "Reset" returns here.
 *  Use this (not `defaultSettings`) anywhere a "no adjustment" fallback is needed: `defaultSettings`
 *  carries brightness 1.3 / contrast 1.1 / saturation 1.15 and would silently brighten the photo. */
const NEUTRAL_SETTINGS: AdjustmentSettings = {
  ...defaultSettings,
  exposure: 1,
  brightness: 1,
  contrast: 1,
  levelsBlack: 0,
  levelsMid: 1,
  levelsWhite: 1,
  highlights: 1,
  shadows: 0,
  temperature: 0,
  vibrance: 1,
  saturation: 1,
  hue: 0,
  sharpen: 0,
  noiseReduction: 0,
  vignette: 0,
  fillBlur: false,
}

/** Prints come out darker and flatter than a screen, so aim a little brighter than "correct". */
const PRINT_TARGET_MEDIAN = 0.52
const PRINT_SHARPEN = 0.3

/**
 * Analyzes a photo and returns adjustment settings tuned for printing.
 * Follows the engine's processing order: gain (exposure * brightness) -> contrast -> levels
 * -> highlights -> shadows -> saturation -> temperature.
 */
function analyzeForPrint(image: HTMLImageElement, base: AdjustmentSettings): AdjustmentSettings {
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

type SliderKey =
  | 'exposure'
  | 'brightness'
  | 'contrast'
  | 'levelsBlack'
  | 'levelsMid'
  | 'levelsWhite'
  | 'highlights'
  | 'shadows'
  | 'temperature'
  | 'vibrance'
  | 'saturation'
  | 'hue'
  | 'sharpen'
  | 'noiseReduction'
  | 'vignette'

const SLIDERS: Array<{ key: SliderKey; label: string; min: number; max: number }> = [
  { key: 'exposure', label: 'Exposure', min: 0.5, max: 2 },
  { key: 'brightness', label: 'Brightness', min: 0.5, max: 2 },
  { key: 'contrast', label: 'Contrast', min: 0.5, max: 2 },
  { key: 'levelsBlack', label: 'Levels Black', min: 0, max: 1 },
  { key: 'levelsMid', label: 'Levels Mid', min: 0.2, max: 3 },
  { key: 'levelsWhite', label: 'Levels White', min: 0, max: 2 },
  { key: 'highlights', label: 'Highlights', min: 0, max: 2 },
  { key: 'shadows', label: 'Shadows', min: -1, max: 1 },
  { key: 'temperature', label: 'Temperature', min: -1, max: 1 },
  { key: 'vibrance', label: 'Vibrance', min: 0, max: 2 },
  { key: 'saturation', label: 'Saturation', min: 0, max: 2 },
  { key: 'hue', label: 'Hue', min: -1, max: 1 },
  { key: 'sharpen', label: 'Sharpness', min: 0, max: 2.5 },
  { key: 'noiseReduction', label: 'Noise Reduction', min: 0, max: 1 },
  { key: 'vignette', label: 'Vignette', min: 0, max: 1 },
]

const CROP_ASPECTS: CropAspect[] = ['Free', 'Square', 'Mini', 'Wide']

const MAX_PREVIEW_DIM = 1200

const MIN_ZOOM = 0.25

const MAX_ZOOM = 3

const EMPTY_HISTOGRAM = new Array(HISTOGRAM_BUCKETS).fill(0)

type CropDrag = {
  mode: 'new' | 'move' | 'resize'
  handle?: CropHandle
  startX: number
  startY: number
  startRect: CropRect
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

function App() {
  /* ---- Library / project state ---- */
  const [photos, setPhotos] = useState<Photo[]>([])
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState(0)
  const [settingsByPhoto, setSettingsByPhoto] = useState<Record<number, AdjustmentSettings>>({})
  const [cropAppliedByPhoto, setCropAppliedByPhoto] = useState<Record<number, CropApplied | null>>({})
  const [cropRectByPhoto, setCropRectByPhoto] = useState<Record<number, CropRect | null>>({})
  const [adjustmentClipboard, setAdjustmentClipboard] = useState<{
    settings: AdjustmentSettings
    cropApplied: CropApplied | null
  } | null>(null)

  /* ---- Import behavior ---- */
  const [applyAutoCorrectionOnImport, setApplyAutoCorrectionOnImport] = useState(false)

  /* ---- Export state ---- */
  const [preset, setPreset] = useState<PresetKey>('mini')
  const [paperSize, setPaperSize] = useState<PaperSizeKey>('13x19')
  const [exportFormat, setExportFormat] = useState<ExportFormat>('pdf')
  // NOTE: page count and orientation are stored in projects and shown in the preview,
  // but the sheet engine (buildSheetLayout / renderSheet) does not take them yet.
  const [exportPageCount, setExportPageCount] = useState(1)
  const [exportOrientation, setExportOrientation] = useState<ExportOrientation>('portrait')
  const [exportAutoRotate, setExportAutoRotate] = useState(true)
  const [fillBlur, setFillBlur] = useState(false)
  const [exportGridOffsetX, setExportGridOffsetX] = useState(0)
  const [exportGridOffsetY, setExportGridOffsetY] = useState(0)
  const [showExportDialog, setShowExportDialog] = useState(false)
  const [exportPreviewPage, setExportPreviewPage] = useState(0)

  /* ---- Editor UI state ---- */
  const [showOriginalPreview, setShowOriginalPreview] = useState(false)
  const [status, setStatus] = useState('No photos added yet')
  const [processing, setProcessing] = useState(false)
  const [lastOutputDir, setLastOutputDir] = useState<string | null>(null)
  const [undoStack, setUndoStack] = useState<EditorSnapshot[]>([])
  const [redoStack, setRedoStack] = useState<EditorSnapshot[]>([])
  const [zoom, setZoom] = useState(1)
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)
  const [histogram, setHistogram] = useState<number[]>(EMPTY_HISTOGRAM)

  /* ---- Crop UI state ---- */
  const [cropMode, setCropMode] = useState(false)
  const [cropAspect, setCropAspect] = useState<CropAspect>('Free')
  const [cropRotation, setCropRotation] = useState(0)
  const [cropCursor, setCropCursor] = useState<CropCursor>('crosshair')

  /* ---- Refs ---- */
  const fileInputRef = useRef<HTMLInputElement>(null)
  const canvasPanelRef = useRef<HTMLDivElement>(null)
  const previewCanvasRef = useRef<HTMLCanvasElement>(null)
  const processedPreviewCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map())
  const previewProxyRef = useRef<Map<number, HTMLCanvasElement>>(new Map())
  const renderRafRef = useRef<number | null>(null)
  const cropDragRef = useRef<CropDrag | null>(null)
  const lastPointerPositionRef = useRef({ x: 0, y: 0 })
  const panDragRef = useRef<{ pointerId: number; clientX: number; clientY: number; offsetX: number; offsetY: number } | null>(null)
  const zoomRef = useRef(1)
  const panRef = useRef({ x: 0, y: 0 })
  const nextPhotoIdRef = useRef(1)
  const cropRectRef = useRef<CropRect | null>(null)
  const shortcutRef = useRef<(event: KeyboardEvent) => void>(() => {})

  /* ---- Derived values (single source of truth: the per-photo maps) ---- */
  const activePhoto: Photo | undefined = photos[selectedPhotoIndex] ?? photos[0]
  const activeSettings = activePhoto ? settingsByPhoto[activePhoto.id] ?? NEUTRAL_SETTINGS : NEUTRAL_SETTINGS
  const cropApplied = activePhoto ? cropAppliedByPhoto[activePhoto.id] ?? null : null
  const cropRect = activePhoto ? cropRectByPhoto[activePhoto.id] ?? null : null
  const activeCropApplied = cropApplied

  cropRectRef.current = cropRect
  zoomRef.current = zoom
  panRef.current = panOffset

  const nextPhotoId = () => nextPhotoIdRef.current++

  /* ---- Setting / crop writers ---- */
  const commitSettings = (next: AdjustmentSettings) => {
    if (!activePhoto) return
    setSettingsByPhoto((current) => ({ ...current, [activePhoto.id]: next }))
  }

  const updateSetting = (key: SliderKey, value: number) => commitSettings({ ...activeSettings, [key]: value })

  const setCropRectFor = (photoId: number, rect: CropRect | null) =>
    setCropRectByPhoto((current) => ({ ...current, [photoId]: rect }))

  const setCropAppliedFor = (photoId: number, applied: CropApplied | null) =>
    setCropAppliedByPhoto((current) => ({ ...current, [photoId]: applied }))

  /* ---- History ---- */
  const captureSnapshot = (photoId: number | null = activePhoto?.id ?? null): EditorSnapshot => ({
    photoId,
    settings: photoId !== null ? settingsByPhoto[photoId] ?? NEUTRAL_SETTINGS : NEUTRAL_SETTINGS,
    cropAppliedByPhoto,
    cropRotation,
  })

  const recordHistory = () => {
    setUndoStack((current) => [...current.slice(-49), captureSnapshot()])
    setRedoStack([])
  }

  const restoreSnapshot = (snapshot: EditorSnapshot) => {
    const { photoId } = snapshot
    if (photoId !== null) {
      setSettingsByPhoto((current) => ({ ...current, [photoId]: snapshot.settings }))
      const index = photos.findIndex((photo) => photo.id === photoId)
      if (index >= 0) setSelectedPhotoIndex(index)
    }
    setCropAppliedByPhoto(snapshot.cropAppliedByPhoto)
    setCropRotation(snapshot.cropRotation)
    setCropRectByPhoto({})
    setCropMode(false)
  }

  const handleUndo = () => {
    const previous = undoStack[undoStack.length - 1]
    if (!previous) return
    setUndoStack((current) => current.slice(0, -1))
    setRedoStack((current) => [...current, captureSnapshot(previous.photoId)])
    restoreSnapshot(previous)
    setStatus('Change undone')
  }

  const handleRedo = () => {
    const next = redoStack[redoStack.length - 1]
    if (!next) return
    setRedoStack((current) => current.slice(0, -1))
    setUndoStack((current) => [...current, captureSnapshot(next.photoId)])
    restoreSnapshot(next)
    setStatus('Change redone')
  }

  /* ---- Image loading / caches ---- */
  const loadImageResource = useCallback((src: string) => {
    const cached = imageCacheRef.current.get(src)
    if (cached && (cached.complete || cached.naturalWidth > 0)) return Promise.resolve(cached)

    return new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image()
      image.crossOrigin = 'anonymous'
      image.decoding = 'async'
      image.onload = () => {
        imageCacheRef.current.set(src, image)
        resolve(image)
      }
      image.onerror = () => reject(new Error(`Unable to load image: ${src}`))
      image.src = src
    })
  }, [])

  const getOrCreateProxy = useCallback((photo: Photo, image: HTMLImageElement): HTMLCanvasElement => {
    const existing = previewProxyRef.current.get(photo.id)
    if (existing) return existing

    const naturalW = image.naturalWidth || image.width
    const naturalH = image.naturalHeight || image.height
    const scale = Math.min(1, MAX_PREVIEW_DIM / Math.max(naturalW, naturalH))
    const proxy = document.createElement('canvas')
    proxy.width = Math.max(1, Math.round(naturalW * scale))
    proxy.height = Math.max(1, Math.round(naturalH * scale))
    const context = proxy.getContext('2d')
    if (context) {
      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = 'high'
      context.drawImage(image, 0, 0, proxy.width, proxy.height)
    }
    previewProxyRef.current.set(photo.id, proxy)
    return proxy
  }, [])

  const generateThumbnails = (photoList: Photo[]) => {
    photoList.forEach(async (photo) => {
      try {
        const image = await loadImageResource(photo.url)
        const targetSize = 160
        const scale = Math.min(targetSize / image.naturalWidth, targetSize / image.naturalHeight, 1)
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
        const context = canvas.getContext('2d')
        if (!context) return
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        const thumbnailUrl = canvas.toDataURL('image/jpeg', 0.75)
        setPhotos((current) =>
          current.map((p) =>
            p.id === photo.id ? { ...p, thumbnailUrl, width: image.naturalWidth, height: image.naturalHeight } : p,
          ),
        )
      } catch {
        // fall back to the full-size url
      }
    })
  }

  const releasePhotos = (list: Photo[]) => {
    list.forEach((photo) => {
      if (photo.url.startsWith('blob:')) URL.revokeObjectURL(photo.url)
    })
    imageCacheRef.current.clear()
    previewProxyRef.current.clear()
  }

  /* ---- Importing photos ---- */
  const addPhotos = (incoming: Photo[], sourceLabel: string) => {
    if (incoming.length === 0) return
    setPhotos((current) => [...current, ...incoming])
    setSelectedPhotoIndex(photos.length + incoming.length - 1)
    setSettingsByPhoto((current) => ({
      ...current,
      ...Object.fromEntries(incoming.map((photo) => [photo.id, NEUTRAL_SETTINGS])),
    }))

    if (applyAutoCorrectionOnImport) {
      incoming.forEach(async (photo) => {
        try {
          const image = await loadImageResource(photo.url)
          const corrected = analyzeForPrint(image, NEUTRAL_SETTINGS)
          setSettingsByPhoto((current) => ({ ...current, [photo.id]: corrected }))
        } catch {
          // leave the photo neutral if analysis fails
        }
      })
    }

    generateThumbnails(incoming)
    setStatus(`${incoming.length} photo(s) loaded${sourceLabel}`)
  }

  const appendFiles = (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith('image/'))
    if (images.length !== files.length) setStatus('Some files were skipped because they are not images.')
    const incoming: Photo[] = images.map((file) => ({
      id: nextPhotoId(),
      name: file.name,
      url: URL.createObjectURL(file),
      path: (file as File & { path?: string }).path ?? file.name,
    }))
    addPhotos(incoming, ' into the pipeline')
  }

  const handleFilesSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    appendFiles(Array.from(event.target.files ?? []))
    event.target.value = ''
  }

  const handleAddPhotos = () => fileInputRef.current?.click()

  const handleOpenNativeDialog = async () => {
    if (!window.polaroidEngine?.openImagePicker) {
      fileInputRef.current?.click()
      return
    }

    const result = (await window.polaroidEngine.openImagePicker()) as NativeImagePickerResult
    if (!result || result.canceled || !Array.isArray(result.filePaths)) return

    const incoming: Photo[] = result.filePaths.map((filePath, index) => ({
      id: nextPhotoId(),
      name: filePath.split(/[\\/]/).pop() ?? 'photo',
      url: result.dataUrls?.[index] ?? normalizeImageUrl(filePath),
      path: filePath,
    }))
    addPhotos(incoming, ' from the native dialog')
  }

  const handleNew = () => {
    releasePhotos(photos)
    setPhotos([])
    setSettingsByPhoto({})
    setCropAppliedByPhoto({})
    setCropRectByPhoto({})
    setCropMode(false)
    setCropRotation(0)
    setSelectedPhotoIndex(0)
    setUndoStack([])
    setRedoStack([])
    setLastOutputDir(null)
    setStatus('No photos added yet')
  }

  const handleDeleteSelectedImage = () => {
    if (photos.length === 0) return
    const id = photos[selectedPhotoIndex].id
    releasePhotos([photos[selectedPhotoIndex]])
    setPhotos(photos.filter((_, i) => i !== selectedPhotoIndex))
    setSettingsByPhoto(Object.fromEntries(Object.entries(settingsByPhoto).filter(([k]) => k !== String(id))))
    setCropAppliedByPhoto(Object.fromEntries(Object.entries(cropAppliedByPhoto).filter(([k]) => k !== String(id))))
    setCropRectByPhoto(Object.fromEntries(Object.entries(cropRectByPhoto).filter(([k]) => k !== String(id))))
    setSelectedPhotoIndex(Math.max(0, selectedPhotoIndex - 1))
    setStatus('Image deleted')
  }

  const handlePolaroidBuilder = () => {
    openExportDialog()
  }

  const handleImpositionBuilder = () => {
    setStatus('Imposition Builder coming soon')
  }

  const handleRemoveAllImages = () => {
    if (photos.length === 0) return
    releasePhotos(photos)
    setPhotos([])
    setSettingsByPhoto({})
    setCropAppliedByPhoto({})
    setCropRectByPhoto({})
    setCropMode(false)
    setCropRotation(0)
    setSelectedPhotoIndex(0)
    setUndoStack([])
    setRedoStack([])
    setStatus('All images removed')
  }

  const selectPhoto = (index: number) => {
    if (!photos[index]) return
    setSelectedPhotoIndex(index)
  }

  /* ---- Projects ---- */
  const handleSaveProject = async () => {
    if (!window.polaroidEngine?.saveProject) {
      setStatus('Project saving is available in the desktop app.')
      return
    }

    const project: SavedProject = {
      version: 1,
      photos: photos.map((photo) => ({
        name: photo.name,
        path: photo.path,
        cropApplied: cropAppliedByPhoto[photo.id] ?? null,
        settings: settingsByPhoto[photo.id] ?? NEUTRAL_SETTINGS,
      })),
      settings: activeSettings,
      preset,
      paperSize,
      selectedPhotoIndex,
      exportFormat,
      exportPageCount,
      exportOrientation,
      exportAutoRotate,
      exportGridOffsetX,
      exportGridOffsetY,
    }

    try {
      const result = await window.polaroidEngine.saveProject(project)
      if (result.canceled) return
      if (!result.ok) throw new Error('Unable to save the project file.')
      setLastOutputDir(result.filePath ?? null)
      setStatus(`Project saved to ${result.filePath ?? 'file'}`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to save the project.')
    }
  }

  const handleOpenProject = async () => {
    if (!window.polaroidEngine?.openProject) {
      setStatus('Project opening is available in the desktop app.')
      return
    }

    try {
      const result = await window.polaroidEngine.openProject()
      if (result.canceled) return
      if (result.error || !result.project) throw new Error(result.error ?? 'Unable to read the project file.')
      const project = result.project as unknown as SavedProject
      if (project.version !== 1 || !Array.isArray(project.photos)) {
        throw new Error('This file is not a supported Polaroid project.')
      }

      const restored = project.photos.map((photo, index) => {
        if (!photo.path || !photo.dataUrl) {
          throw new Error(`The project is missing image data for ${photo.name || `photo ${index + 1}`}.`)
        }
        return {
          saved: photo,
          photo: { id: nextPhotoId(), name: photo.name, path: photo.path, url: photo.dataUrl } as Photo,
        }
      })

      releasePhotos(photos)
      const restoredPhotos = restored.map((entry) => entry.photo)
      setPhotos(restoredPhotos)
      setSettingsByPhoto(
        Object.fromEntries(
          restored.map(({ saved, photo }) => [photo.id, saved.settings ?? project.settings ?? NEUTRAL_SETTINGS]),
        ),
      )
      setCropAppliedByPhoto(Object.fromEntries(restored.map(({ saved, photo }) => [photo.id, saved.cropApplied ?? null])))
      setCropRectByPhoto({})
      setPreset(project.preset ?? 'mini')
      setPaperSize(project.paperSize ?? 'A4')
      setSelectedPhotoIndex(Math.min(project.selectedPhotoIndex ?? 0, Math.max(0, restoredPhotos.length - 1)))
      setExportFormat(project.exportFormat ?? 'png')
      setExportPageCount(project.exportPageCount ?? 1)
      setExportOrientation(project.exportOrientation ?? 'portrait')
      setExportAutoRotate(project.exportAutoRotate ?? true)
      setExportGridOffsetX(project.exportGridOffsetX ?? 0)
      setExportGridOffsetY(project.exportGridOffsetY ?? 0)
      setCropMode(false)
      setCropRotation(0)
      setUndoStack([])
      setRedoStack([])
      setLastOutputDir(null)
      generateThumbnails(restoredPhotos)
      setStatus(`Opened project with ${restoredPhotos.length} photo(s)`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to open the project.')
    }
  }

  /* ---- Adjustments: copy / paste / reset / auto ---- */
  const handleCopyAdjustments = () => {
    if (!activePhoto) return
    const currentCrop = cropAppliedByPhoto[activePhoto.id] ?? null
    setAdjustmentClipboard({
      settings: { ...activeSettings },
      cropApplied: currentCrop ? { ...currentCrop } : null,
    })
    setStatus(`Copied adjustments${currentCrop ? ' & crop' : ''} from ${activePhoto.name}`)
  }

  const handlePasteAdjustments = (includeCrop: boolean) => {
    if (!activePhoto || !adjustmentClipboard) return
    recordHistory()
    commitSettings({ ...adjustmentClipboard.settings })

    if (includeCrop && adjustmentClipboard.cropApplied) {
      setCropAppliedFor(activePhoto.id, { ...adjustmentClipboard.cropApplied })
      setCropRectFor(activePhoto.id, null)
      setStatus(`Pasted adjustments with crop to ${activePhoto.name}`)
    } else {
      setStatus(`Pasted adjustments to ${activePhoto.name}`)
    }
  }

  const handleResetAdjustments = () => {
    if (!activePhoto) return
    recordHistory()
    commitSettings({ ...NEUTRAL_SETTINGS })
    setStatus(`Restored original appearance for ${activePhoto.name}`)
  }

  const handleAutoCorrect = async () => {
    if (!activePhoto) return
    const photo = activePhoto
    setStatus(`Analyzing ${photo.name} for print…`)

    try {
      const image = await loadImageResource(photo.url)
      const corrected = analyzeForPrint(image, settingsByPhoto[photo.id] ?? NEUTRAL_SETTINGS)
      recordHistory()
      setSettingsByPhoto((current) => ({ ...current, [photo.id]: corrected }))
      setStatus(`Print auto-correction applied to ${photo.name}`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Auto correction failed.')
    }
  }

  const handleAutoCorrectAll = async () => {
    if (photos.length === 0) return
    setStatus('Analyzing all photos for print…')

    try {
      const entries = await Promise.all(
        photos.map(async (photo) => {
          const image = await loadImageResource(photo.url)
          return [photo.id, analyzeForPrint(image, settingsByPhoto[photo.id] ?? NEUTRAL_SETTINGS)] as const
        }),
      )
      recordHistory()
      setSettingsByPhoto((current) => ({ ...current, ...Object.fromEntries(entries) }))
      setStatus(`Print auto-correction applied to ${entries.length} photo(s)`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Auto correction failed.')
    }
  }

  /* ---- Zoom / pan ---- */
  const clampPan = (x: number, y: number) => {
    const bounds = canvasPanelRef.current?.getBoundingClientRect()
    if (!bounds) return { x, y }
    // Keep the image center inside the panel so it can never be dragged out of reach.
    return { x: clamp(x, -bounds.width / 2, bounds.width / 2), y: clamp(y, -bounds.height / 2, bounds.height / 2) }
  }

  const applyZoom = useCallback((factor: number, anchor?: { x: number; y: number }) => {
    const current = zoomRef.current
    const next = clamp(Number((current * factor).toFixed(2)), MIN_ZOOM, MAX_ZOOM)
    if (next === current) return

    const point = anchor ?? lastPointerPositionRef.current
    const ratio = next / current
    const pan = panRef.current
    const bounds = canvasPanelRef.current?.getBoundingClientRect()
    let x = point.x - ratio * (point.x - pan.x)
    let y = point.y - ratio * (point.y - pan.y)
    if (bounds) {
      x = clamp(x, -bounds.width / 2, bounds.width / 2)
      y = clamp(y, -bounds.height / 2, bounds.height / 2)
    }

    zoomRef.current = next
    panRef.current = { x, y }
    setZoom(next)
    setPanOffset({ x, y })
  }, [])

  const fitPreview = () => {
    setZoom(1)
    setPanOffset({ x: 0, y: 0 })
  }

  useEffect(() => {
    const panel = canvasPanelRef.current
    if (!panel) return

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      const bounds = panel.getBoundingClientRect()
      const anchor = {
        x: event.clientX - (bounds.left + bounds.width / 2),
        y: event.clientY - (bounds.top + bounds.height / 2),
      }
      lastPointerPositionRef.current = anchor
      applyZoom(event.deltaY < 0 ? 1.1 : 0.9, anchor)
    }

    panel.addEventListener('wheel', handleWheel, { passive: false })
    return () => panel.removeEventListener('wheel', handleWheel)
  }, [applyZoom])

  // Reset the view and crop rotation whenever another photo becomes active.
  useEffect(() => {
    setZoom(1)
    setPanOffset({ x: 0, y: 0 })
    setCropRotation(activeCropApplied?.rotation ?? 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePhoto?.id])

  const handlePanPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (cropMode || zoom <= 1 || event.button !== 0) return

    event.preventDefault()
    const bounds = event.currentTarget.getBoundingClientRect()
    lastPointerPositionRef.current = {
      x: event.clientX - (bounds.left + bounds.width / 2),
      y: event.clientY - (bounds.top + bounds.height / 2),
    }
    panDragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      offsetX: panOffset.x,
      offsetY: panOffset.y,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setIsPanning(true)
  }

  const handlePanPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    lastPointerPositionRef.current = {
      x: event.clientX - (bounds.left + bounds.width / 2),
      y: event.clientY - (bounds.top + bounds.height / 2),
    }

    const drag = panDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    setPanOffset(clampPan(drag.offsetX + event.clientX - drag.clientX, drag.offsetY + event.clientY - drag.clientY))
  }

  const handlePanPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (panDragRef.current?.pointerId !== event.pointerId) return
    panDragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setIsPanning(false)
  }

  /* ---- Preview rendering ---- */
  useEffect(() => {
    if (!photos.length) {
      setSelectedPhotoIndex(0)
      return
    }
    setSelectedPhotoIndex((current) => Math.min(current, photos.length - 1))
  }, [photos.length])

  useEffect(() => {
    const canvas = previewCanvasRef.current
    if (!canvas) return

    if (!activePhoto) {
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
      setHistogram(EMPTY_HISTOGRAM)
      return
    }

    let cancelled = false
    if (renderRafRef.current) cancelAnimationFrame(renderRafRef.current)

    renderRafRef.current = requestAnimationFrame(() => {
      loadImageResource(activePhoto.url)
        .then(async (image) => {
          if (cancelled) return

          const proxy = getOrCreateProxy(activePhoto, image)
          const processed = showOriginalPreview ? proxy : await renderProcessedImage(proxy, activeSettings)
          if (cancelled) return

          const target = previewCanvasRef.current
          if (!target) return
          processedPreviewCanvasRef.current = processed

          const display = !cropMode && activeCropApplied ? createCroppedCanvas(processed, activeCropApplied) : processed
          const scale = Math.min(980 / display.width, 520 / display.height, 1)
          target.width = Math.max(1, Math.round(display.width * scale))
          target.height = Math.max(1, Math.round(display.height * scale))

          const context = target.getContext('2d')
          if (!context) return
          context.clearRect(0, 0, target.width, target.height)
          context.imageSmoothingEnabled = true
          context.imageSmoothingQuality = 'high'
          context.drawImage(display, 0, 0, target.width, target.height)

          if (cropMode && cropRectRef.current) {
            drawCropOverlay(target, processed, cropRectRef.current, true, cropAspect)
          }

          setHistogram(getHistogram(target))
        })
        .catch((error) => {
          if (!cancelled) setStatus(error instanceof Error ? error.message : 'Unable to render the selected photo.')
        })
    })

    return () => {
      cancelled = true
      if (renderRafRef.current) cancelAnimationFrame(renderRafRef.current)
    }
    // cropAspect / crop rect changes are handled by the overlay effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePhoto, activeSettings, activeCropApplied, showOriginalPreview, cropMode])

  // Redraw only the crop overlay while cropping. (Outside crop mode the effect above owns the canvas,
  // otherwise the uncropped image would flash onto a cropped canvas.)
  useEffect(() => {
    const canvas = previewCanvasRef.current
    const source = processedPreviewCanvasRef.current
    if (!cropMode || !canvas || !source) return
    drawCropOverlay(canvas, source, cropRect, true, cropAspect)
  }, [cropMode, cropRect, cropAspect])

  /* ---- Crop interaction ---- */
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
    return handles.find((h) => Math.abs(x - h.x) <= hitRadius && Math.abs(y - h.y) <= hitRadius)?.key ?? null
  }

  const getCropCursorAtPoint = (x: number, y: number): CropCursor => {
    if (!cropRect) return 'crosshair'
    const handle = getCropHandleAtPoint(x, y)
    if (handle === 'nw' || handle === 'se') return 'nwse-resize'
    if (handle === 'ne' || handle === 'sw') return 'nesw-resize'
    if (x >= cropRect.x && x <= cropRect.x + cropRect.width && y >= cropRect.y && y <= cropRect.y + cropRect.height) {
      return 'move'
    }
    return 'crosshair'
  }

  const getCanvasPointerPosition = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = previewCanvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    }
  }

  const handleCropPointerDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!cropMode || !previewCanvasRef.current || !activePhoto || event.button !== 0) return

    event.preventDefault()
    event.stopPropagation()
    const { x, y } = getCanvasPointerPosition(event)

    if (cropRect) {
      const handle = getCropHandleAtPoint(x, y)
      if (handle) {
        cropDragRef.current = { mode: 'resize', handle, startX: x, startY: y, startRect: cropRect }
        return
      }

      if (x >= cropRect.x && x <= cropRect.x + cropRect.width && y >= cropRect.y && y <= cropRect.y + cropRect.height) {
        cropDragRef.current = { mode: 'move', startX: x, startY: y, startRect: cropRect }
        return
      }
    }

    const startRect = { x, y, width: 0, height: 0 }
    cropDragRef.current = { mode: 'new', startX: x, startY: y, startRect }
    setCropRectFor(activePhoto.id, startRect)
  }

  const handleCropPointerMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = previewCanvasRef.current
    if (!cropMode || !canvas || !activePhoto) return

    const { x, y } = getCanvasPointerPosition(event)
    const drag = cropDragRef.current
    if (!drag) {
      setCropCursor(getCropCursorAtPoint(x, y))
      return
    }

    const aspectRatio = getAspectValue(cropAspect)
    let nextRect: CropRect

    if (drag.mode === 'new') {
      nextRect = clampCropRectToCanvas(
        {
          x: Math.min(drag.startX, x),
          y: Math.min(drag.startY, y),
          width: Math.max(10, Math.abs(x - drag.startX)),
          height: Math.max(10, Math.abs(y - drag.startY)),
        },
        canvas.width,
        canvas.height,
        aspectRatio,
      )
    } else if (drag.mode === 'move') {
      nextRect = clampCropRectToCanvas(
        {
          x: drag.startRect.x + (x - drag.startX),
          y: drag.startRect.y + (y - drag.startY),
          width: drag.startRect.width,
          height: drag.startRect.height,
        },
        canvas.width,
        canvas.height,
      )
    } else if (drag.handle) {
      nextRect = resizeCropRect(drag.handle, drag.startRect, x, y, canvas.width, canvas.height, aspectRatio)
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
      setCropCursor(getCropCursorAtPoint(x, y))
      return
    }

    setCropRectFor(activePhoto.id, nextRect)
    setCropCursor(getCropCursorAtPoint(x, y))
    const source = processedPreviewCanvasRef.current
    if (source) drawCropOverlay(canvas, source, nextRect, true, cropAspect)
  }

  const handleCropPointerUp = () => {
    cropDragRef.current = null
    if (activePhoto && cropRect && (cropRect.width < 8 || cropRect.height < 8)) {
      setCropRectFor(activePhoto.id, null)
    }
    setCropCursor('crosshair')
  }

  const handleCropRotate = (delta: number) => {
    recordHistory()
    setCropRotation((current) => (current + delta + 360) % 360)
  }

  const handleCropApply = () => {
    if (!activePhoto || !cropRect) {
      setStatus('Create a crop selection first.')
      return
    }

    const canvasWidth = previewCanvasRef.current?.width ?? 1
    const canvasHeight = previewCanvasRef.current?.height ?? 1
    recordHistory()
    setCropAppliedFor(activePhoto.id, {
      x: cropRect.x / canvasWidth,
      y: cropRect.y / canvasHeight,
      width: cropRect.width / canvasWidth,
      height: cropRect.height / canvasHeight,
      rotation: cropRotation,
    })
    setCropRectFor(activePhoto.id, null)
    setCropMode(false)
    setStatus('Crop applied to the selected image.')
  }

  const handleCropClear = () => {
    recordHistory()
    if (activePhoto) {
      setCropRectFor(activePhoto.id, null)
      setCropAppliedFor(activePhoto.id, null)
    }
    setCropMode(false)
    setCropRotation(0)
    setStatus('Crop removed.')
  }

  /* ---- Export ---- */
  /** Builds one photo "card" (processed, cropped, fitted to the photo opening).
   *  Used by both the real export and the export preview, so they always match. */
  const buildCard: BuildCard = useCallback(
    async (photo, targetWidth, targetHeight, { preview, blurRadius }) => {
      const image = await loadImageResource(photo.url)
      const source = preview ? getOrCreateProxy(photo, image) : image
      const processed = await renderProcessedImage(source, settingsByPhoto[photo.id] ?? NEUTRAL_SETTINGS)
      const crop = cropAppliedByPhoto[photo.id] ?? null
      const cropped = crop ? createCroppedCanvas(processed, crop) : processed

      // Every photo is fitted to the photo opening so it can never be stretched.
      // Change 'contain' to 'cover' to fill the whole opening (edges get trimmed).
      return fillBlur
        ? createBlurFillCanvas(cropped, targetWidth, targetHeight, exportAutoRotate, blurRadius)
        : createFitCanvas(cropped, targetWidth, targetHeight, exportAutoRotate, 'contain')
    },
    [loadImageResource, getOrCreateProxy, settingsByPhoto, cropAppliedByPhoto, fillBlur, exportAutoRotate],
  )

  const handleExportSheet = async () => {
    if (photos.length === 0) {
      setStatus('Select at least one photo before exporting.')
      return
    }

    setProcessing(true)
    setStatus('Processing images and building export sheet…')

    try {
      const { photoW, photoH } = PRESETS[preset]
      const images: HTMLCanvasElement[] = []
      for (const photo of photos) {
        images.push(await buildCard(photo, photoW, photoH, { preview: false }))
      }

      const layout = buildSheetLayout(PRESETS[preset], 1, paperSize)
      const maxImagesPerPage = layout.cols * layout.rows
      const mimeType = exportFormat === 'jpeg' ? 'image/jpeg' : 'image/png'

      const dataUrls: string[] = []
      for (let i = 0; i < images.length; i += maxImagesPerPage) {
        // The cards are already processed by buildCard, so the sheet must use NEUTRAL settings.
        // (Passing `defaultSettings` here would apply brightness 1.3 / contrast 1.1 / saturation 1.15 a second time.)
        const sheet = await renderSheet(images.slice(i, i + maxImagesPerPage), preset, NEUTRAL_SETTINGS, paperSize, exportAutoRotate, {
          offsetX: exportGridOffsetX,
          offsetY: exportGridOffsetY,
        })
        dataUrls.push(sheet.toDataURL(mimeType))
      }

      const fileName = `${PRESETS[preset].label.toLowerCase().replace(/\s+/g, '-')}-sheet.${exportFormat}`

      const saveResult = await window.polaroidEngine?.saveExport?.({
        dataUrls,
        defaultName: fileName,
        format: exportFormat,
        dpi: 300,
      })

      if (saveResult && !saveResult.canceled && saveResult.ok) {
        setLastOutputDir(saveResult.filePath ?? null)
        setStatus(`Exported ${images.length} image(s) to ${saveResult.filePath ?? 'a printable sheet'}.`)
        return
      }

      if (saveResult?.canceled) {
        setStatus('Export cancelled.')
        return
      }

      // Browser fallback: download each sheet.
      dataUrls.forEach((dataUrl, idx) => {
        const anchor = document.createElement('a')
        anchor.href = dataUrl
        anchor.download = dataUrls.length === 1 ? fileName : fileName.replace(/\.([^.]+)$/, `-${idx + 1}.$1`)
        anchor.click()
      })
      setLastOutputDir('browser-download')
      setStatus(`Browser export created: ${fileName}`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Export failed.')
    } finally {
      setProcessing(false)
    }
  }

  const openExportDialog = () => {
    if (photos.length === 0) {
      setStatus('Select at least one photo before exporting.')
      return
    }
    setShowExportDialog(true)
    setExportPreviewPage(0)
  }

  const finalizeExport = async () => {
    setShowExportDialog(false)
    await handleExportSheet()
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

      // The bridge takes one settings object per call, so photos that share the same
      // exposure / contrast / sharpen are sent together and each group uses its own values.
      const groups = new Map<string, { settings: AdjustmentSettings; files: string[] }>()
      for (const photo of photos) {
        const photoSettings = settingsByPhoto[photo.id] ?? NEUTRAL_SETTINGS
        const key = `${photoSettings.exposure}|${photoSettings.contrast}|${photoSettings.sharpen}`
        const group = groups.get(key) ?? { settings: photoSettings, files: [] }
        group.files.push(photo.path)
        groups.set(key, group)
      }

      let lastMessage: string | undefined
      for (const { settings, files } of groups.values()) {
        const result = await window.polaroidEngine.processImages({
          files,
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

        if (!result?.ok) throw new Error(result?.error ?? 'Rust processing failed.')
        setLastOutputDir(result.outputDir ?? null)
        lastMessage = result.message
      }

      setStatus(lastMessage ?? 'Rust processing completed successfully.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unknown processing error.')
    } finally {
      setProcessing(false)
    }
  }

  /* ---- Keyboard shortcuts ---- */
  shortcutRef.current = (event) => {
    const target = event.target as HTMLElement | null
    const tag = target?.tagName
    const inputType = (target as HTMLInputElement | null)?.type
    const isRange = tag === 'INPUT' && inputType === 'range'
    const isTyping = tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && !isRange && inputType !== 'checkbox')
    const mod = event.ctrlKey || event.metaKey
    const key = event.key.toLowerCase()

    if (mod && (key === 'z' || key === 'y')) {
      if (isTyping || showExportDialog) return
      event.preventDefault()
      if (key === 'y' || event.shiftKey) handleRedo()
      else handleUndo()
      return
    }

    if (event.key === 'Escape') {
      if (showExportDialog) {
        setShowExportDialog(false)
      } else if (cropMode) {
        setCropMode(false)
        if (activePhoto) setCropRectFor(activePhoto.id, null)
      }
      return
    }

    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !mod && !isTyping && !isRange && !showExportDialog) {
      event.preventDefault()
      selectPhoto(clamp(selectedPhotoIndex + (event.key === 'ArrowLeft' ? -1 : 1), 0, photos.length - 1))
    }
  }

  useEffect(() => {
    const listener = (event: KeyboardEvent) => shortcutRef.current(event)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  /* ---- Render ---- */
  const operationSummary = buildAdjustmentOperations(activeSettings)
  const stageLabel = activePhoto ? `${photos.length} photo${photos.length === 1 ? '' : 's'} | ${activePhoto.name}` : ''

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
          <button title="Add photos" onClick={handleOpenNativeDialog}>Add Photos</button>
          <button
            title="Auto color correction on import"
            aria-pressed={applyAutoCorrectionOnImport}
            onClick={() => setApplyAutoCorrectionOnImport((current) => !current)}
            className={`import-toggle ${applyAutoCorrectionOnImport ? 'active' : ''}`}
          >
            Auto-correct import {applyAutoCorrectionOnImport ? '✓' : '✗'}
          </button>
          <button title="Open project" onClick={handleOpenProject}>Open Project</button>
          <button title="Save project" onClick={handleSaveProject}>Save Project</button>
          <button title="Clear current selection" onClick={handleNew}>New</button>
          <button title="Undo (Ctrl+Z)" aria-label="Undo" onClick={handleUndo} disabled={undoStack.length === 0}>↶</button>
          <button title="Redo (Ctrl+Shift+Z)" aria-label="Redo" onClick={handleRedo} disabled={redoStack.length === 0}>↷</button>
          <button title="Export print sheet" onClick={openExportDialog}>Export</button>
          <button title="Run Rust process" onClick={handleProcessWithRust} disabled={processing}>{processing ? 'Processing…' : 'Process'}</button>
        </div>

        <div className="workspace-shell">
          <aside className="tool-rail">
            <div className="tool-group">
              <button title="Open Images" className="tool-button" aria-label="Open Images" onClick={handleOpenNativeDialog}>📂</button>
              <button title="Crop (Esc to leave)" className={`tool-button ${cropMode ? 'active' : ''}`} aria-label="Crop" aria-pressed={cropMode} onClick={() => setCropMode((current) => !current)}>◧</button>
              <div className="tool-separator"></div>
              <button title="Undo (Ctrl+Z)" className="tool-button" aria-label="Undo" onClick={handleUndo} disabled={undoStack.length === 0}>↶</button>
              <button title="Redo (Ctrl+Shift+Z)" className="tool-button" aria-label="Redo" onClick={handleRedo} disabled={redoStack.length === 0}>↷</button>
              <button title="Reset Adjustments" className="tool-button" aria-label="Reset Adjustments" onClick={handleResetAdjustments}>↺</button>
              <div className="tool-separator"></div>
              <button title="Polaroid Builder" className="tool-button" aria-label="Polaroid Builder" onClick={handlePolaroidBuilder}>📷</button>
              <button title="Imposition Builder" className="tool-button" aria-label="Imposition Builder" onClick={handleImpositionBuilder}>🖨️</button>
              <button title="Delete Selected Image" className="tool-button" aria-label="Delete Selected Image" onClick={handleDeleteSelectedImage}>🗑️</button>
              <button title="Remove All Images" className="tool-button" aria-label="Remove All Images" onClick={handleRemoveAllImages}>🧹</button>
            </div>
          </aside>

          <main className="main-stage">
            <div className="stage-toolbar">
              <div className="stage-label">{stageLabel}</div>
              {cropMode ? (
                <div className="crop-toolbar">
                  <div className="crop-aspect-list" aria-label="Crop aspect ratio">
                    {CROP_ASPECTS.map((aspect) => (
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
                    <span title="Rotation is shown after you press Apply">{cropRotation}°</span>
                  </div>
                  {cropRect ? <button type="button" title="Apply crop" className="ghost-button" onClick={handleCropApply}>Apply</button> : null}
                  {cropRect || cropApplied ? <button type="button" title="Clear crop" className="ghost-button" onClick={handleCropClear}>Clear</button> : null}
                </div>
              ) : null}
              <div className="stage-actions">
                <button title="Previous photo" aria-label="Previous photo" onClick={() => selectPhoto(Math.max(0, selectedPhotoIndex - 1))} disabled={selectedPhotoIndex === 0}>‹</button>
                <button title="Next photo" aria-label="Next photo" onClick={() => selectPhoto(Math.min(photos.length - 1, selectedPhotoIndex + 1))} disabled={selectedPhotoIndex >= photos.length - 1}>›</button>
                <button title="Zoom out" aria-label="Zoom out" onClick={() => applyZoom(0.9)} disabled={zoom <= MIN_ZOOM}>−</button>
                <span className="zoom-level">{Math.round(zoom * 100)}%</span>
                <button title="Zoom in" aria-label="Zoom in" onClick={() => applyZoom(1.1)} disabled={zoom >= MAX_ZOOM}>+</button>
                <button title="Fit preview" onClick={fitPreview}>Fit</button>
                <button title="Add photos" onClick={handleAddPhotos}>⤢</button>
              </div>
            </div>

            <div
              className="canvas-panel"
              ref={canvasPanelRef}
              style={{ cursor: cropMode ? 'crosshair' : isPanning ? 'grabbing' : zoom > 1 ? 'grab' : 'default' }}
              onPointerDown={handlePanPointerDown}
              onPointerMove={handlePanPointerMove}
              onPointerUp={handlePanPointerUp}
              onPointerCancel={handlePanPointerUp}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault()
                appendFiles(Array.from(event.dataTransfer?.files ?? []))
              }}
            >
              <canvas
                ref={previewCanvasRef}
                className={`preview-canvas ${cropMode ? 'crop-enabled' : ''}`}
                style={{
                  cursor: cropMode ? cropCursor : isPanning ? 'grabbing' : zoom > 1 ? 'grab' : 'default',
                  transform: `translate(calc(-50% + ${panOffset.x}px), calc(-50% + ${panOffset.y}px)) scale(${zoom})`,
                }}
                onMouseDown={handleCropPointerDown}
                onMouseMove={handleCropPointerMove}
                onMouseUp={handleCropPointerUp}
                onMouseLeave={() => {
                  setCropCursor('crosshair')
                  handleCropPointerUp()
                }}
              />
            </div>

            <div className="preview-controls">
              <button title="Rotate Left" className="preview-btn" aria-label="Rotate Left" onClick={() => handleCropRotate(-90)}>↺</button>
              <button title="Rotate Right" className="preview-btn" aria-label="Rotate Right" onClick={() => handleCropRotate(90)}>↻</button>
              <div className="preview-spacer"></div>
              <button title="Fit to Window" className="preview-btn" aria-label="Fit to Window" onClick={fitPreview}>Fit to Window</button>
              <button title="Zoom 100%" className="preview-btn" aria-label="Zoom 100%" onClick={() => applyZoom(1)}>Zoom 100%</button>
              <button title="Zoom 50%" className="preview-btn" aria-label="Zoom 50%" onClick={() => applyZoom(0.5)}>Zoom 50%</button>
              <div className="preview-spacer"></div>
              <button title="Compare Original" className={`preview-btn compare-button ${showOriginalPreview ? 'active' : ''}`} aria-label="Compare Original" aria-pressed={showOriginalPreview} onPointerDown={() => setShowOriginalPreview(true)} onPointerUp={() => setShowOriginalPreview(false)} onPointerCancel={() => setShowOriginalPreview(false)} onLostPointerCapture={() => setShowOriginalPreview(false)}>Compare Original</button>
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
                    onClick={() => selectPhoto(index)}
                  >
                    <img src={photo.thumbnailUrl ?? photo.url} alt={photo.name} loading="lazy" />
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
              <div className="histogram-actions">
                <button
                  type="button"
                  className="auto-correct-button"
                  onClick={handleAutoCorrect}
                  disabled={!activePhoto}
                  title="Analyze this photo and correct it for printing"
                >
                  Auto
                </button>
                <button
                  type="button"
                  className="auto-correct-button"
                  onClick={handleAutoCorrectAll}
                  disabled={photos.length === 0}
                  title="Analyze every photo and correct each one for printing"
                >
                  Auto All
                </button>
                <button
                  type="button"
                  className="reset-adjustments-btn"
                  onClick={handleResetAdjustments}
                  disabled={!activePhoto}
                  title="Reset Adjustments"
                  aria-label="Reset Adjustments"
                >
                  ↺ Reset
                </button>
                <button
                  type="button"
                  className={`compare-preview-button ${showOriginalPreview ? 'active' : ''}`}
                  title="Hold to view the original image"
                  aria-label="Hold to view original image"
                  aria-pressed={showOriginalPreview}
                  disabled={!activePhoto}
                  onPointerDown={(event) => {
                    event.currentTarget.setPointerCapture(event.pointerId)
                    setShowOriginalPreview(true)
                  }}
                  onPointerUp={() => setShowOriginalPreview(false)}
                  onPointerCancel={() => setShowOriginalPreview(false)}
                  onLostPointerCapture={() => setShowOriginalPreview(false)}
                  onKeyDown={(event) => {
                    if (event.key === ' ' || event.key === 'Enter') setShowOriginalPreview(true)
                  }}
                  onKeyUp={() => setShowOriginalPreview(false)}
                  onBlur={() => setShowOriginalPreview(false)}
                >
                  Before / After
                </button>
              </div>

              <div className="adjustments-clipboard-toolbar">
                <button
                  type="button"
                  className="clipboard-action-btn copy-btn"
                  onClick={handleCopyAdjustments}
                  disabled={!activePhoto}
                  title={activePhoto ? (cropApplied ? 'Copy settings and crop from active photo' : 'Copy settings from active photo') : 'Select a photo first'}
                >
                  <span className="clipboard-icon">📋</span> Copy
                </button>
                <button
                  type="button"
                  className="clipboard-action-btn paste-btn"
                  onClick={() => handlePasteAdjustments(false)}
                  disabled={!activePhoto || !adjustmentClipboard}
                  title={adjustmentClipboard ? 'Paste settings only (preserve current crop)' : 'Copy adjustments first'}
                >
                  <span className="clipboard-icon">📥</span> Paste (No Crop)
                </button>
                <button
                  type="button"
                  className="clipboard-action-btn paste-btn paste-crop-btn"
                  onClick={() => handlePasteAdjustments(true)}
                  disabled={!activePhoto || !adjustmentClipboard || !adjustmentClipboard.cropApplied}
                  title={
                    !adjustmentClipboard
                      ? 'Copy adjustments first'
                      : adjustmentClipboard.cropApplied
                        ? 'Paste settings including copied crop'
                        : 'Copied adjustments have no crop'
                  }
                >
                  <span className="clipboard-icon">✂️</span> Paste (With Crop)
                </button>
              </div>
            </div>

            <div className="slider-stack">
              {SLIDERS.map(({ key, label, min, max }) => (
                <SliderControl
                  key={key}
                  label={label}
                  min={min}
                  max={max}
                  step={0.01}
                  value={activeSettings[key]}
                  defaultValue={NEUTRAL_SETTINGS[key]}
                  onChange={(value) => updateSetting(key, value)}
                  onInteractionStart={recordHistory}
                />
              ))}
            </div>
          </aside>
        </div>

        <footer className="status-bar" role="status" aria-live="polite">
          <span>Status</span>
          <strong>{status}</strong>
          <span className="status-divider">|</span>
          <span>{photos.length} photo{photos.length === 1 ? '' : 's'}</span>
          {activePhoto ? (
            <>
              <span className="status-divider">|</span>
              <span>{activePhoto.name}</span>
              {activePhoto.width && activePhoto.height ? <span className="status-divider">|</span> : null}
              {activePhoto.width && activePhoto.height ? <span>{activePhoto.width} × {activePhoto.height}</span> : null}
            </>
          ) : null}
          {lastOutputDir ? <small title={lastOutputDir}>{lastOutputDir}</small> : null}
        </footer>
      </div>

      {showExportDialog ? (
        <ExportDialog
          photos={photos}
          preset={preset}
          onPresetChange={setPreset}
          paperSize={paperSize}
          onPaperSizeChange={setPaperSize}
          orientation={exportOrientation}
          onOrientationChange={setExportOrientation}
          pageCount={exportPageCount}
          onPageCountChange={setExportPageCount}
          autoRotate={exportAutoRotate}
          onAutoRotateChange={setExportAutoRotate}
          fillBlur={fillBlur}
          onFillBlurChange={setFillBlur}
          gridOffsetX={exportGridOffsetX}
          gridOffsetY={exportGridOffsetY}
          onGridOffsetChange={(x, y) => {
            setExportGridOffsetX(x)
            setExportGridOffsetY(y)
          }}
          format={exportFormat}
          onFormatChange={setExportFormat}
          previewPage={exportPreviewPage}
          onPreviewPageChange={setExportPreviewPage}
          buildCard={buildCard}
          onClose={() => setShowExportDialog(false)}
          onSave={finalizeExport}
          onPreviewError={setStatus}
        />
      ) : null}

      {processing ? (
        <div className="export-dialog-backdrop">
          <div className="processing-dialog">
            <h3>Processing...</h3>
            <p>{status}</p>
            <div className="loading-spinner"></div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default App
