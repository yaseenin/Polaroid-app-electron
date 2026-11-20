import type { AdjustmentSettings, ExportFillOrder, PaperSizeKey, PresetKey } from './engine/polaroidEngine'

export type Photo = {
  id: number
  name: string
  url: string
  path: string
  thumbnailUrl?: string
  width?: number
  height?: number
}

export type NativeImagePickerResult = {
  canceled: boolean
  filePaths: string[]
  dataUrls?: string[]
}

export type CropStep = {
  x: number
  y: number
  width: number
  height: number
  rotation: number
  /** Rotate into an expanded canvas before applying the crop rectangle. */
  expand?: boolean
}
export type CropApplied = {
  x: number
  y: number
  width: number
  height: number
  rotation: number
  /** Sequential straighten-and-crop operations applied after the original crop. */
  steps?: CropStep[]
}
export type CropRect = { x: number; y: number; width: number; height: number }
export type CropHandle = 'nw' | 'ne' | 'sw' | 'se'
export type CropAspect = 'Free' | 'Square' | 'Mini' | 'Wide' | 'Custom'
export type CropGuide = 'Thirds' | 'Center' | 'Golden Ratio' | 'None'
export type CropCursor = 'crosshair' | 'move' | 'nwse-resize' | 'nesw-resize'

export type ExportFormat = 'png' | 'jpeg' | 'webp' | 'pdf'
export type ExportOrientation = 'portrait' | 'landscape'

export type EditorSnapshot = {
  /** Photo whose settings this snapshot holds (settings are per photo). */
  photoId: number | null
  settings: AdjustmentSettings
  cropAppliedByPhoto: Record<number, CropApplied | null>
  cropRotation: number
}

export type SavedProject = {
  version: 1
  photos: Array<{
    name: string
    path: string
    cropApplied: CropApplied | null
    /** Per-photo settings. Older project files only have the top-level `settings`. */
    settings?: AdjustmentSettings
    dataUrl?: string
  }>
  /** Kept for backward compatibility with older project files. */
  settings?: AdjustmentSettings
  preset: PresetKey
  paperSize: PaperSizeKey
  selectedPhotoIndex: number
  exportFormat: ExportFormat
  exportPageCount: number
  exportOrientation: ExportOrientation
  exportAutoRotate: boolean
  exportFillOrder?: ExportFillOrder
  exportJobCard?: boolean
  /** Manual grid offset applied on top of the centered layout (in sheet pixels). */
  exportGridOffsetX: number
  exportGridOffsetY: number
}

export type BuildCardOptions = {
  /** true = use the downscaled preview proxy instead of the full-resolution image */
  preview: boolean
  blurRadius?: number
}

export type BuildCard = (
  photo: Photo,
  targetWidth: number,
  targetHeight: number,
  options: BuildCardOptions,
) => Promise<HTMLCanvasElement>
