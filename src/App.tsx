import { useCallback, useEffect, useRef, useState } from 'react'

import './App.css'

import {
  PRESETS,
  buildAdjustmentOperations,
  buildSheetLayout,
  renderSheet,
  type AdjustmentSettings,
  type PaperSizeKey,
  type PresetKey,
} from './engine/polaroidEngine'
import { isSuperseded, renderProcessedImageAsync } from './engine/renderProcessed'

import { ExportDialog } from './components/ExportDialog'
import { SliderControl } from './components/SliderControl'

import { useAutosave } from './hooks/useAutosave'
import { useCrop } from './hooks/useCrop'
import { useProject, type RestoredProject } from './hooks/useProject'
import { useZoomPan } from './hooks/useZoomPan'

import { getBridge, toAppFileUrl } from './lib/bridge'
import {
  clamp,
  createBlurFillCanvas,
  createCroppedCanvas,
  createFitCanvas,
  drawCropOverlay,
  getHistogram,
} from './lib/canvasUtils'
import {
  CROP_ASPECTS,
  EMPTY_HISTOGRAM,
  MAX_PREVIEW_CANVAS,
  MAX_PREVIEW_DIM,
  MAX_ZOOM,
  MIN_ZOOM,
  NEUTRAL_SETTINGS,
  SLIDERS,
  type SliderKey,
} from './lib/editorConstants'
import { analyzeForPrint } from './lib/printAnalysis'

import type {
  BuildCard,
  CropApplied,
  EditorSnapshot,
  ExportFormat,
  ExportOrientation,
  Photo,
} from './types'

/** Undo entry. `allSettings` is set by bulk operations (Auto All) so one Undo restores every photo. */
type HistoryEntry = EditorSnapshot & { allSettings?: Record<number, AdjustmentSettings> }

async function canvasToBytes(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<ArrayBuffer> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, quality))
  if (!blob) throw new Error('Unable to encode the export sheet.')
  return blob.arrayBuffer()
}

function App() {
  /* ---- Library / project state ---- */
  const [photos, setPhotos] = useState<Photo[]>([])
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState(0)
  const [settingsByPhoto, setSettingsByPhoto] = useState<Record<number, AdjustmentSettings>>({})
  const [cropAppliedByPhoto, setCropAppliedByPhoto] = useState<Record<number, CropApplied | null>>({})
  const [adjustmentClipboard, setAdjustmentClipboard] = useState<{
    settings: AdjustmentSettings
    cropApplied: CropApplied | null
  } | null>(null)

  /* ---- Import behavior (toggled from the native File menu) ---- */
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
  const [undoStack, setUndoStack] = useState<HistoryEntry[]>([])
  const [redoStack, setRedoStack] = useState<HistoryEntry[]>([])
  const [histogram, setHistogram] = useState<number[]>(EMPTY_HISTOGRAM)

  /* ---- Refs ---- */
  const fileInputRef = useRef<HTMLInputElement>(null)
  const canvasPanelRef = useRef<HTMLDivElement>(null)
  const previewCanvasRef = useRef<HTMLCanvasElement>(null)
  const processedPreviewCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map())
  const previewProxyRef = useRef<Map<number, HTMLCanvasElement>>(new Map())
  const renderRafRef = useRef<number | null>(null)
  const nextPhotoIdRef = useRef(1)
  const shortcutRef = useRef<(event: KeyboardEvent) => void>(() => {})
  const menuActionRef = useRef<(action: string, payload?: unknown) => void>(() => {})
  const recordHistoryRef = useRef<(full?: boolean) => void>(() => {})

  /* ---- Derived values ---- */
  const activePhoto: Photo | undefined = photos[selectedPhotoIndex] ?? photos[0]
  const activeSettings = activePhoto ? settingsByPhoto[activePhoto.id] ?? NEUTRAL_SETTINGS : NEUTRAL_SETTINGS

  const nextPhotoId = () => nextPhotoIdRef.current++

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

  /* ---- Feature hooks ---- */
  const crop = useCrop({
    activePhotoId: activePhoto?.id,
    previewCanvasRef,
    processedPreviewCanvasRef,
    cropAppliedByPhoto,
    setCropAppliedByPhoto,
    recordHistory: () => recordHistoryRef.current(),
    setStatus,
  })
  const {
    cropMode,
    setCropMode,
    toggleCropMode,
    cropAspect,
    setCropAspect,
    cropRotation,
    setCropRotation,
    cropCursor,
    cropRect,
    cropRectRef,
    cropApplied,
    setCropRectByPhoto,
    setCropRectFor,
    setCropAppliedFor,
    canvasHandlers,
    handleCropRotate,
    handleRotatePhoto,
    handleCropApply,
    handleCropClear,
  } = crop

  const { zoom, panOffset, isPanning, applyZoom, fitPreview, setZoomLevel, panHandlers } = useZoomPan(canvasPanelRef, {
    cropMode,
    resetKey: activePhoto?.id,
  })

  /* ---- Setting writers ---- */
  const commitSettings = (next: AdjustmentSettings) => {
    if (!activePhoto) return
    setSettingsByPhoto((current) => ({ ...current, [activePhoto.id]: next }))
  }

  const updateSetting = (key: SliderKey, value: number) => commitSettings({ ...activeSettings, [key]: value })

  /* ---- History ---- */
  const captureSnapshot = (photoId: number | null = activePhoto?.id ?? null, full = false): HistoryEntry => ({
    photoId,
    settings: photoId !== null ? settingsByPhoto[photoId] ?? NEUTRAL_SETTINGS : NEUTRAL_SETTINGS,
    cropAppliedByPhoto,
    cropRotation,
    ...(full ? { allSettings: settingsByPhoto } : {}),
  })

  const recordHistory = (full = false) => {
    setUndoStack((current) => [...current.slice(-49), captureSnapshot(undefined, full)])
    setRedoStack([])
  }
  recordHistoryRef.current = recordHistory

  const restoreSnapshot = (snapshot: HistoryEntry) => {
    const { photoId } = snapshot
    const existingIds = new Set(photos.map((photo) => photo.id))

    if (snapshot.allSettings) {
      const all = snapshot.allSettings
      setSettingsByPhoto((current) => ({
        ...current,
        ...Object.fromEntries(Object.entries(all).filter(([id]) => existingIds.has(Number(id)))),
      }))
    }

    if (photoId !== null) {
      const index = photos.findIndex((photo) => photo.id === photoId)
      if (index >= 0) {
        setSettingsByPhoto((current) => ({ ...current, [photoId]: snapshot.settings }))
        setSelectedPhotoIndex(index)
      }
    }
    setCropAppliedByPhoto(
      Object.fromEntries(Object.entries(snapshot.cropAppliedByPhoto).filter(([id]) => existingIds.has(Number(id)))),
    )
    setCropRotation(snapshot.cropRotation)
    setCropRectByPhoto({})
    setCropMode(false)
  }

  const handleUndo = () => {
    const previous = undoStack[undoStack.length - 1]
    if (!previous) return
    setUndoStack((current) => current.slice(0, -1))
    setRedoStack((current) => [...current, captureSnapshot(previous.photoId, Boolean(previous.allSettings))])
    restoreSnapshot(previous)
    setStatus('Change undone')
  }

  const handleRedo = () => {
    const next = redoStack[redoStack.length - 1]
    if (!next) return
    setRedoStack((current) => current.slice(0, -1))
    setUndoStack((current) => [...current, captureSnapshot(next.photoId, Boolean(next.allSettings))])
    restoreSnapshot(next)
    setStatus('Change redone')
  }

  /* ---- Thumbnails / resource cleanup ---- */
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

  /** Frees only the given photos' resources (the other photos keep their caches). */
  const releasePhotos = (list: Photo[]) => {
    list.forEach((photo) => {
      imageCacheRef.current.delete(photo.url)
      previewProxyRef.current.delete(photo.id)
      if (photo.url.startsWith('blob:')) URL.revokeObjectURL(photo.url)
    })
  }

  /* ---- Importing photos ---- */
  const addPhotos = (incoming: Photo[], sourceLabel: string, skipped = 0) => {
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
    setStatus(
      `${incoming.length} photo(s) loaded${sourceLabel}${skipped > 0 ? ` (${skipped} non-image file(s) skipped)` : ''}`,
    )
  }

  const appendFiles = (files: File[]) => {
    const images = files.filter(
      (file) => file.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name),
    )
    if (images.length === 0) {
      if (files.length > 0) setStatus('No image files found in the selection.')
      return
    }
    const bridge = getBridge()
    const incoming: Photo[] = images.map((file) => {
      let filePath = ''
      try {
        filePath = bridge?.getPathForFile?.(file) || (file as File & { path?: string }).path || ''
      } catch {
        // path lookup failed; fall back to the file name below
      }
      return {
        id: nextPhotoId(),
        name: file.name,
        url: filePath ? toAppFileUrl(filePath) : URL.createObjectURL(file),
        path: filePath || file.name,
      }
    })
    addPhotos(incoming, ' into the pipeline', files.length - images.length)
  }

  const handleFilesSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    appendFiles(Array.from(event.target.files ?? []))
    event.target.value = ''
  }

  const handleAddPhotos = () => fileInputRef.current?.click()

  const handleOpenNativeDialog = async () => {
    const bridge = getBridge()
    if (!bridge?.openImagePicker) {
      fileInputRef.current?.click()
      return
    }

    try {
      const result = await bridge.openImagePicker()
      if (!result || result.canceled || !Array.isArray(result.filePaths)) return

      // Pixels are streamed from disk through the polaroid-file:// protocol (no base64 over IPC).
      const incoming: Photo[] = result.filePaths.map((filePath) => ({
        id: nextPhotoId(),
        name: filePath.split(/[\\/]/).pop() ?? 'photo',
        url: toAppFileUrl(filePath),
        path: filePath,
      }))
      addPhotos(incoming, ' from the native dialog')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to open the image picker.')
    }
  }

  const resetWorkspace = () => {
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
  }

  const handleDeleteSelectedImage = () => {
    if (photos.length === 0) return
    const target = photos[selectedPhotoIndex] ?? photos[0]
    const id = target.id
    releasePhotos([target])
    setPhotos(photos.filter((photo) => photo.id !== id))
    setSettingsByPhoto(Object.fromEntries(Object.entries(settingsByPhoto).filter(([k]) => k !== String(id))))
    setCropAppliedByPhoto(Object.fromEntries(Object.entries(cropAppliedByPhoto).filter(([k]) => k !== String(id))))
    setCropRectByPhoto((current) => Object.fromEntries(Object.entries(current).filter(([k]) => k !== String(id))))
    setUndoStack((current) => current.filter((entry) => entry.photoId !== id))
    setRedoStack((current) => current.filter((entry) => entry.photoId !== id))
    setSelectedPhotoIndex(Math.max(0, selectedPhotoIndex - 1))
    setStatus('Image deleted')
  }

  const handleImpositionBuilder = () => {
    setStatus('Imposition Builder coming soon')
  }

  const handleRemoveAllImages = () => {
    if (photos.length === 0) return
    if (!window.confirm('Remove all images?')) return
    resetWorkspace()
    setStatus('All images removed')
  }

  const selectPhoto = (index: number) => {
    if (!photos[index]) return
    setSelectedPhotoIndex(index)
  }

  /* ---- Projects (build / save / open live in useProject) ---- */
  const applyRestored = ({ project, entries }: RestoredProject, label: string) => {
    releasePhotos(photos)
    const restoredPhotos = entries.map((entry) => entry.photo)
    setPhotos(restoredPhotos)
    setSettingsByPhoto(
      Object.fromEntries(
        entries.map(({ saved, photo }) => [photo.id, saved.settings ?? project.settings ?? NEUTRAL_SETTINGS]),
      ),
    )
    setCropAppliedByPhoto(Object.fromEntries(entries.map(({ saved, photo }) => [photo.id, saved.cropApplied ?? null])))
    setCropRectByPhoto({})
    setPreset(project.preset ?? 'mini')
    setPaperSize(project.paperSize ?? '13x19')
    setSelectedPhotoIndex(Math.min(project.selectedPhotoIndex ?? 0, Math.max(0, restoredPhotos.length - 1)))
    setExportFormat(project.exportFormat ?? 'pdf')
    setExportPageCount(project.exportPageCount ?? 1)
    setExportOrientation(project.exportOrientation ?? 'portrait')
    setExportAutoRotate(project.exportAutoRotate ?? true)
    setFillBlur(project.fillBlur ?? false)
    setExportGridOffsetX(project.exportGridOffsetX ?? 0)
    setExportGridOffsetY(project.exportGridOffsetY ?? 0)
    setCropMode(false)
    setCropRotation(0)
    setUndoStack([])
    setRedoStack([])
    setLastOutputDir(null)
    generateThumbnails(restoredPhotos)
    setStatus(`${label} ${restoredPhotos.length} photo(s)`)
  }

  const {
    projectInputRef,
    buildProject,
    restoreProject,
    handleSaveProject,
    handleOpenProject,
    handleProjectFileSelected,
    handleDroppedProjectFile,
  } = useProject({
    photos,
    snapshot: {
      settingsByPhoto,
      cropAppliedByPhoto,
      activeSettings,
      selectedPhotoIndex,
      preset,
      paperSize,
      exportFormat,
      exportPageCount,
      exportOrientation,
      exportAutoRotate,
      exportGridOffsetX,
      exportGridOffsetY,
      fillBlur,
    },
    nextPhotoId,
    loadImageResource,
    applyRestored,
    setStatus,
    setLastOutputDir,
  })

  const handleDroppedFiles = (files: File[]) => {
    const projectFiles = files.filter((file) => /\.(json|polaroid)$/i.test(file.name))
    if (projectFiles.length > 1 || (projectFiles.length === 1 && files.length > 1)) {
      setStatus('Drop one project file by itself, or drop image files separately.')
      return
    }
    if (projectFiles.length === 1) {
      void handleDroppedProjectFile(projectFiles[0])
      return
    }
    appendFiles(files)
  }

  const { lastAutosave, markDirty, recoverAutosave } = useAutosave({
    photos,
    buildProject,
    restoreProject,
    openProject: handleOpenProject,
    setStatus,
  })

  useEffect(() => {
    markDirty()
  }, [
    markDirty,
    photos,
    settingsByPhoto,
    cropAppliedByPhoto,
    preset,
    paperSize,
    exportFormat,
    exportPageCount,
    exportOrientation,
    exportAutoRotate,
    exportGridOffsetX,
    exportGridOffsetY,
    fillBlur,
  ])

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
      setCropRotation(adjustmentClipboard.cropApplied.rotation ?? 0)
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
      recordHistory(true) // full snapshot so one Undo reverts every photo
      setSettingsByPhoto((current) => ({ ...current, ...Object.fromEntries(entries) }))
      setStatus(`Print auto-correction applied to ${entries.length} photo(s)`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Auto correction failed.')
    }
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
          // Per-pixel work runs in a worker; only the newest slider value is ever processed.
          const processed = showOriginalPreview
            ? proxy
            : await renderProcessedImageAsync(proxy, activeSettings, { channel: 'preview' })
          if (cancelled) return

          const target = previewCanvasRef.current
          if (!target) return
          processedPreviewCanvasRef.current = processed

          const display = !cropMode && cropApplied ? createCroppedCanvas(processed, cropApplied) : processed
          const scale = Math.min(MAX_PREVIEW_CANVAS / display.width, MAX_PREVIEW_CANVAS / display.height, 1)
          target.width = Math.max(1, Math.round(display.width * scale))
          target.height = Math.max(1, Math.round(display.height * scale))

          const context = target.getContext('2d')
          if (!context) return
          context.clearRect(0, 0, target.width, target.height)
          context.imageSmoothingEnabled = true
          context.imageSmoothingQuality = 'high'
          context.drawImage(display, 0, 0, target.width, target.height)

          if (cropMode) {
            const rect = cropRectRef.current ?? { x: 0, y: 0, width: target.width, height: target.height }
            if (!cropRectRef.current) setCropRectFor(activePhoto.id, rect)
            drawCropOverlay(target, processed, rect, true, cropAspect)
          }

          setHistogram(getHistogram(target))
        })
        .catch((error) => {
          if (cancelled || isSuperseded(error)) return
          setStatus(error instanceof Error ? error.message : 'Unable to render the selected photo.')
        })
    })

    return () => {
      cancelled = true
      if (renderRafRef.current) cancelAnimationFrame(renderRafRef.current)
    }
    // Keyed on the photo id (not the object) so a finished thumbnail doesn't trigger a re-render of the preview.
    // cropAspect / crop rect changes are handled by the overlay effect inside useCrop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePhoto?.id, activeSettings, cropApplied, showOriginalPreview, cropMode])

  /* ---- Export ---- */
  /** Builds one photo "card" (processed, cropped, fitted to the photo opening).
   *  Used by both the real export and the export preview, so they always match. */
  const buildCard: BuildCard = useCallback(
    async (photo, targetWidth, targetHeight, { preview, blurRadius }) => {
      const image = await loadImageResource(photo.url)
      const source = preview ? getOrCreateProxy(photo, image) : image
      const processed = await renderProcessedImageAsync(source, settingsByPhoto[photo.id] ?? NEUTRAL_SETTINGS, {
        channel: 'export',
      })
      const appliedCrop = cropAppliedByPhoto[photo.id] ?? null
      const cropped = appliedCrop ? createCroppedCanvas(processed, appliedCrop) : processed

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
      // PDF pages use JPEG: embedding is a straight copy (PNG must be decoded) and the file stays far smaller.
      const mime = exportFormat === 'png' ? 'image/png' : exportFormat === 'webp' ? 'image/webp' : 'image/jpeg'
      const fileName = `${PRESETS[preset].label.toLowerCase().replace(/\s+/g, '-')}-sheet.${exportFormat}`
      const bridge = getBridge()

      if (exportFormat === 'pdf' && bridge?.saveExport) {
        const presetDefinition = PRESETS[preset]
        const pdfPages = []

        for (let i = 0; i < images.length; i += maxImagesPerPage) {
          const pageImages = images.slice(i, i + maxImagesPerPage)
          const pageLayout = buildSheetLayout(presetDefinition, pageImages.length, paperSize, {
            offsetX: exportGridOffsetX,
            offsetY: exportGridOffsetY,
          })
          const usedCols = Math.max(1, Math.ceil(pageImages.length / pageLayout.rows))
          const usedRows = usedCols > 1 ? pageLayout.rows : Math.max(1, pageImages.length)
          const gridW = usedCols * presetDefinition.frameW
          const gridH = usedRows * presetDefinition.frameH
          const pageImagesForPdf = await Promise.all(
            pageImages.map(async (image, index) => {
              const col = Math.floor(index / pageLayout.rows)
              const row = index % pageLayout.rows
              return {
                buffer: await canvasToBytes(image, 'image/jpeg', 0.95),
                x: pageLayout.marginX + col * presetDefinition.frameW + presetDefinition.offsetX,
                y: pageLayout.marginY + row * presetDefinition.frameH + presetDefinition.offsetY,
                width: presetDefinition.photoW,
                height: presetDefinition.photoH,
              }
            }),
          )
          const lines: Array<{ x1: number; y1: number; x2: number; y2: number; width: number }> = []

          for (let mark = 0; mark <= usedCols; mark += 1) {
            const x = pageLayout.marginX + mark * presetDefinition.frameW
            lines.push(
              { x1: x, y1: pageLayout.marginY - pageLayout.markLength, x2: x, y2: pageLayout.marginY, width: 2 },
              { x1: x, y1: pageLayout.marginY + gridH, x2: x, y2: pageLayout.marginY + gridH + pageLayout.markLength, width: 2 },
            )
          }
          for (let mark = 0; mark <= usedRows; mark += 1) {
            const y = pageLayout.marginY + mark * presetDefinition.frameH
            lines.push(
              { x1: pageLayout.marginX - pageLayout.markLength, y1: y, x2: pageLayout.marginX, y2: y, width: 2 },
              { x1: pageLayout.marginX + gridW, y1: y, x2: pageLayout.marginX + gridW + pageLayout.markLength, y2: y, width: 2 },
            )
          }

          pdfPages.push({
            width: pageLayout.sheetW,
            height: pageLayout.sheetH,
            images: pageImagesForPdf,
            lines,
          })
        }

        const result = await bridge.saveExport({
          mime: 'image/jpeg',
          defaultName: fileName,
          format: 'pdf',
          dpi: 300,
          pdfPages,
        })
        if (result.canceled) {
          setStatus('Export cancelled.')
          return
        }
        if (!result.ok) throw new Error(result.error ?? 'Export failed.')

        setLastOutputDir(result.filePath ?? null)
        setStatus(`Exported ${images.length} image(s) to ${result.filePath ?? 'a printable sheet'}.`)
        return
      }

      // Encode each sheet to bytes right away so the huge canvas can be freed before the next one is built.
      const buffers: ArrayBuffer[] = []
      for (let i = 0; i < images.length; i += maxImagesPerPage) {
        // The cards are already processed by buildCard, so the sheet must use NEUTRAL settings.
        const sheet = await renderSheet(images.slice(i, i + maxImagesPerPage), preset, NEUTRAL_SETTINGS, paperSize, exportAutoRotate, {
          offsetX: exportGridOffsetX,
          offsetY: exportGridOffsetY,
        })
        buffers.push(await canvasToBytes(sheet, mime, 0.95))
      }

      if (bridge?.saveExport) {
        const result = await bridge.saveExport({
          buffers,
          mime,
          defaultName: fileName,
          format: exportFormat,
          dpi: 300,
        })

        if (result.canceled) {
          setStatus('Export cancelled.')
          return
        }
        if (!result.ok) throw new Error(result.error ?? 'Export failed.')

        setLastOutputDir(result.filePath ?? null)
        setStatus(`Exported ${images.length} image(s) to ${result.filePath ?? 'a printable sheet'}.`)
        return
      }

      // Browser fallback: download each sheet as an image (PDF needs the desktop app).
      const extension = mime === 'image/png' ? 'png' : 'jpg'
      const baseName = fileName.replace(/\.[^.]+$/, '')
      buffers.forEach((bytes, idx) => {
        const anchor = document.createElement('a')
        anchor.href = URL.createObjectURL(new Blob([bytes], { type: mime }))
        anchor.download = buffers.length === 1 ? `${baseName}.${extension}` : `${baseName}-${idx + 1}.${extension}`
        anchor.click()
        setTimeout(() => URL.revokeObjectURL(anchor.href), 1000)
      })
      setLastOutputDir('browser-download')
      setStatus(`Browser export created: ${baseName}.${extension}`)
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

  /* ---- Keyboard shortcuts ---- */
  shortcutRef.current = (event) => {
    const target = event.target as HTMLElement | null
    const tag = target?.tagName
    const inputType = (target as HTMLInputElement | null)?.type
    const isRange = tag === 'INPUT' && inputType === 'range'
    const isTyping = tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && !isRange && inputType !== 'checkbox')
    const mod = event.ctrlKey || event.metaKey
    const key = event.key.toLowerCase()

    if (mod && key === 's' && !showExportDialog) {
      event.preventDefault()
      void handleSaveProject()
      return
    }

    if (mod && key === 'o' && !showExportDialog) {
      event.preventDefault()
      void handleOpenProject()
      return
    }

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

    if (
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
      !mod &&
      !isTyping &&
      !isRange &&
      !showExportDialog &&
      photos.length > 0
    ) {
      event.preventDefault()
      selectPhoto(clamp(selectedPhotoIndex + (event.key === 'ArrowLeft' ? -1 : 1), 0, photos.length - 1))
    }

    if (!mod && !isTyping && !isRange && !showExportDialog) {
      if (key === 'i') {
        event.preventDefault()
        void handleOpenNativeDialog()
        return
      }
      if (key === 'c') {
        event.preventDefault()
        toggleCropMode()
        return
      }
      if (key === 'r') {
        event.preventDefault()
        handleResetAdjustments()
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (photos.length > 0) {
          event.preventDefault()
          handleDeleteSelectedImage()
        }
        return
      }
    }
  }

  useEffect(() => {
    const listener = (event: KeyboardEvent) => shortcutRef.current(event)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  /* ---- Native menu bar actions (File / Edit menus are built in electron/main.ts) ---- */
  menuActionRef.current = (action, payload) => {
    switch (action) {
      case 'add-photos':
        void handleOpenNativeDialog()
        break
      case 'toggle-auto-import':
        setApplyAutoCorrectionOnImport(Boolean(payload))
        break
      case 'open-project':
        void handleOpenProject()
        break
      case 'save-project':
        void handleSaveProject()
        break
      case 'recover':
        void recoverAutosave()
        break
      case 'export':
        openExportDialog()
        break
      case 'undo':
        handleUndo()
        break
      case 'redo':
        handleRedo()
        break
    }
  }

  useEffect(() => {
    return getBridge()?.onMenuAction?.((action, payload) => menuActionRef.current(action, payload))
  }, [])

  /* ---- "Hold to compare" handlers (pointer capture so releasing outside the button still ends it) ---- */
  const compareHandlers = {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId)
      setShowOriginalPreview(true)
    },
    onPointerUp: () => setShowOriginalPreview(false),
    onPointerCancel: () => setShowOriginalPreview(false),
    onLostPointerCapture: () => setShowOriginalPreview(false),
  }

  /* ---- Render ---- */
  const operationSummary = buildAdjustmentOperations(activeSettings)
  const stageLabel = activePhoto ? `${photos.length} photo${photos.length === 1 ? '' : 's'} | ${activePhoto.name}` : ''

  return (
    <div className="app dark">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
        multiple
        hidden
        onChange={handleFilesSelected}
      />
      <input
        ref={projectInputRef}
        type="file"
        accept=".json,.polaroid,application/json"
        hidden
        onChange={handleProjectFileSelected}
      />

      <div className="window-shell">
        <div className="workspace-shell">
          <aside className="tool-rail">
            <div className="tool-group">
              <button title="Open Images" className="tool-button" aria-label="Open Images" onClick={handleOpenNativeDialog}>📂</button>
              <button title="Crop (Esc to leave)" className={`tool-button ${cropMode ? 'active' : ''}`} aria-label="Crop" aria-pressed={cropMode} onClick={toggleCropMode}>◧</button>
              <div className="tool-separator"></div>
              <button title="Undo (Ctrl+Z)" className="tool-button" aria-label="Undo" onClick={handleUndo} disabled={undoStack.length === 0}>↶</button>
              <button title="Redo (Ctrl+Shift+Z)" className="tool-button" aria-label="Redo" onClick={handleRedo} disabled={redoStack.length === 0}>↷</button>
              <button title="Reset Adjustments" className="tool-button" aria-label="Reset Adjustments" onClick={handleResetAdjustments}>↺</button>
              <div className="tool-separator"></div>
              <button title="Polaroid Builder" className="tool-button" aria-label="Polaroid Builder" onClick={openExportDialog}>📷</button>
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
              {...panHandlers}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault()
                handleDroppedFiles(Array.from(event.dataTransfer?.files ?? []))
              }}
            >
              <canvas
                ref={previewCanvasRef}
                className={`preview-canvas ${cropMode ? 'crop-enabled' : ''}`}
                style={{
                  cursor: cropMode ? cropCursor : isPanning ? 'grabbing' : zoom > 1 ? 'grab' : 'default',
                  transform: `translate(calc(-50% + ${panOffset.x}px), calc(-50% + ${panOffset.y}px)) scale(${zoom})`,
                }}
                {...canvasHandlers}
              />
            </div>

            <div className="preview-controls">
              <button title="Rotate Left" className="preview-btn" aria-label="Rotate Left" onClick={() => handleRotatePhoto(-90)} disabled={!activePhoto}>↺</button>
              <button title="Rotate Right" className="preview-btn" aria-label="Rotate Right" onClick={() => handleRotatePhoto(90)} disabled={!activePhoto}>↻</button>
              <div className="preview-spacer"></div>
              <button title="Fit to Window" className="preview-btn" aria-label="Fit to Window" onClick={fitPreview}>Fit to Window</button>
              <button title="Zoom 100%" className="preview-btn" aria-label="Zoom 100%" onClick={() => setZoomLevel(1)}>Zoom 100%</button>
              <button title="Zoom 50%" className="preview-btn" aria-label="Zoom 50%" onClick={() => setZoomLevel(0.5)}>Zoom 50%</button>
              <div className="preview-spacer"></div>
              <button
                title="Hold to compare with the original"
                className={`preview-btn compare-button ${showOriginalPreview ? 'active' : ''}`}
                aria-label="Compare Original"
                aria-pressed={showOriginalPreview}
                disabled={!activePhoto}
                {...compareHandlers}
              >
                Compare Original
              </button>
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
                  {...compareHandlers}
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
                  onInteractionStart={() => recordHistory()}
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
          {lastAutosave ? (
            <>
              <span className="status-divider">|</span>
              <span title={lastAutosave.target}>Autosaved {lastAutosave.time}</span>
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
