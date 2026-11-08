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

export type ExportPayload = {
  /** One encoded image (PNG, JPEG, or WebP bytes) per sheet. */
  buffers: ArrayBuffer[]
  mime: 'image/png' | 'image/jpeg' | 'image/webp'
  defaultName: string
  format: string
  dpi: number
}

/** Everything the preload script exposes as `window.polaroidEngine`. */
export type Bridge = {
  openImagePicker?: () => Promise<PickerResult>
  openProject?: () => Promise<OpenProjectResult>
  saveProject?: (project: unknown) => Promise<SaveResult>
  saveExport?: (payload: ExportPayload) => Promise<SaveResult>
  autosaveProject?: (payload: { dir: string; fileName: string; project: unknown }) => Promise<SaveResult>
  getPathForFile?: (file: File) => string
  onMenuAction?: (callback: (action: string, payload?: unknown) => void) => () => void
}

export const getBridge = (): Bridge | undefined =>
  (window as unknown as { polaroidEngine?: Bridge }).polaroidEngine
