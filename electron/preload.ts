import { ipcRenderer, contextBridge } from 'electron'

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
  openImagePicker: () => ipcRenderer.invoke('open-image-dialog') as Promise<{
    canceled: boolean
    filePaths: string[]
    dataUrls?: string[]
  }>,
  saveExport: (payload: { dataUrl: string; defaultName: string; format?: 'png' | 'jpeg' }) => ipcRenderer.invoke('save-export', payload),
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
  }) => ipcRenderer.invoke('rust:process', request),
})
