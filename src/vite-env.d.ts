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
      saveExport?: (payload: { dataUrl: string; defaultName: string; format?: 'png' | 'jpeg' | 'pdf'; dpi?: number }) => Promise<{ ok: boolean; canceled?: boolean; filePath?: string }>
      processImages: (request: {
        files: string[]
        outputDir?: string
        settings?: {
          exposure?: number
          brightness?: number
          contrast?: number
          gamma?: number
          saturation?: number
          sharpen?: number
          temperature?: number
          vignette?: number
          autoRotate?: boolean
          format?: 'jpeg' | 'jpg' | 'pdf'
          dpi?: number
        }
      }) => Promise<{
        ok: boolean
        outputDir?: string
        files?: string[]
        message?: string
        error?: string
      }>
    }
  }
}

export {}
