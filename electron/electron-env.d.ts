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
    openProject: () => Promise<{
      canceled: boolean
      project?: {
        photos?: Array<{ name?: string; path?: string; dataUrl?: string; cropApplied?: unknown }>
        [key: string]: unknown
      }
      error?: string
    }>
    saveProject: (project: unknown) => Promise<{ ok: boolean; canceled?: boolean; filePath?: string }>
    saveExport: (payload: { dataUrl: string; defaultName: string; format?: 'png' | 'jpeg' | 'pdf'; dpi?: number }) => Promise<{ ok: boolean; canceled?: boolean; filePath?: string }>
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
