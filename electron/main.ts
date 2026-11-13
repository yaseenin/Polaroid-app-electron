import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, net, type MenuItemConstructorOptions } from 'electron'
import { PDFDocument, degrees, rgb } from 'pdf-lib'
import { execFile, spawnSync } from 'node:child_process'
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
  images: Array<{ buffer: ArrayBuffer; x: number; y: number; width: number; height: number; rotationDeg?: number }>
  lines: Array<{ x1: number; y1: number; x2: number; y2: number; width: number; color?: string; dashArray?: number[] }>
  vectors?: Array<{ path: string; fill: string | null; stroke: string | null; strokeWidth: number; dashArray?: number[] }>
  text?: Array<{ text: string; x: number; y: number; fontSize: number; color: string; rotationDeg: number; centerX: number; centerY: number }>
}

type SaveExportPayload = {
  buffers?: ArrayBuffer[]
  dataUrls?: string[]
  defaultName: string
  format?: string
  dpi?: number
  pdfPages?: PdfExportPage[]
}

type PrintPreviewPayload = {
  pages: PdfExportPage[]
  dpi: number
}

type PrinterPaperSize = { name: string; width: number; height: number }
type PrintJobOptions = {
  printerName: string
  paperWidth: number
  paperHeight: number
  copies: number
  color: boolean
  duplexMode: 'simplex' | 'shortEdge' | 'longEdge'
}

let printPreviewWindow: BrowserWindow | null = null

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

function pdfColorFromHex(value?: string) {
  const match = value?.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i)
  if (!match) return rgb(0, 0, 0)
  return rgb(
    Number.parseInt(match[1], 16) / 255,
    Number.parseInt(match[2], 16) / 255,
    Number.parseInt(match[3], 16) / 255,
  )
}

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
    pdfDoc.setTitle(payload.defaultName.replace(/\.pdf$/i, ''))
    pdfDoc.setCreator('Polaroid Imposition Builder')
    pdfDoc.setProducer('Polaroid App')
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
          const rotation = -(imageData.rotationDeg ?? 0) * Math.PI / 180
          const imageWidth = imageData.width * pointsPerPixel
          const imageHeight = imageData.height * pointsPerPixel
          const centerX = (imageData.x + imageData.width / 2) * pointsPerPixel
          const centerY = pageHeight - (imageData.y + imageData.height / 2) * pointsPerPixel
          page.drawImage(image, {
            x: centerX - (imageWidth / 2 * Math.cos(rotation) - imageHeight / 2 * Math.sin(rotation)),
            y: centerY - (imageWidth / 2 * Math.sin(rotation) + imageHeight / 2 * Math.cos(rotation)),
            width: imageWidth,
            height: imageHeight,
            rotate: degrees(-(imageData.rotationDeg ?? 0)),
          })
        }

        for (const line of pageData.lines) {
          page.drawLine({
            start: { x: line.x1 * pointsPerPixel, y: pageHeight - line.y1 * pointsPerPixel },
            end: { x: line.x2 * pointsPerPixel, y: pageHeight - line.y2 * pointsPerPixel },
            thickness: line.width * pointsPerPixel,
            color: pdfColorFromHex(line.color),
            dashArray: line.dashArray?.map((value) => value * pointsPerPixel),
          })
        }
        for (const vector of pageData.vectors ?? []) {
          page.drawSvgPath(vector.path, {
            x: 0,
            y: pageHeight,
            scale: pointsPerPixel,
            color: vector.fill ? pdfColorFromHex(vector.fill) : undefined,
            borderColor: vector.stroke ? pdfColorFromHex(vector.stroke) : undefined,
            borderWidth: vector.stroke ? vector.strokeWidth * pointsPerPixel : undefined,
            borderDashArray: vector.dashArray?.map((value) => value * pointsPerPixel),
          })
        }
        for (const text of pageData.text ?? []) {
          const angle = text.rotationDeg * Math.PI / 180
          const centerX = text.centerX * pointsPerPixel
          const centerY = pageHeight - text.centerY * pointsPerPixel
          const x = text.x * pointsPerPixel
          const y = pageHeight - text.y * pointsPerPixel
          const dx = x - centerX
          const dy = y - centerY
          page.drawText(text.text, {
            x: centerX + dx * Math.cos(angle) + dy * Math.sin(angle),
            y: centerY - dx * Math.sin(angle) + dy * Math.cos(angle),
            size: text.fontSize * pointsPerPixel,
            color: pdfColorFromHex(text.color),
            rotate: degrees(-text.rotationDeg),
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

function runCommand(executable: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { env, windowsHide: true, timeout: 15000 }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      resolve(stdout)
    })
  })
}

const commonPaperSizes: Record<string, { name: string; width: number; height: number }> = {
  a0: { name: 'A0', width: 841, height: 1189 },
  a1: { name: 'A1', width: 594, height: 841 },
  a2: { name: 'A2', width: 420, height: 594 },
  a3: { name: 'A3', width: 297, height: 420 },
  a4: { name: 'A4', width: 210, height: 297 },
  a5: { name: 'A5', width: 148, height: 210 },
  a6: { name: 'A6', width: 105, height: 148 },
  letter: { name: 'Letter', width: 215.9, height: 279.4 },
  na_letter: { name: 'Letter', width: 215.9, height: 279.4 },
  legal: { name: 'Legal', width: 215.9, height: 355.6 },
  na_legal: { name: 'Legal', width: 215.9, height: 355.6 },
  tabloid: { name: 'Tabloid', width: 279.4, height: 431.8 },
  ledger: { name: 'Ledger', width: 431.8, height: 279.4 },
  executive: { name: 'Executive', width: 184.15, height: 266.7 },
  '13x19': { name: '13 × 19 in', width: 330.2, height: 482.6 },
  '13x9.5': { name: '13 × 9.5 in', width: 330.2, height: 241.3 },
}

function paperSizeFromName(rawName: string): PrinterPaperSize | null {
  const name = rawName.replace(/^\*/, '').trim()
  const normalized = name.toLowerCase().replace(/[\s-]+/g, '_')
  const known = commonPaperSizes[normalized]
  if (known) return known

  const dimensions = name.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)(mm|cm|in)?/i)
  if (!dimensions) return null
  const unit = dimensions[3]?.toLowerCase() ?? 'mm'
  const multiplier = unit === 'in' ? 25.4 : unit === 'cm' ? 10 : 1
  const width = Number(dimensions[1]) * multiplier
  const height = Number(dimensions[2]) * multiplier
  return {
    name,
    width: Math.round(width * 100) / 100,
    height: Math.round(height * 100) / 100,
  }
}

async function getDriverPaperSizes(printerName: string, printerOptions: object): Promise<PrinterPaperSize[]> {
  let candidates: string[] = []

  if (process.platform === 'win32') {
    const script = [
      '$ErrorActionPreference = "Stop"',
      'Add-Type -AssemblyName System.Printing',
      '$server = New-Object System.Printing.LocalPrintServer',
      '$queue = $server.GetPrintQueue($env:POLAROID_PRINTER_NAME)',
      '$caps = $queue.GetPrintCapabilities()',
      '$sizes = @($caps.PageMediaSizeCapability | Where-Object { $_.Width -and $_.Height } | ForEach-Object {',
      '  @{ name = [string]$_.PageMediaSizeName; width = [Math]::Round($_.Width * 25.4 / 96, 2); height = [Math]::Round($_.Height * 25.4 / 96, 2) }',
      '})',
      'ConvertTo-Json -InputObject $sizes -Compress',
    ].join('; ')
    const output = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      ...process.env,
      POLAROID_PRINTER_NAME: printerName,
    })
    const parsed: unknown = JSON.parse(output.trim())
    const entries = Array.isArray(parsed) ? parsed : [parsed]
    return entries
      .filter((entry): entry is { name: string; width: number; height: number } =>
        Boolean(entry) && typeof entry === 'object' &&
        typeof (entry as { name?: unknown }).name === 'string' &&
        typeof (entry as { width?: unknown }).width === 'number' &&
        typeof (entry as { height?: unknown }).height === 'number',
      )
      .map((entry) => ({ name: entry.name, width: entry.width, height: entry.height }))
  }

  if (process.platform === 'darwin' || process.platform === 'linux') {
    const output = await runCommand('lpoptions', ['-p', printerName, '-l'])
    const mediaLine = output.split(/\r?\n/).find((line) => /^(?:PageSize|Page Size|media|Media)\//i.test(line))
    if (mediaLine) {
      candidates = mediaLine.slice(mediaLine.indexOf(':') + 1).trim().split(/\s+/).filter(Boolean)
    }
  }

  if (candidates.length === 0) {
    for (const [key, value] of Object.entries(printerOptions)) {
      if (/^(?:media-supported|PageSize|Page Size|paper-sizes)$/i.test(key) && typeof value === 'string') {
        candidates.push(...value.split(/[,\s]+/).filter(Boolean))
      }
    }
  }

  const sizes = new Map<string, PrinterPaperSize>()
  for (const candidate of candidates) {
    const paper = paperSizeFromName(candidate)
    if (paper) sizes.set(`${paper.width}x${paper.height}`, paper)
  }
  return [...sizes.values()]
}

ipcMain.handle('list-printers', async (event) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender)
  if (!sourceWindow || sourceWindow !== printPreviewWindow || sourceWindow.isDestroyed()) {
    return { printers: [], error: 'The print preview window is no longer available.' }
  }
  try {
    const printers = await sourceWindow.webContents.getPrintersAsync()
    return {
      printers: printers.map(({ name, displayName, isDefault }) => ({ name, displayName, isDefault })),
    }
  } catch (error) {
    return { printers: [], error: error instanceof Error ? error.message : 'Unable to list printers.' }
  }
})

ipcMain.handle('get-printer-paper-sizes', async (event, printerName: string) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender)
  if (!sourceWindow || sourceWindow !== printPreviewWindow || sourceWindow.isDestroyed()) {
    return { paperSizes: [], error: 'The print preview window is no longer available.' }
  }
  if (typeof printerName !== 'string' || !printerName.trim()) {
    return { paperSizes: [], error: 'Select a printer first.' }
  }

  try {
    const printers = await sourceWindow.webContents.getPrintersAsync()
    const printer = printers.find((item) => item.name === printerName)
    if (!printer) return { paperSizes: [], error: 'The selected printer is no longer available.' }
    const sizes = await getDriverPaperSizes(printer.name, printer.options as Record<string, string>)
    return sizes.length
      ? { paperSizes: sizes }
      : { paperSizes: [], error: 'This printer driver did not report supported paper sizes.' }
  } catch (error) {
    return { paperSizes: [], error: error instanceof Error ? error.message : 'Unable to read printer paper sizes.' }
  }
})

function createPrintPreviewHtml(payload: PrintPreviewPayload): string {
  if (!payload.pages.length || !Number.isFinite(payload.dpi) || payload.dpi <= 0) {
    throw new Error('The print preview does not contain valid pages.')
  }

  const firstPage = payload.pages[0]
  if (!Number.isFinite(firstPage.width) || !Number.isFinite(firstPage.height) || firstPage.width <= 0 || firstPage.height <= 0) {
    throw new Error('The print preview page has invalid dimensions.')
  }

  const originalWidthMm = firstPage.width * 25.4 / payload.dpi
  const originalHeightMm = firstPage.height * 25.4 / payload.dpi
  const pageMarkup = payload.pages.map((page, pageIndex) => {
    if (page.width !== firstPage.width || page.height !== firstPage.height) {
      throw new Error('All pages in a print job must have the same paper size.')
    }

    const images = page.images.map((image) => {
      const buffer = Buffer.from(image.buffer)
      const source = `data:image/jpeg;base64,${buffer.toString('base64')}`
      const left = image.x / page.width * 100
      const top = image.y / page.height * 100
      const width = image.width / page.width * 100
      const height = image.height / page.height * 100
      return `<img alt="" src="${source}" style="left:${left}%;top:${top}%;width:${width}%;height:${height}%">`
    }).join('')
    const lines = page.lines.map((line) => {
      const stroke = /^#[\da-f]{6}$/i.test(line.color ?? '') ? line.color : '#000000'
      const dashArray = line.dashArray?.length ? ` stroke-dasharray="${line.dashArray.join(' ')}"` : ''
      return `<line x1="${line.x1}" y1="${line.y1}" x2="${line.x2}" y2="${line.y2}" stroke="${stroke}" stroke-width="${line.width}"${dashArray}/>`
    }).join('')

    return `<section class="page-row"><div class="paper" data-page="${pageIndex + 1}"><div class="artwork">${images}<svg viewBox="0 0 ${page.width} ${page.height}" preserveAspectRatio="none" aria-hidden="true">${lines}</svg></div></div></section>`
  }).join('')

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Polaroid Print Preview</title>
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; font-family: Inter, "Segoe UI", system-ui, sans-serif; background: #202328; color: #e7e9ed; }
    button, select, input { font: inherit; }
    button { color: inherit; cursor: pointer; }
    .workspace { min-height: 100vh; display: grid; grid-template-rows: 54px minmax(0, 1fr); }
    .topbar { display: flex; align-items: center; justify-content: space-between; padding: 0 18px; background: #292c31; border-bottom: 1px solid #111318; }
    .brand { display: flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 650; }
    .brand-mark { width: 23px; height: 23px; display: grid; place-items: center; border-radius: 5px; background: #df9c48; color: #20170d; }
    .top-actions { display: flex; align-items: center; gap: 8px; }
    .button { border: 1px solid #454950; border-radius: 5px; background: #35383e; padding: 7px 12px; font-size: 12px; }
    .button:hover { background: #42464d; }
    .button.primary { border-color: #df9c48; background: #df9c48; color: #20170d; font-weight: 700; padding-inline: 18px; }
    .content { min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 310px; }
    .preview-area { min-width: 0; display: grid; grid-template-rows: 42px minmax(0, 1fr) 34px; background: #1c1e22; }
    .preview-toolbar { display: flex; align-items: center; justify-content: center; gap: 8px; border-bottom: 1px solid #111318; background: #24262b; }
    .preview-toolbar button { width: 26px; height: 25px; padding: 0; border: 1px solid #42454b; border-radius: 4px; background: #303238; }
    #zoom-value { min-width: 42px; text-align: center; font-size: 11px; color: #c4c6ca; }
    .preview-scroll { min-height: 0; overflow: auto; display: flex; justify-content: center; align-items: flex-start; padding: 28px; }
    .pages { display: flex; flex-direction: column; align-items: center; gap: 26px; }
    .print-pages { display: none; }
    .layout-preview { position: relative; overflow: visible; }
    .layout-preview .print-output-page { box-shadow: 0 5px 25px #000a; }
    .page-row { position: relative; width: max-content; }
    .paper { position: relative; overflow: hidden; background: white; box-shadow: 0 5px 25px #000a; }
    .artwork { position: absolute; left: 0; top: 0; background: #fff; transform-origin: top left; touch-action: none; cursor: grab; }
    .artwork.dragging { cursor: grabbing; }
    .artwork img { position: absolute; display: block; object-fit: fill; }
    .artwork svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
    .statusbar { display: flex; align-items: center; padding: 0 12px; border-top: 1px solid #34373d; color: #92959b; font-size: 10px; }
    .settings { min-height: 0; overflow: auto; background: #292c31; border-left: 1px solid #111318; }
    .settings-heading { padding: 15px 16px 12px; border-bottom: 1px solid #41444a; font-size: 13px; font-weight: 650; }
    .group { padding: 14px 16px; border-bottom: 1px solid #41444a; }
    .group-title { margin: 0 0 12px; color: #e5e6e9; font-size: 11px; font-weight: 700; letter-spacing: .45px; text-transform: uppercase; }
    .printer-name { margin-bottom: 10px; color: #b6b9bf; font-size: 11px; }
    .full-button { width: 100%; }
    .field { display: grid; grid-template-columns: 90px minmax(0, 1fr); align-items: center; gap: 8px; margin: 9px 0; color: #bfc1c6; font-size: 11px; }
    select, input[type=number], input[type=text] { width: 100%; height: 29px; padding: 0 8px; border: 1px solid #4a4d54; border-radius: 4px; background: #202227; color: #e5e6e9; }
    .orient, .mode-tabs, .radio-row { display: flex; gap: 6px; }
    .orient button, .mode-tabs button { flex: 1; border: 1px solid #4a4d54; border-radius: 4px; background: #202227; padding: 6px; font-size: 11px; }
    .orient button.active, .mode-tabs button.active { border-color: #df9c48; color: #f3b86e; }
    .radio-row { flex-wrap: wrap; margin: 8px 0; color: #bfc1c6; font-size: 11px; }
    .radio-row label { display: inline-flex; align-items: center; gap: 5px; }
    .radio-row input { accent-color: #df9c48; }
    .subgroup { margin-top: 12px; }
    .subgroup[hidden] { display: none; }
    #page-range-field[hidden], #custom-scale-field[hidden] { display: none; }
    .range-row { display: grid; grid-template-columns: 1fr 66px; align-items: center; gap: 8px; }
    input[type=range] { width: 100%; accent-color: #df9c48; }
    .check-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; color: #bfc1c6; font-size: 11px; }
    .check-row input { accent-color: #df9c48; }
    .xy-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .hint { margin: 9px 0 0; color: #858990; font-size: 10px; line-height: 1.45; }
    #status { min-height: 15px; margin-top: 9px; color: #dfb374; font-size: 10px; }
    .print-output-page { position: relative; overflow: hidden; background: #fff; break-after: page; page-break-after: always; }
    .print-output-page:last-child { break-after: auto; page-break-after: auto; }
    .print-slot { position: absolute; overflow: hidden; }
    .print-artwork { position: absolute; transform-origin: top left; background: #fff; }
    @media print {
      html, body, .workspace, .content, .preview-area { display: block; width: auto; min-height: 0; margin: 0; background: #fff; overflow: visible; }
      .topbar, .preview-toolbar, .settings, .statusbar { display: none !important; }
      .preview-scroll { display: block; overflow: visible; padding: 0; }
      .pages { display: none !important; }
      .print-pages { display: block !important; }
      .print-output-page { width: var(--paper-width) !important; height: var(--paper-height) !important; transform: none !important; }
      #layout-preview { display: none !important; }
    }
  </style>
  <style id="print-page-style"></style>
</head>
<body>
  <div class="workspace">
    <header class="topbar">
      <div class="brand"><span class="brand-mark">P</span><span>Print Preview</span></div>
      <div class="top-actions">
        <button class="button" type="button" onclick="window.polaroidEngine.closePrintPreview()">Cancel</button>
        <button class="button primary" type="button" onclick="printSheet()">Print</button>
      </div>
    </header>
    <div class="content">
      <main class="preview-area">
        <div class="preview-toolbar">
          <button type="button" title="Previous page" onclick="showPage(currentPage - 1)">‹</button>
          <span id="page-label">Page 1 of ${payload.pages.length}</span>
          <button type="button" title="Next page" onclick="showPage(currentPage + 1)">›</button>
          <span style="width:8px"></span>
          <button type="button" title="Zoom out" onclick="setZoom(zoom - 10)">−</button>
          <span id="zoom-value">Fit</span>
          <button type="button" title="Zoom in" onclick="setZoom(zoom + 10)">+</button>
          <button type="button" title="Fit page" onclick="fitPreview()">Fit</button>
        </div>
        <div class="preview-scroll" id="preview-scroll"><div class="pages">${pageMarkup}</div><div class="layout-preview" id="layout-preview" hidden></div><div class="print-pages" id="print-pages"></div></div>
        <div class="statusbar">${payload.pages.length} page(s) · Artwork prepared at ${payload.dpi} DPI</div>
      </main>
      <aside class="settings">
        <div class="settings-heading">Print Settings</div>
        <section class="group">
          <h2 class="group-title">Printer</h2>
          <label class="field"><span>Printer</span><select id="printer-select" onchange="changePrinter()">
            <option value="">Loading printers…</option>
          </select></label>
          <label class="field"><span>Copies</span><input id="copies" type="number" min="1" max="999" step="1" value="1"></label>
          <label class="check-row"><input id="grayscale" type="checkbox"> Print in grayscale (black and white)</label>
          <p class="hint">Paper size and print options here apply only to this print job. They do not change your computer's printer defaults.</p>
        </section>
        <section class="group">
          <h2 class="group-title">Media</h2>
          <label class="field"><span>Paper size</span><select id="paper-size" onchange="changePaper()" disabled>
            <option value="">Select a printer first</option>
          </select></label>
          <div class="field"><span>Orientation</span><div class="orient">
            <button type="button" id="auto-orientation" class="active" onclick="setOrientation('auto')">Auto</button>
            <button type="button" id="portrait" onclick="setOrientation('portrait')">Portrait</button>
            <button type="button" id="landscape" onclick="setOrientation('landscape')">Landscape</button>
          </div></div>
          <label class="check-row"><input id="duplex-enabled" type="checkbox" onchange="toggleDuplex()"> Print on both sides of paper</label>
          <div class="radio-row" id="duplex-options" hidden>
            <label><input type="radio" name="duplex" value="longEdge" checked> Flip on long edge</label>
            <label><input type="radio" name="duplex" value="shortEdge"> Flip on short edge</label>
          </div>
          <p class="hint">Available sizes come from the driver. This selection applies only to this app's current print job.</p>
        </section>
        <section class="group">
          <h2 class="group-title">Pages to Print</h2>
          <div class="radio-row">
            <label><input type="radio" name="page-selection" value="all" checked onchange="updateSelectionControls()"> All</label>
            <label><input type="radio" name="page-selection" value="current" onchange="updateSelectionControls()"> Current</label>
            <label><input type="radio" name="page-selection" value="range" onchange="updateSelectionControls()"> Pages</label>
          </div>
          <label class="field" id="page-range-field" hidden><span>Page range</span><input id="page-range" type="text" placeholder="1-3, 5" aria-label="Page range" oninput="updatePreview()"></label>
          <p class="hint">This document has ${payload.pages.length} page(s). Use commas and ranges, e.g. 1-3, 5.</p>
        </section>
        <section class="group">
          <h2 class="group-title">Page Sizing &amp; Handling</h2>
          <div class="mode-tabs">
            <button type="button" class="active" data-mode="size" onclick="setLayoutMode('size')">Size</button>
            <button type="button" data-mode="poster" onclick="setLayoutMode('poster')">Poster</button>
            <button type="button" data-mode="multiple" onclick="setLayoutMode('multiple')">Multiple</button>
            <button type="button" data-mode="booklet" onclick="setLayoutMode('booklet')">Booklet</button>
          </div>
          <div id="size-options" class="subgroup">
            <div class="radio-row">
              <label><input type="radio" name="size-mode" value="fit" checked onchange="updateSizeMode()"> Fit</label>
              <label><input type="radio" name="size-mode" value="actual" onchange="updateSizeMode()"> Actual size</label>
              <label><input type="radio" name="size-mode" value="shrink" onchange="updateSizeMode()"> Shrink oversized pages</label>
              <label><input type="radio" name="size-mode" value="custom" onchange="updateSizeMode()"> Custom scale</label>
            </div>
            <label class="field" id="custom-scale-field" hidden><span>Scale (%)</span><div class="range-row">
              <input id="scale-range" type="range" min="10" max="200" value="100" oninput="setScale(this.value)">
              <input id="scale-number" type="number" min="10" max="200" value="100" oninput="setScale(this.value)">
            </div></label>
            <label class="check-row"><input id="center-image" type="checkbox" checked onchange="toggleCenter()"> Center Image</label>
            <div class="xy-fields">
              <label class="field"><span>Left (mm)</span><input id="position-x" type="number" step="0.1" value="0" oninput="setPosition()"></label>
              <label class="field"><span>Top (mm)</span><input id="position-y" type="number" step="0.1" value="0" oninput="setPosition()"></label>
            </div>
            <p class="hint">Paper size and orientation are sent with this job only. Other device-specific settings use the printer's existing defaults.</p>
          </div>
          <div id="poster-options" class="subgroup" hidden>
            <label class="field"><span>Tile scale</span><input id="poster-scale" type="number" min="100" max="400" value="200" step="10" onchange="updatePreview()"></label>
            <label class="field"><span>Overlap (mm)</span><input id="poster-overlap" type="number" min="0" max="25" value="0" step="1" onchange="updatePreview()"></label>
            <p class="hint">Enlarges each selected page across multiple sheets.</p>
          </div>
          <div id="multiple-options" class="subgroup" hidden>
            <label class="field"><span>Pages per sheet</span><select id="pages-per-sheet" onchange="updatePreview()">
              <option value="2">2</option><option value="4" selected>4</option><option value="6">6</option><option value="9">9</option><option value="16">16</option>
            </select></label>
            <label class="field"><span>Page order</span><select id="page-order" onchange="updatePreview()">
              <option value="horizontal">Horizontal</option><option value="vertical">Vertical</option>
              <option value="horizontal-reverse">Horizontal, reversed</option><option value="vertical-reverse">Vertical, reversed</option>
            </select></label>
          </div>
          <div id="booklet-options" class="subgroup" hidden>
            <p class="hint">Imposes selected pages for two-sided booklet printing. Enable duplex and use flip on short edge.</p>
          </div>
          <div id="status" role="status"></div>
        </section>
      </aside>
    </div>
  </div>
  <script>
    const originalWidthMm = ${originalWidthMm}
    const originalHeightMm = ${originalHeightMm}
    const mmToPx = 96 / 25.4
    const pageRows = Array.from(document.querySelectorAll('.page-row'))
    const papers = Array.from(document.querySelectorAll('.paper'))
    const artworks = Array.from(document.querySelectorAll('.artwork'))
    const printPages = document.getElementById('print-pages')
    const layoutPreview = document.getElementById('layout-preview')
    let outputContainer = printPages
    let availablePaperSizes = []
    let selectedPaperSize = null
    let selectedPrinterName = ''
    let paperWidth = originalWidthMm
    let paperHeight = originalHeightMm
    let scale = 100
    let sizeMode = 'fit'
    let layoutMode = 'size'
    let orientationMode = 'auto'
    let zoom = 0
    let fitMode = true
    let currentPage = 0
    let center = true
    let positionX = 0
    let positionY = 0
    let drag = null

    function sizeScale() {
      const fitScale = Math.min(paperWidth / originalWidthMm, paperHeight / originalHeightMm) * 100
      if (sizeMode === 'fit') return fitScale
      if (sizeMode === 'shrink') return Math.min(100, fitScale)
      if (sizeMode === 'actual') return 100
      return scale
    }

    function applyOrientation() {
      if (!selectedPaperSize) return
      paperWidth = selectedPaperSize.width
      paperHeight = selectedPaperSize.height
      const wantLandscape = orientationMode === 'landscape' ||
        (orientationMode === 'auto' && layoutMode === 'booklet') ||
        (orientationMode === 'auto' && originalWidthMm > originalHeightMm)
      if ((paperWidth > paperHeight) !== wantLandscape) [paperWidth, paperHeight] = [paperHeight, paperWidth]
    }

    function updatePreview() {
      const previewScale = layoutMode === 'poster'
        ? Math.max(100, Math.min(400, Number(document.getElementById('poster-scale').value) || 200))
        : sizeScale()
      const left = center ? (paperWidth - originalWidthMm * previewScale / 100) / 2 : positionX
      const top = center ? (paperHeight - originalHeightMm * previewScale / 100) / 2 : positionY
      if (center) {
        positionX = left
        positionY = top
      }
      const displayedWidth = paperWidth * mmToPx * Math.max(0.1, zoom / 100)
      const displayedHeight = paperHeight * mmToPx * Math.max(0.1, zoom / 100)
      papers.forEach((paper, index) => {
        paper.style.width = displayedWidth + 'px'
        paper.style.height = displayedHeight + 'px'
        paper.style.setProperty('--paper-width', paperWidth + 'mm')
        paper.style.setProperty('--paper-height', paperHeight + 'mm')
        const artwork = artworks[index]
        artwork.style.width = originalWidthMm * mmToPx * zoom / 100 + 'px'
        artwork.style.height = originalHeightMm * mmToPx * zoom / 100 + 'px'
        artwork.style.left = left * mmToPx * zoom / 100 + 'px'
        artwork.style.top = top * mmToPx * zoom / 100 + 'px'
        artwork.style.transform = 'scale(' + previewScale / 100 + ')'
      })
      pageRows.forEach((row) => {
        row.style.width = displayedWidth + 'px'
        row.style.height = displayedHeight + 'px'
        row.style.display = pageRows.indexOf(row) === currentPage ? '' : 'none'
      })
      document.getElementById('position-x').value = left.toFixed(1)
      document.getElementById('position-y').value = top.toFixed(1)
      document.getElementById('position-x').disabled = center || layoutMode !== 'size'
      document.getElementById('position-y').disabled = center || layoutMode !== 'size'
      document.getElementById('center-image').disabled = layoutMode !== 'size'
      document.getElementById('auto-orientation').classList.toggle('active', orientationMode === 'auto')
      document.getElementById('auto-orientation').disabled = layoutMode === 'booklet'
      document.getElementById('portrait').disabled = layoutMode === 'booklet'
      document.getElementById('portrait').classList.toggle('active', paperHeight >= paperWidth)
      document.getElementById('landscape').classList.toggle('active', paperWidth > paperHeight)
      document.getElementById('zoom-value').textContent = zoom ? Math.round(zoom) + '%' : 'Fit'
      document.getElementById('page-label').textContent = 'Page ' + (currentPage + 1) + ' of ' + pageRows.length
      document.getElementById('print-page-style').textContent =
        '@page { size: ' + paperWidth + 'mm ' + paperHeight + 'mm; margin: 0; }'
      refreshLayoutPreview()
    }

    function fitPreview() {
      const scroll = document.getElementById('preview-scroll')
      const availableWidth = Math.max(100, scroll.clientWidth - 56)
      const availableHeight = Math.max(100, scroll.clientHeight - 56)
      zoom = Math.min(100, availableWidth / (paperWidth * mmToPx) * 100, availableHeight / (paperHeight * mmToPx) * 100)
      fitMode = true
      updatePreview()
      document.getElementById('zoom-value').textContent = 'Fit'
    }

    function setZoom(value) {
      zoom = Math.max(10, Math.min(200, Number(value)))
      fitMode = false
      updatePreview()
    }

    function showPage(index) {
      currentPage = Math.max(0, Math.min(pageRows.length - 1, index))
      updatePreview()
      if (fitMode) fitPreview()
    }

    function changePaper() {
      selectedPaperSize = availablePaperSizes[Number(document.getElementById('paper-size').value)]
      if (!selectedPaperSize) return
      applyOrientation()
      positionX = 0
      positionY = 0
      updatePreview()
      if (fitMode) fitPreview()
    }

    async function changePrinter() {
      const printerSelect = document.getElementById('printer-select')
      const paperSelect = document.getElementById('paper-size')
      selectedPrinterName = printerSelect.value
      selectedPaperSize = null
      availablePaperSizes = []
      paperSelect.innerHTML = '<option value="">Loading driver paper sizes…</option>'
      paperSelect.disabled = true
      document.getElementById('status').textContent = ''
      if (!selectedPrinterName) {
        paperSelect.innerHTML = '<option value="">Select a printer first</option>'
        updatePreview()
        return
      }

      const result = await window.polaroidEngine.getPrinterPaperSizes(selectedPrinterName)
      if (printerSelect.value !== selectedPrinterName) return
      if (result.error || !result.paperSizes.length) {
        paperSelect.innerHTML = '<option value="">No driver paper sizes available</option>'
        document.getElementById('status').textContent = result.error || 'The driver reported no paper sizes.'
        updatePreview()
        return
      }
      populatePaperSizes(result.paperSizes)
      paperSelect.value = '0'
      changePaper()
    }

    function populatePaperSizes(paperSizes) {
      const paperSelect = document.getElementById('paper-size')
      availablePaperSizes = paperSizes
      paperSelect.innerHTML = availablePaperSizes.map((paper, index) =>
        '<option value="' + index + '">' + paper.name + ' (' + paper.width + ' × ' + paper.height + ' mm)</option>'
      ).join('')
      paperSelect.disabled = !availablePaperSizes.length
      if (availablePaperSizes.length) {
        paperSelect.value = '0'
        changePaper()
      }
    }

    async function loadPrinters() {
      const select = document.getElementById('printer-select')
      const result = await window.polaroidEngine.listPrinters()
      if (result.error || !result.printers.length) {
        select.innerHTML = '<option value="">No printers available</option>'
        document.getElementById('status').textContent = result.error || 'No printers are installed.'
        return
      }
      select.innerHTML = result.printers.map((printer) =>
        '<option value="' + printer.name.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '">' +
        printer.displayName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
        (printer.isDefault ? ' (Default)' : '') + '</option>'
      ).join('')
      const defaultPrinter = result.printers.find((printer) => printer.isDefault) || result.printers[0]
      select.value = defaultPrinter.name
      await changePrinter()
    }

    function setOrientation(value) {
      orientationMode = layoutMode === 'booklet' ? 'landscape' : value
      applyOrientation()
      updatePreview()
      if (fitMode) fitPreview()
    }

    function setScale(value) {
      scale = Math.max(10, Math.min(200, Number(value) || 100))
      document.getElementById('scale-range').value = scale
      document.getElementById('scale-number').value = scale
      updatePreview()
    }

    function updateSizeMode() {
      sizeMode = document.querySelector('input[name="size-mode"]:checked').value
      document.getElementById('custom-scale-field').hidden = sizeMode !== 'custom'
      updatePreview()
    }

    function setLayoutMode(mode) {
      layoutMode = mode
      document.querySelectorAll('.mode-tabs button').forEach((button) => {
        button.classList.toggle('active', button.dataset.mode === mode)
      })
      document.getElementById('size-options').hidden = mode !== 'size'
      document.getElementById('poster-options').hidden = mode !== 'poster'
      document.getElementById('multiple-options').hidden = mode !== 'multiple'
      document.getElementById('booklet-options').hidden = mode !== 'booklet'
      if (mode === 'booklet') {
        orientationMode = 'landscape'
        applyOrientation()
        document.getElementById('duplex-enabled').checked = true
        document.querySelector('input[name="duplex"][value="shortEdge"]').checked = true
        toggleDuplex()
      } else if (orientationMode === 'landscape') {
        orientationMode = 'auto'
        applyOrientation()
      }
      updatePreview()
      if (fitMode) fitPreview()
    }

    function toggleDuplex() {
      document.getElementById('duplex-options').hidden = !document.getElementById('duplex-enabled').checked
    }

    function updateSelectionControls() {
      const selection = document.querySelector('input[name="page-selection"]:checked').value
      document.getElementById('page-range-field').hidden = selection !== 'range'
      updatePreview()
    }

    function toggleCenter() {
      center = document.getElementById('center-image').checked
      updatePreview()
    }

    function setPosition() {
      center = false
      document.getElementById('center-image').checked = false
      positionX = Number(document.getElementById('position-x').value) || 0
      positionY = Number(document.getElementById('position-y').value) || 0
      updatePreview()
    }

    artworks.forEach((artwork) => {
      artwork.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return
        center = false
        document.getElementById('center-image').checked = false
        positionX = Number(document.getElementById('position-x').value) || 0
        positionY = Number(document.getElementById('position-y').value) || 0
        drag = { x: event.clientX, y: event.clientY, positionX, positionY }
        artwork.classList.add('dragging')
        artwork.setPointerCapture(event.pointerId)
      })
      artwork.addEventListener('pointermove', (event) => {
        if (!drag) return
        const pixelsPerMm = mmToPx * zoom / 100
        positionX = drag.positionX + (event.clientX - drag.x) / pixelsPerMm
        positionY = drag.positionY + (event.clientY - drag.y) / pixelsPerMm
        document.getElementById('position-x').value = positionX.toFixed(1)
        document.getElementById('position-y').value = positionY.toFixed(1)
        updatePreview()
      })
      artwork.addEventListener('pointerup', () => { drag = null; artwork.classList.remove('dragging') })
      artwork.addEventListener('pointercancel', () => { drag = null; artwork.classList.remove('dragging') })
    })

    function selectedPageIndexes() {
      const selection = document.querySelector('input[name="page-selection"]:checked').value
      if (selection === 'all') return pageRows.map((_, index) => index)
      if (selection === 'current') return [currentPage]

      const input = document.getElementById('page-range').value.trim()
      if (!input) throw new Error('Enter the page numbers to print.')
      const result = []
      for (const part of input.split(',')) {
        const match = part.trim().match(/^(\\d+)(?:\\s*-\\s*(\\d+))?$/)
        if (!match) throw new Error('Enter a page range such as 1-3, 5.')
        const first = Number(match[1])
        const last = Number(match[2] || match[1])
        if (first < 1 || last < first || last > pageRows.length) {
          throw new Error('Page numbers must be between 1 and ' + pageRows.length + '.')
        }
        for (let page = first; page <= last; page++) {
          if (!result.includes(page - 1)) result.push(page - 1)
        }
      }
      if (!result.length) throw new Error('Select at least one page to print.')
      return result
    }

    function createOutputPage() {
      const output = document.createElement('div')
      output.className = 'print-output-page'
      output.style.setProperty('--paper-width', paperWidth + 'mm')
      output.style.setProperty('--paper-height', paperHeight + 'mm')
      output.style.width = paperWidth + 'mm'
      output.style.height = paperHeight + 'mm'
      output.style.transform = 'scale(' + Math.max(0.1, zoom / 100) + ')'
      output.style.transformOrigin = 'top left'
      outputContainer.appendChild(output)
      return output
    }

    function placeArtwork(output, pageIndex, left, top, artworkScale) {
      const artwork = artworks[pageIndex].cloneNode(true)
      artwork.className = 'print-artwork'
      artwork.removeAttribute('style')
      artwork.style.left = left + 'mm'
      artwork.style.top = top + 'mm'
      artwork.style.width = originalWidthMm + 'mm'
      artwork.style.height = originalHeightMm + 'mm'
      artwork.style.transform = 'scale(' + artworkScale + ')'
      output.appendChild(artwork)
    }

    function placeFittedArtwork(output, pageIndex, left, top, width, height) {
      const factor = Math.min(width / originalWidthMm, height / originalHeightMm)
      const renderedWidth = originalWidthMm * factor
      const renderedHeight = originalHeightMm * factor
      placeArtwork(
        output,
        pageIndex,
        left + (width - renderedWidth) / 2,
        top + (height - renderedHeight) / 2,
        factor,
      )
    }

    function buildSizePages(indexes) {
      const percent = sizeScale() / 100
      const x = center ? (paperWidth - originalWidthMm * percent) / 2 : positionX
      const y = center ? (paperHeight - originalHeightMm * percent) / 2 : positionY
      for (const index of indexes) {
        placeArtwork(createOutputPage(), index, x, y, percent)
      }
    }

    function buildPosterPages(indexes) {
      const percent = Math.max(100, Math.min(400, Number(document.getElementById('poster-scale').value) || 200)) / 100
      const overlap = Math.max(0, Math.min(25, Number(document.getElementById('poster-overlap').value) || 0))
      const width = originalWidthMm * percent
      const height = originalHeightMm * percent
      const stepX = Math.max(1, paperWidth - overlap)
      const stepY = Math.max(1, paperHeight - overlap)
      const columns = Math.max(1, Math.ceil(Math.max(0, width - overlap) / stepX))
      const rows = Math.max(1, Math.ceil(Math.max(0, height - overlap) / stepY))
      if (columns * rows * indexes.length > 2000) throw new Error('Poster settings would create too many sheets.')
      for (const index of indexes) {
        for (let row = 0; row < rows; row++) {
          for (let column = 0; column < columns; column++) {
            placeArtwork(createOutputPage(), index, -column * stepX, -row * stepY, percent)
          }
        }
      }
    }

    function buildMultiplePages(indexes) {
      const count = Number(document.getElementById('pages-per-sheet').value)
      const grid = {
        2: { columns: 2, rows: 1 },
        4: { columns: 2, rows: 2 },
        6: { columns: 2, rows: 3 },
        9: { columns: 3, rows: 3 },
        16: { columns: 4, rows: 4 },
      }[count]
      if (!grid) throw new Error('Select a supported pages-per-sheet setting.')

      const order = document.getElementById('page-order').value
      const positions = []
      for (let row = 0; row < grid.rows; row++) {
        for (let column = 0; column < grid.columns; column++) positions.push({ row, column })
      }
      if (order.startsWith('vertical')) {
        positions.sort((a, b) => a.column - b.column || a.row - b.row)
      }
      if (order.endsWith('reverse')) positions.reverse()

      for (let offset = 0; offset < indexes.length; offset += count) {
        const output = createOutputPage()
        indexes.slice(offset, offset + count).forEach((pageIndex, itemIndex) => {
          const position = positions[itemIndex]
          const cellWidth = paperWidth / grid.columns
          const cellHeight = paperHeight / grid.rows
          placeFittedArtwork(
            output,
            pageIndex,
            position.column * cellWidth,
            position.row * cellHeight,
            cellWidth,
            cellHeight,
          )
        })
      }
    }

    function buildBookletPages(indexes) {
      if (!document.getElementById('duplex-enabled').checked) {
        throw new Error('Booklet printing requires “Print on both sides of paper”.')
      }
      const total = Math.ceil(indexes.length / 4) * 4
      const padded = indexes.concat(Array(total - indexes.length).fill(null))
      for (let sheet = 0; sheet < total / 4; sheet++) {
        const pairs = [
          [padded[total - 1 - sheet * 2], padded[sheet * 2]],
          [padded[sheet * 2 + 1], padded[total - 2 - sheet * 2]],
        ]
        for (const pair of pairs) {
          const output = createOutputPage()
          pair.forEach((pageIndex, side) => {
            if (pageIndex === null) return
            placeFittedArtwork(output, pageIndex, side * paperWidth / 2, 0, paperWidth / 2, paperHeight)
          })
        }
      }
    }

    function refreshLayoutPreview() {
      layoutPreview.innerHTML = ''
      if (layoutMode === 'size') {
        layoutPreview.hidden = true
        document.querySelector('.pages').style.display = ''
        return
      }

      layoutPreview.hidden = false
      document.querySelector('.pages').style.display = 'none'
      const zoomScale = Math.max(0.1, zoom / 100)
      layoutPreview.style.width = paperWidth * mmToPx * zoomScale + 'px'
      layoutPreview.style.height = paperHeight * mmToPx * zoomScale + 'px'
      outputContainer = layoutPreview
      try {
        const indexes = selectedPageIndexes()
        if (layoutMode === 'poster') {
          const percent = Math.max(100, Math.min(400, Number(document.getElementById('poster-scale').value) || 200)) / 100
          placeArtwork(createOutputPage(), indexes[0], 0, 0, percent)
        } else if (layoutMode === 'multiple') {
          const count = Number(document.getElementById('pages-per-sheet').value)
          const previewIndexes = indexes.slice(0, count)
          const grid = {
            2: { columns: 2, rows: 1 },
            4: { columns: 2, rows: 2 },
            6: { columns: 2, rows: 3 },
            9: { columns: 3, rows: 3 },
            16: { columns: 4, rows: 4 },
          }[count]
          const positions = []
          for (let row = 0; row < grid.rows; row++) {
            for (let column = 0; column < grid.columns; column++) positions.push({ row, column })
          }
          const order = document.getElementById('page-order').value
          if (order.startsWith('vertical')) positions.sort((a, b) => a.column - b.column || a.row - b.row)
          if (order.endsWith('reverse')) positions.reverse()
          const output = createOutputPage()
          previewIndexes.forEach((pageIndex, itemIndex) => {
            const position = positions[itemIndex]
            const cellWidth = paperWidth / grid.columns
            const cellHeight = paperHeight / grid.rows
            placeFittedArtwork(output, pageIndex, position.column * cellWidth, position.row * cellHeight, cellWidth, cellHeight)
          })
        } else {
          const total = Math.ceil(indexes.length / 4) * 4
          const padded = indexes.concat(Array(total - indexes.length).fill(null))
          const output = createOutputPage()
          ;[padded[total - 1], padded[0]].forEach((pageIndex, side) => {
            if (pageIndex !== null) placeFittedArtwork(output, pageIndex, side * paperWidth / 2, 0, paperWidth / 2, paperHeight)
          })
        }
      } catch {
        layoutPreview.textContent = 'Enter a valid page selection to preview this layout.'
        layoutPreview.style.color = '#a0a4ab'
      } finally {
        outputContainer = printPages
      }
    }

    async function printSheet() {
      const status = document.getElementById('status')
      const copies = Number(document.getElementById('copies').value)
      if (!selectedPrinterName || !selectedPaperSize) {
        status.textContent = 'Select a printer and a driver-supported paper size.'
        return
      }
      if (!Number.isInteger(copies) || copies < 1 || copies > 999) {
        status.textContent = 'Copies must be a whole number from 1 to 999.'
        return
      }
      try {
        const indexes = selectedPageIndexes()
        printPages.innerHTML = ''
        outputContainer = printPages
        if (layoutMode === 'size') buildSizePages(indexes)
        else if (layoutMode === 'poster') buildPosterPages(indexes)
        else if (layoutMode === 'multiple') buildMultiplePages(indexes)
        else buildBookletPages(indexes)

        status.textContent = 'Sending ' + printPages.children.length + ' sheet(s) to the printer…'
        const duplexEnabled = document.getElementById('duplex-enabled').checked
        const result = await window.polaroidEngine.printPreviewPage({
          printerName: selectedPrinterName,
          paperWidth,
          paperHeight,
          copies,
          color: !document.getElementById('grayscale').checked,
          duplexMode: duplexEnabled
            ? document.querySelector('input[name="duplex"]:checked').value
            : 'simplex',
        })
        if (result.ok) {
          await window.polaroidEngine.closePrintPreview()
        } else {
          status.textContent = result.error || 'Unable to send the print job.'
        }
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : 'Unable to prepare the print job.'
      }
    }
    window.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        printSheet()
      }
    })
    window.addEventListener('resize', () => { if (fitMode) fitPreview() })
    fitPreview()
    loadPrinters()
  </script>
</body>
</html>`
}

ipcMain.handle('open-print-preview', async (_event, payload: PrintPreviewPayload) => {
  let directory: string | null = null
  try {
    const html = createPrintPreviewHtml(payload)
    if (printPreviewWindow && !printPreviewWindow.isDestroyed()) {
      printPreviewWindow.close()
    }

    directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'polaroid-print-preview-'))
    const previewPath = path.join(directory, 'preview.html')
    await fs.promises.writeFile(previewPath, html, 'utf8')

    const previewWindow = new BrowserWindow({
      width: 1100,
      height: 850,
      minWidth: 700,
      minHeight: 520,
      title: 'Polaroid Print Preview',
      backgroundColor: '#20252b',
      webPreferences: {
        preload: path.join(__dirname, 'preload.mjs'),
      },
    })
    printPreviewWindow = previewWindow
    previewWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    previewWindow.on('closed', () => {
      if (printPreviewWindow === previewWindow) {
        printPreviewWindow = null
      }
      if (directory) void fs.promises.rm(directory, { recursive: true, force: true })
    })
    await previewWindow.loadFile(previewPath)
    previewWindow.show()
    return { ok: true }
  } catch (error) {
    if (directory) await fs.promises.rm(directory, { recursive: true, force: true })
    return { ok: false, error: error instanceof Error ? error.message : 'Unable to open print preview.' }
  }
})

ipcMain.handle('close-print-preview', (event) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender)
  if (sourceWindow && sourceWindow === printPreviewWindow && !sourceWindow.isDestroyed()) {
    sourceWindow.close()
  }
})

ipcMain.handle('print-preview-page', async (event, options: PrintJobOptions) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender)
  if (!sourceWindow || sourceWindow !== printPreviewWindow || sourceWindow.isDestroyed()) {
    return { ok: false, error: 'The print preview window is no longer available.' }
  }

  if (
    !options ||
    typeof options.printerName !== 'string' ||
    !options.printerName.trim() ||
    !Number.isInteger(options.copies) ||
    options.copies < 1 ||
    options.copies > 999 ||
    typeof options.color !== 'boolean' ||
    !['simplex', 'shortEdge', 'longEdge'].includes(options.duplexMode)
  ) {
    return { ok: false, error: 'The print settings are invalid.' }
  }

  if (
    !Number.isFinite(options.paperWidth) ||
    !Number.isFinite(options.paperHeight) ||
    options.paperWidth <= 0 ||
    options.paperHeight <= 0 ||
    options.paperWidth > 2000 ||
    options.paperHeight > 2000
  ) {
    return { ok: false, error: 'The selected paper size is invalid.' }
  }

  try {
    const printers = await sourceWindow.webContents.getPrintersAsync()
    const printer = printers.find((item) => item.name === options.printerName)
    if (!printer) return { ok: false, error: 'The selected printer is no longer available.' }
    const supportedSizes = await getDriverPaperSizes(printer.name, printer.options)
    const matchesMedia = supportedSizes.some((size) =>
      (Math.abs(size.width - options.paperWidth) < 0.1 && Math.abs(size.height - options.paperHeight) < 0.1) ||
      (Math.abs(size.width - options.paperHeight) < 0.1 && Math.abs(size.height - options.paperWidth) < 0.1),
    )
    if (!matchesMedia) return { ok: false, error: 'The selected paper size is not supported by this printer.' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Unable to validate printer settings.' }
  }

  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    sourceWindow.webContents.print({
      silent: true,
      printBackground: true,
      deviceName: options.printerName,
      copies: options.copies,
      color: options.color,
      duplexMode: options.duplexMode,
      margins: { marginType: 'none' },
      pageSize: {
        width: Math.round(options.paperWidth * 1000),
        height: Math.round(options.paperHeight * 1000),
      },
    }, (success, failureReason) => {
      resolve(success ? { ok: true } : { ok: false, error: failureReason || 'Printing was cancelled.' })
    })
  })
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
        { label: 'Print Preview…', accelerator: 'CmdOrCtrl+P', registerAccelerator: false, click: () => sendMenuAction('print-preview') },
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
