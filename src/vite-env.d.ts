/// <reference types="vite/client" />

declare global {
  interface Window {
    polaroidEngine?: {
      openImagePicker?: () => Promise<{ canceled: boolean; filePaths: string[] }>
      saveExport?: (payload: { dataUrl: string; defaultName: string; format?: 'png' | 'jpeg' | 'pdf' }) => Promise<{ ok: boolean; canceled?: boolean; filePath?: string }>
      processImages: (request: {
        files: string[]
        outputDir?: string
        settings?: {
          exposure?: number
          contrast?: number
          gamma?: number
          sharpen?: number
          autoRotate?: boolean
          format?: 'jpeg' | 'jpg' | 'pdf'
          dpi?: number
        }
      }) => Promise<{
        ok: boolean
        outputDir?: string
        message?: string
        error?: string
      }>
    }
  }
}

export {}
