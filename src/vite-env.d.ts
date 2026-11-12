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
          images: Array<{ buffer: ArrayBuffer; x: number; y: number; width: number; height: number; rotationDeg?: number }>
          lines: Array<{ x1: number; y1: number; x2: number; y2: number; width: number; color?: string; dashArray?: number[] }>
          vectors?: Array<{ path: string; fill: string | null; stroke: string | null; strokeWidth: number; dashArray?: number[] }>
          text?: Array<{ text: string; x: number; y: number; fontSize: number; color: string; rotationDeg: number; centerX: number; centerY: number }>
        }>
      }) => Promise<{ ok: boolean; canceled?: boolean; filePath?: string }>
      openPrintPreview?: (payload: {
        pages: Array<{
          width: number
          height: number
          images: Array<{ buffer: ArrayBuffer; x: number; y: number; width: number; height: number; rotationDeg?: number }>
          lines: Array<{ x1: number; y1: number; x2: number; y2: number; width: number; color?: string; dashArray?: number[] }>
          vectors?: Array<{ path: string; fill: string | null; stroke: string | null; strokeWidth: number; dashArray?: number[] }>
          text?: Array<{ text: string; x: number; y: number; fontSize: number; color: string; rotationDeg: number; centerX: number; centerY: number }>
        }>
        dpi: number
      }) => Promise<{ ok: boolean; error?: string }>
      listPrinters?: () => Promise<{
        printers: Array<{ name: string; displayName: string; isDefault: boolean }>
        error?: string
      }>
      getPrinterPaperSizes?: (printerName: string) => Promise<{
        paperSizes: Array<{ name: string; width: number; height: number }>
        error?: string
      }>
      printPreviewPage?: (options: {
        printerName: string
        paperWidth: number
        paperHeight: number
        copies: number
        color: boolean
        duplexMode: 'simplex' | 'shortEdge' | 'longEdge'
      }) => Promise<{ ok: boolean; error?: string }>
      closePrintPreview?: () => Promise<void>
    }
  }
}

export {}
