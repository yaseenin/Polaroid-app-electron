import { ipcRenderer, contextBridge, webUtils } from 'electron'

contextBridge.exposeInMainWorld('ipcRenderer', {
  on(...args: Parameters<typeof ipcRenderer.on>) {
    const [channel, listener] = args
    return ipcRenderer.on(channel, (event, ...rest) => listener(event, ...rest))
  },
  off(...args: Parameters<typeof ipcRenderer.off>) {
    const [channel, ...omit] = args
    return ipcRenderer.off(channel, ...omit)
  },
  send(...args: Parameters<typeof ipcRenderer.send>) {
    const [channel, ...omit] = args
    return ipcRenderer.send(channel, ...omit)
  },
  invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
    const [channel, ...omit] = args
    return ipcRenderer.invoke(channel, ...omit)
  },
})

contextBridge.exposeInMainWorld('polaroidEngine', {
  getPathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return (file as File & { path?: string }).path || ''
    }
  },
  onMenuAction: (callback: (action: string, payload?: unknown) => void) => {
    const handler = (_event: unknown, action: string, payload?: unknown) => callback(action, payload)
    ipcRenderer.on('menu-action', handler)
    return () => {
      ipcRenderer.removeListener('menu-action', handler)
    }
  },
  openImagePicker: () => ipcRenderer.invoke('open-image-dialog') as Promise<{
    canceled: boolean
    filePaths: string[]
    dataUrls?: string[]
  }>,
  openProject: () => ipcRenderer.invoke('open-project') as Promise<{
    canceled: boolean
    project?: {
      photos?: Array<{ name?: string; path?: string; dataUrl?: string; cropApplied?: unknown }>
      [key: string]: unknown
    }
    error?: string
  }>,
  saveProject: (project: unknown) => ipcRenderer.invoke('save-project', project) as Promise<{
    ok: boolean
    canceled?: boolean
    filePath?: string
  }>,
  autosaveProject: (payload: { dir: string; fileName: string; project: unknown }) =>
    ipcRenderer.invoke('autosave-project', payload) as Promise<{
      ok: boolean
      filePath?: string
      error?: string
    }>,
  saveExport: (payload: {
    buffers?: ArrayBuffer[]
    dataUrls?: string[]
    defaultName: string
    format?: string
    dpi?: number
    pdfPages?: Array<{
      width: number
      height: number
      images: Array<{ buffer: ArrayBuffer; x: number; y: number; width: number; height: number }>
      lines: Array<{ x1: number; y1: number; x2: number; y2: number; width: number }>
    }>
  }) =>
    ipcRenderer.invoke('save-export', payload) as Promise<{
      ok: boolean
      canceled?: boolean
      filePath?: string
      error?: string
    }>,
})
