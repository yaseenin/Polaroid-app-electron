/// <reference types="vite/client" />

declare global {
  interface Window {
    polaroidEngine?: {
      openImagePicker?: () => Promise<{ canceled: boolean; filePaths: string[] }>
      openProject?: () => Promise<{
        canceled: boolean
        project?: {
          photos?: Array<{ name?: string; path?: string; dataUrl?: string; cropApplied?: unknown }>
          [key: string]: unknown
        }
        error?: string
      }>
      saveProject?: (project: unknown) => Promise<{ ok: boolean; canceled?: boolean; filePath?: string }>
      saveExport?: (payload: {
        buffers?: ArrayBuffer[]
        dataUrls?: string[]
        defaultName: string
        format?: 'png' | 'jpeg' | 'pdf'
        dpi?: number
        pdfPages?: Array<{
          width: number
          height: number
          images: Array<{ buffer: ArrayBuffer; x: number; y: number; width: number; height: number }>
          lines: Array<{ x1: number; y1: number; x2: number; y2: number; width: number }>
        }>
      }) => Promise<{ ok: boolean; canceled?: boolean; filePath?: string }>
    }
  }
}

export {}
