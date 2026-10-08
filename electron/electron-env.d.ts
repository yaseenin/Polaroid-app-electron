/// <reference types="vite-plugin-electron/electron-env" />

declare namespace NodeJS {
  interface ProcessEnv {
    /**
     * The built directory structure
     *
     * ```tree
     * ├─┬─┬ dist
     * │ │ └── index.html
     * │ │
     * │ ├─┬ dist-electron
     * │ │ ├── main.js
     * │ │ └── preload.js
     * │
     * ```
     */
    APP_ROOT: string
    /** /dist/ or /public/ */
    VITE_PUBLIC: string
  }
}

// Used in Renderer process, expose in `preload.ts`
interface Window {
  ipcRenderer: import('electron').IpcRenderer
  polaroidEngine: {
    openImagePicker: () => Promise<{ canceled: boolean; filePaths: string[] }>
    saveExport: (payload: { dataUrl: string; defaultName: string; format?: 'png' | 'jpeg' }) => Promise<{ ok: boolean; canceled?: boolean; filePath?: string }>
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
