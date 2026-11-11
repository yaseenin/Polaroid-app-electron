import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, net, type MenuItemConstructorOptions } from 'electron'
import { PDFDocument, rgb } from 'pdf-lib'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'polaroid-file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
])

const __dirname = path.dirname(fileURLToPath(import.meta.url))
process.env.APP_ROOT = path.join(__dirname, '..')

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

let win: BrowserWindow | null

type PdfExportPage = {
  width: number
  height: number
  images: Array<{ buffer: ArrayBuffer; x: number; y: number; width: number; height: number }>
  lines: Array<{ x1: number; y1: number; x2: number; y2: number; width: number }>
}

type SaveExportPayload = {
  buffers?: ArrayBuffer[]
  dataUrls?: string[]
  defaultName: string
  format?: string
  dpi?: number
  pdfPages?: PdfExportPage[]
}

// ---- DPI metadata injection for raster exports ----

const crc32Table = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
  }
  crc32Table[i] = c
}

function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) {
    crc = crc32Table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function injectPngDpi(buffer: Buffer, dpi: number): Buffer {
  const ppm = Math.round(dpi * 39.3700787) // pixels per meter

  const signature = buffer.subarray(0, 8)
  const rest = buffer.subarray(8)

  // Find end of IHDR chunk to insert pHys after it
  let offset = 0
  let ihdrEnd = 0
  while (offset + 8 <= rest.length) {
    const length = rest.readUInt32BE(offset)
    const type = rest.subarray(offset + 4, offset + 8).toString('latin1')
    const chunkEnd = offset + 12 + length
    if (type === 'IHDR') {
      ihdrEnd = chunkEnd
      break
    }
    offset = chunkEnd
  }

  const data = Buffer.alloc(9)
  data.writeUInt32BE(ppm, 0)
  data.writeUInt32BE(ppm, 4)
  data[8] = 1 // unit specifier: meter

  const type = Buffer.from('pHys')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(9, 0)

  const crcInput = Buffer.concat([type, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(crcInput), 0)

  const pHysChunk = Buffer.concat([length, type, data, crc])

  return Buffer.concat([signature, rest.subarray(0, ihdrEnd), pHysChunk, rest.subarray(ihdrEnd)])
}

function injectJpegDpi(buffer: Buffer, dpi: number): Buffer {
  const app0Data = Buffer.alloc(14)
  app0Data.write('JFIF\0', 0, 'latin1')
  app0Data[5] = 1 // version major
  app0Data[6] = 1 // version minor
  app0Data[7] = 1 // density units: 1 = dots per inch
  app0Data.writeUInt16BE(dpi, 8) // Xdensity
  app0Data.writeUInt16BE(dpi, 10) // Ydensity
  app0Data[12] = 0 // thumbnail width
  app0Data[13] = 0 // thumbnail height

  const app0Length = Buffer.alloc(2)
  app0Length.writeUInt16BE(16, 0) // 2 (length field) + 14 (data)

  const app0Segment = Buffer.concat([Buffer.from([0xFF, 0xE0]), app0Length, app0Data])

  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xD8) {
    if (buffer.length >= 4 && buffer[2] === 0xFF && buffer[3] === 0xE0) {
      // APP0 already exists, replace it
      const existingLength = buffer.readUInt16BE(4)
      const existingEnd = 4 + existingLength
      return Buffer.concat([app0Segment, buffer.subarray(existingEnd)])
    }
    // Insert APP0 after SOI
    return Buffer.concat([buffer.subarray(0, 2), app0Segment, buffer.subarray(2)])
  }

  return buffer
}

function convertHeicToJpegCached(filePath: string): string {
  const cacheDir = path.join(os.tmpdir(), 'polaroid_heic_cache')
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true })
  }

  const stat = fs.statSync(filePath)
  const hashName = `${path.basename(filePath)}_${stat.size}_${Math.round(stat.mtimeMs)}.jpg`
  const cachedPath = path.join(cacheDir, hashName)

  if (fs.existsSync(cachedPath)) {
    return cachedPath
  }

  if (process.platform === 'darwin') {
    const res = spawnSync('/usr/bin/sips', ['-s', 'format', 'jpeg', filePath, '--out', cachedPath], {
      encoding: 'utf8',
    })
    if (res.status === 0 && fs.existsSync(cachedPath)) {
      return cachedPath
    }
  }

  return filePath
}

async function fileToDataUrlAsync(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase()
  let targetPath = filePath
  if (ext === '.heic' || ext === '.heif') {
    targetPath = convertHeicToJpegCached(filePath)
  }

  const buffer = await fs.promises.readFile(targetPath)
  const targetExt = path.extname(targetPath).toLowerCase()
  const mime = targetExt === '.png'
    ? 'image/png'
    : targetExt === '.webp'
      ? 'image/webp'
      : 'image/jpeg'

  return `data:${mime};base64,${buffer.toString('base64')}`
}

function fileToDataUrl(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  let targetPath = filePath
  if (ext === '.heic' || ext === '.heif') {
    targetPath = convertHeicToJpegCached(filePath)
  }

  const buffer = fs.readFileSync(targetPath)
  const targetExt = path.extname(targetPath).toLowerCase()
  const mime = targetExt === '.png'
    ? 'image/png'
    : targetExt === '.webp'
      ? 'image/webp'
      : 'image/jpeg'

  return `data:${mime};base64,${buffer.toString('base64')}`
}

ipcMain.handle('open-image-dialog', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Select images',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'heic', 'heif'] }],
  })

  if (canceled || !filePaths.length) {
    return {
      canceled: true,
      filePaths: [],
      dataUrls: [],
    }
  }

  const dataUrls = await Promise.all(filePaths.map(fileToDataUrlAsync))

  return {
    canceled: false,
    filePaths,
    dataUrls,
  }
})

ipcMain.handle('open-project', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Open Polaroid project',
    properties: ['openFile'],
    filters: [{ name: 'Polaroid Project', extensions: ['polaroid', 'json'] }],
  })

  if (canceled || !filePaths[0]) {
    return { canceled: true }
  }

  try {
    const project = JSON.parse(await fs.promises.readFile(filePaths[0], 'utf8')) as {
      photos?: Array<{ name?: string; path?: string; cropApplied?: unknown; dataUrl?: string }>
    }
    if (!Array.isArray(project.photos)) {
      throw new Error('This file does not contain a valid Polaroid project.')
    }

    const photos = project.photos.map((photo) => {
      if (photo.dataUrl) {
        return { ...photo, path: photo.path ?? '', dataUrl: photo.dataUrl }
      }
      if (!photo.path || !fs.existsSync(photo.path)) {
        throw new Error(`Project photo is missing: ${photo.path ?? photo.name ?? 'unknown image'}`)
      }
      return { ...photo, path: photo.path, dataUrl: fileToDataUrl(photo.path) }
    })

    return { canceled: false, project: { ...project, photos } }
  } catch (error) {
    return { canceled: false, error: error instanceof Error ? error.message : 'Unable to open project.' }
  }
})

ipcMain.handle('save-project', async (_event, project: unknown) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Save Polaroid project',
    defaultPath: 'Polaroid Project.polaroid',
    filters: [{ name: 'Polaroid Project', extensions: ['polaroid'] }],
  })

  if (canceled || !filePath) {
    return { ok: false, canceled: true }
  }

  const normalizedPath = filePath.toLowerCase().endsWith('.polaroid') ? filePath : `${filePath}.polaroid`
  await fs.promises.writeFile(normalizedPath, JSON.stringify(project, null, 2), 'utf8')
  return { ok: true, filePath: normalizedPath }
})

ipcMain.handle('autosave-project', async (_event, payload: { dir: string; fileName: string; project: unknown }) => {
  try {
    const targetDir = payload.dir
    if (!fs.existsSync(targetDir)) {
      await fs.promises.mkdir(targetDir, { recursive: true })
    }
    const targetPath = path.join(targetDir, payload.fileName)
    await fs.promises.writeFile(targetPath, JSON.stringify(payload.project, null, 2), 'utf8')
    return { ok: true, filePath: targetPath }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Autosave failed.' }
  }
})

ipcMain.handle('save-export', async (_event, payload: SaveExportPayload) => {
  const format = payload.format ?? 'png'
  const extension = format === 'jpeg' ? 'jpg' : format === 'pdf' ? 'pdf' : format === 'webp' ? 'webp' : 'png'
  const defaultName = payload.defaultName.endsWith(`.${extension}`) ? payload.defaultName : `${payload.defaultName.replace(/\.[^.]+$/, '') || 'export'}.${extension}`

  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Save print sheet',
    defaultPath: defaultName,
    filters: [{
      name: format === 'pdf' ? 'PDF Document' : format === 'jpeg' ? 'JPEG Image' : format === 'webp' ? 'WebP Image' : 'PNG Image',
      extensions: [extension],
    }],
  })

  if (canceled || !filePath) {
    return { ok: false, canceled: true }
  }

  const normalizedPath = filePath.toLowerCase().endsWith(`.${extension}`) ? filePath : `${filePath}.${extension}`
  
  // Convert buffers or dataUrls into Buffer array
  let nodeBuffers: Buffer[] = []
  if (Array.isArray(payload.buffers) && payload.buffers.length > 0) {
    nodeBuffers = payload.buffers.map((buf) => Buffer.from(buf))
  } else if (Array.isArray(payload.dataUrls) && payload.dataUrls.length > 0) {
    nodeBuffers = payload.dataUrls.map((dataUrl) => {
      const matches = dataUrl.match(/^data:image\/[^;]+;base64,(.+)$/)
      const base64 = matches ? matches[1] : dataUrl.replace(/^data:image\/.*;base64,/, '')
      return Buffer.from(base64, 'base64')
    })
  }

  if (nodeBuffers.length === 0 && !(format === 'pdf' && payload.pdfPages?.length)) {
    return { ok: false, error: 'No image data to save.' }
  }

  if (format === 'pdf') {
    const pdfDoc = await PDFDocument.create()
    const pointsPerPixel = 72 / Math.max(1, payload.dpi ?? 300)

    if (payload.pdfPages?.length) {
      for (const pageData of payload.pdfPages) {
        const pageWidth = pageData.width * pointsPerPixel
        const pageHeight = pageData.height * pointsPerPixel
        const page = pdfDoc.addPage([pageWidth, pageHeight])
        page.drawRectangle({
          x: 0,
          y: 0,
          width: pageWidth,
          height: pageHeight,
          color: rgb(1, 1, 1),
        })

        for (const imageData of pageData.images) {
          const imageBuffer = Buffer.from(imageData.buffer)
          const image = imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50
            ? await pdfDoc.embedPng(imageBuffer)
            : await pdfDoc.embedJpg(imageBuffer)
          page.drawImage(image, {
            x: imageData.x * pointsPerPixel,
            y: pageHeight - (imageData.y + imageData.height) * pointsPerPixel,
            width: imageData.width * pointsPerPixel,
            height: imageData.height * pointsPerPixel,
          })
        }

        for (const line of pageData.lines) {
          page.drawLine({
            start: { x: line.x1 * pointsPerPixel, y: pageHeight - line.y1 * pointsPerPixel },
            end: { x: line.x2 * pointsPerPixel, y: pageHeight - line.y2 * pointsPerPixel },
            thickness: line.width * pointsPerPixel,
            color: rgb(0, 0, 0),
          })
        }
      }

      const pdfBytes = await pdfDoc.save()
      await fs.promises.writeFile(normalizedPath, pdfBytes)
      return { ok: true, filePath: normalizedPath }
    }

    for (const imageBytes of nodeBuffers) {
      // Check if image is PNG or JPEG by magic bytes or fallback
      const isPng = imageBytes[0] === 0x89 && imageBytes[1] === 0x50
      const image = isPng ? await pdfDoc.embedPng(imageBytes) : await pdfDoc.embedJpg(imageBytes)
      const page = pdfDoc.addPage([image.width * pointsPerPixel, image.height * pointsPerPixel])
      const scale = Math.min(page.getWidth() / image.width, page.getHeight() / image.height)
      const width = image.width * scale
      const height = image.height * scale
      page.drawImage(image, {
        x: (page.getWidth() - width) / 2,
        y: (page.getHeight() - height) / 2,
        width,
        height,
      })
    }

    const pdfBytes = await pdfDoc.save()
    await fs.promises.writeFile(normalizedPath, pdfBytes)
    return { ok: true, filePath: normalizedPath }
  }

  const dpi = Math.max(1, payload.dpi ?? 300)

  for (let i = 0; i < nodeBuffers.length; i++) {
    const p = nodeBuffers.length === 1 ? normalizedPath : normalizedPath.replace(new RegExp(`\\.${extension}$`, 'i'), `-${i + 1}.${extension}`)
    const buffer = format === 'png' ? injectPngDpi(nodeBuffers[i], dpi) : format === 'jpeg' ? injectJpegDpi(nodeBuffers[i], dpi) : nodeBuffers[i]
    await fs.promises.writeFile(p, buffer)
  }

  return { ok: true, filePath: normalizedPath }
})

function sendMenuAction(action: string, payload?: unknown) {
  win?.webContents.send('menu-action', action, payload)
}

function buildAppMenu() {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'Add Photos', click: () => sendMenuAction('add-photos') },
        {
          label: 'Auto-correct import',
          type: 'checkbox',
          checked: false,
          click: (item) => sendMenuAction('toggle-auto-import', item.checked),
        },
        { type: 'separator' },
        // registerAccelerator:false = shown in the menu, but App.tsx's own Ctrl+S / Ctrl+O handler does the work (no double trigger)
        { label: 'Open Project', accelerator: 'CmdOrCtrl+O', registerAccelerator: false, click: () => sendMenuAction('open-project') },
        { label: 'Save Project', accelerator: 'CmdOrCtrl+S', registerAccelerator: false, click: () => sendMenuAction('save-project') },
        { label: 'Recover Autosave', click: () => sendMenuAction('recover') },
        { type: 'separator' },
        { label: 'Export…', click: () => sendMenuAction('export') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', registerAccelerator: false, click: () => sendMenuAction('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', registerAccelerator: false, click: () => sendMenuAction('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { label: 'Help', submenu: [{ role: 'toggleDevTools' }] },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
function createWindow() {
  win = new BrowserWindow({
    icon: path.join(process.env.VITE_PUBLIC, 'electron-vite.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      webSecurity: false,
    },
  })

  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', new Date().toLocaleString())
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(() => {
  protocol.handle('polaroid-file', async (request) => {
    try {
      // URL format: polaroid-file://local/<encodedFilePath>
      const parsed = new URL(request.url)
      const pathname = parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname
      const rawPath = decodeURIComponent(pathname)
      const ext = path.extname(rawPath).toLowerCase()

      let finalPath = rawPath
      if (ext === '.heic' || ext === '.heif') {
        finalPath = convertHeicToJpegCached(rawPath)
      }

      return await net.fetch(pathToFileURL(finalPath).toString())
    } catch (err) {
      return new Response(`Failed to load file: ${err instanceof Error ? err.message : String(err)}`, { status: 404 })
    }
  })

  buildAppMenu()
  createWindow()
})
