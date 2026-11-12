/** Scheme registered in electron/main.ts. Photos are streamed from disk instead of sent as base64. */
export const APP_FILE_SCHEME = 'polaroid-file'

export function toAppFileUrl(filePath: string): string {
  return `${APP_FILE_SCHEME}://local/${encodeURIComponent(filePath)}`
}

/** Folder part of an absolute file path, or null when the path has no folder (e.g. only a file name). */
export function getFolderOf(filePath: string | undefined): string | null {
  if (!filePath || /^(blob|data|https?):/i.test(filePath) || filePath.startsWith(`${APP_FILE_SCHEME}:`)) return null
  const index = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  if (index <= 0) return null
  const dir = filePath.slice(0, index)
  return /^[A-Za-z]:$/.test(dir) ? dir + filePath[index] : dir
}

export type PickerResult = { canceled: boolean; filePaths: string[] }
export type SaveResult = { ok: boolean; canceled?: boolean; filePath?: string; error?: string }
export type OpenProjectResult = { canceled: boolean; project?: unknown; error?: string }
export type PdfVectorPayload = {
  path: string
  fill: string | null
  stroke: string | null
  strokeWidth: number
  dashArray?: number[]
}
export type PdfTextPayload = {
  text: string
  x: number
  y: number
  fontSize: number
  color: string
  rotationDeg: number
  centerX: number
  centerY: number
}
export type SheetPagePayload = {
  width: number
  height: number
  images: Array<{ buffer: ArrayBuffer; x: number; y: number; width: number; height: number; rotationDeg?: number }>
  lines: Array<{ x1: number; y1: number; x2: number; y2: number; width: number; color?: string; dashArray?: number[] }>
  vectors?: PdfVectorPayload[]
  text?: PdfTextPayload[]
}
export type PrinterPaperSize = { name: string; width: number; height: number }
export type PrinterOption = { name: string; displayName: string; isDefault: boolean }
export type PrintJobOptions = {
  printerName: string
  paperWidth: number
  paperHeight: number
  copies: number
  color: boolean
  duplexMode: 'simplex' | 'shortEdge' | 'longEdge'
}

export type ExportPayload = {
  /** One encoded image (PNG, JPEG, or WebP bytes) per sheet. */
  buffers?: ArrayBuffer[]
  mime: 'image/png' | 'image/jpeg' | 'image/webp'
  defaultName: string
  format: string
  dpi: number
  pdfPages?: SheetPagePayload[]
}

/** Everything the preload script exposes as `window.polaroidEngine`. */
export type Bridge = {
  openImagePicker?: () => Promise<PickerResult>
  openProject?: () => Promise<OpenProjectResult>
  saveProject?: (project: unknown) => Promise<SaveResult>
  saveExport?: (payload: ExportPayload) => Promise<SaveResult>
  openPrintPreview?: (payload: { pages: SheetPagePayload[]; dpi: number }) => Promise<SaveResult>
  listPrinters?: () => Promise<{ printers: PrinterOption[]; error?: string }>
  getPrinterPaperSizes?: (printerName: string) => Promise<{ paperSizes: PrinterPaperSize[]; error?: string }>
  printPreviewPage?: (options: PrintJobOptions) => Promise<SaveResult>
  autosaveProject?: (payload: { dir: string; fileName: string; project: unknown }) => Promise<SaveResult>
  getPathForFile?: (file: File) => string
  onMenuAction?: (callback: (action: string, payload?: unknown) => void) => () => void
}

export const getBridge = (): Bridge | undefined =>
  (window as unknown as { polaroidEngine?: Bridge }).polaroidEngine
