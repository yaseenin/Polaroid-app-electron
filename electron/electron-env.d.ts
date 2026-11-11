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
    saveExport: (payload: {
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
