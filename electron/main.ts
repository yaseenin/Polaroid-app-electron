import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { PDFDocument } from 'pdf-lib'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
process.env.APP_ROOT = path.join(__dirname, '..')

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

let win: BrowserWindow | null

const RUST_MANIFEST_PATH = path.join(process.env.APP_ROOT, 'rust', 'Cargo.toml')
const RUST_BINARY_NAME = process.platform === 'win32'
  ? 'polaroid_print_imposition_engine.exe'
  : 'polaroid_print_imposition_engine'
const RUST_BINARY_PATH = path.join(process.env.APP_ROOT, 'rust', 'target', 'debug', RUST_BINARY_NAME)

type RustProcessRequest = {
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
}

type RustProcessResponse = {
  ok: boolean
  outputDir?: string
  message?: string
  error?: string
}

function ensureRustEngineReady(): string {
  if (fs.existsSync(RUST_BINARY_PATH)) {
    return RUST_BINARY_PATH
  }

  const result = spawnSync('cargo', ['build', '--manifest-path', RUST_MANIFEST_PATH, '--color', 'never'], {
    cwd: process.env.APP_ROOT,
    env: process.env,
    encoding: 'utf8',
    shell: true,
  })

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(output || 'Failed to build the Rust processing engine.')
  }

  if (!fs.existsSync(RUST_BINARY_PATH)) {
    throw new Error(`Rust engine binary was not found at ${RUST_BINARY_PATH}`)
  }

  return RUST_BINARY_PATH
}

function fileToDataUrl(filePath: string): string {
  const buffer = fs.readFileSync(filePath)
  const extension = path.extname(filePath).toLowerCase()
  const mime = extension === '.png'
    ? 'image/png'
    : extension === '.webp'
      ? 'image/webp'
      : 'image/jpeg'

  return `data:${mime};base64,${buffer.toString('base64')}`
}

ipcMain.handle('open-image-dialog', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Select images',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  })

  return {
    canceled,
    filePaths,
    dataUrls: canceled ? [] : filePaths.map(fileToDataUrl),
  }
})

ipcMain.handle('save-export', async (_event, payload: { dataUrl: string; defaultName: string; format?: 'png' | 'jpeg' | 'pdf' }) => {
  const format = payload.format ?? 'png'
  const extension = format === 'jpeg' ? 'jpg' : format === 'pdf' ? 'pdf' : 'png'
  const defaultName = payload.defaultName.endsWith(`.${extension}`) ? payload.defaultName : `${payload.defaultName.replace(/\.[^.]+$/, '') || 'export'}.${extension}`

  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Save print sheet',
    defaultPath: defaultName,
    filters: [{ name: format === 'pdf' ? 'PDF Document' : format === 'jpeg' ? 'JPEG Image' : 'PNG Image', extensions: [extension] }],
  })

  if (canceled || !filePath) {
    return { ok: false, canceled: true }
  }

  const normalizedPath = filePath.toLowerCase().endsWith(`.${extension}`) ? filePath : `${filePath}.${extension}`

  if (format === 'pdf') {
    const matches = payload.dataUrl.match(/^data:image\/(png|jpeg);base64,(.+)$/)
    const isPng = (matches?.[1] ?? 'png') === 'png'
    const base64 = matches ? matches[2] : payload.dataUrl.replace(/^data:image\/.*;base64,/, '')
    const imageBytes = Buffer.from(base64, 'base64')
    const pdfDoc = await PDFDocument.create()
    const image = isPng ? await pdfDoc.embedPng(imageBytes) : await pdfDoc.embedJpg(imageBytes)
    const page = pdfDoc.addPage([image.width, image.height])
    const scale = Math.min(page.getWidth() / image.width, page.getHeight() / image.height)
    const width = image.width * scale
    const height = image.height * scale
    page.drawImage(image, {
      x: (page.getWidth() - width) / 2,
      y: (page.getHeight() - height) / 2,
      width,
      height,
    })
    const pdfBytes = await pdfDoc.save()
    await fs.promises.writeFile(normalizedPath, pdfBytes)
    return { ok: true, filePath: normalizedPath }
  }

  const matches = payload.dataUrl.match(new RegExp(`^data:image\\/(png|jpeg);base64,(.+)$`))
  const base64 = matches ? matches[2] : payload.dataUrl.replace(/^data:image\/.*;base64,/, '')
  const buffer = Buffer.from(base64, 'base64')
  await fs.promises.writeFile(normalizedPath, buffer)

  return { ok: true, filePath: normalizedPath }
})

ipcMain.handle('rust:process', async (_event, request: RustProcessRequest): Promise<RustProcessResponse> => {
  try {
    const files = (request.files ?? []).filter(Boolean)
    if (files.length === 0) {
      return { ok: false, error: 'No image files were provided for processing.' }
    }

    const binaryPath = ensureRustEngineReady()
    const outputDir = request.outputDir ?? path.join(os.tmpdir(), 'polaroid_print_imposition_engine')
    const settings = request.settings ?? {}
    const args = ['--process', '--output-dir', outputDir]

    for (const file of files) {
      args.push('--file', file)
    }

    if (typeof settings.exposure === 'number') {
      args.push('--exposure', settings.exposure.toString())
    }
    if (typeof settings.contrast === 'number') {
      args.push('--contrast', settings.contrast.toString())
    }
    if (typeof settings.gamma === 'number') {
      args.push('--gamma', settings.gamma.toString())
    }
    if (typeof settings.sharpen === 'number') {
      args.push('--sharpen', settings.sharpen.toString())
    }
    if (typeof settings.autoRotate === 'boolean') {
      args.push('--auto-rotate', settings.autoRotate ? 'true' : 'false')
    }
    if (settings.format) {
      args.push('--format', settings.format)
    }
    if (typeof settings.dpi === 'number') {
      args.push('--dpi', settings.dpi.toString())
    }

    const child = spawn(binaryPath, args, {
      cwd: process.env.APP_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (code) => resolve(code ?? 1))
    })

    if (exitCode !== 0) {
      throw new Error(stderr.trim() || stdout.trim() || 'The Rust engine failed to process the selected images.')
    }

    const normalized = stdout.trim() || outputDir
    return {
      ok: true,
      outputDir: normalized,
      message: `Rust processing completed: ${normalized}`,
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown error'
    return {
      ok: false,
      error: detail,
    }
  }
})

function createWindow() {
  win = new BrowserWindow({
    icon: path.join(process.env.VITE_PUBLIC, 'electron-vite.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
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

app.whenReady().then(createWindow)
