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
const RUST_RELEASE_BINARY_PATH = path.join(process.env.APP_ROOT, 'rust', 'target', 'release', RUST_BINARY_NAME)
const RUST_DEBUG_BINARY_PATH = path.join(process.env.APP_ROOT, 'rust', 'target', 'debug', RUST_BINARY_NAME)

type RustProcessRequest = {
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
}

type RustProcessResponse = {
  ok: boolean
  outputDir?: string
  files?: string[]
  message?: string
  error?: string
}

function ensureRustEngineReady(): string {
  if (fs.existsSync(RUST_RELEASE_BINARY_PATH)) {
    return RUST_RELEASE_BINARY_PATH
  }
  if (fs.existsSync(RUST_DEBUG_BINARY_PATH)) {
    return RUST_DEBUG_BINARY_PATH
  }

  const cargoName = process.platform === 'win32' ? 'cargo.exe' : 'cargo'
  const cargoHome = process.env.CARGO_HOME ?? path.join(os.homedir(), '.cargo')
  const cargoPath = [
    path.join(cargoHome, 'bin', cargoName),
    ...(process.platform === 'darwin' ? ['/opt/homebrew/bin/cargo', '/usr/local/bin/cargo'] : []),
  ].find((candidate) => fs.existsSync(candidate)) ?? cargoName

  const result = spawnSync(cargoPath, ['build', '--release', '--manifest-path', RUST_MANIFEST_PATH, '--color', 'never'], {
    cwd: process.env.APP_ROOT,
    env: process.env,
    encoding: 'utf8',
  })

  const spawnError = result.error as NodeJS.ErrnoException | undefined
  if (spawnError?.code === 'ENOENT') {
    throw new Error('Rust and Cargo are not installed or are unavailable. Install Rust from https://rustup.rs, restart the app, and try again.')
  }

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(output || 'Failed to build the Rust processing engine.')
  }

  if (fs.existsSync(RUST_RELEASE_BINARY_PATH)) {
    return RUST_RELEASE_BINARY_PATH
  }
  if (fs.existsSync(RUST_DEBUG_BINARY_PATH)) {
    return RUST_DEBUG_BINARY_PATH
  }

  throw new Error(`Rust engine binary was not found at ${RUST_RELEASE_BINARY_PATH}`)
}

async function fileToDataUrlAsync(filePath: string): Promise<string> {
  const buffer = await fs.promises.readFile(filePath)
  const extension = path.extname(filePath).toLowerCase()
  const mime = extension === '.png'
    ? 'image/png'
    : extension === '.webp'
      ? 'image/webp'
      : 'image/jpeg'

  return `data:${mime};base64,${buffer.toString('base64')}`
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
      photos?: Array<{ name?: string; path?: string; cropApplied?: unknown }>
    }
    if (!Array.isArray(project.photos)) {
      throw new Error('This file does not contain a valid Polaroid project.')
    }

    const photos = project.photos.map((photo) => {
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

ipcMain.handle('save-export', async (_event, payload: { dataUrls: string[]; defaultName: string; format?: 'png' | 'jpeg' | 'pdf'; dpi?: number }) => {
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
  const dataUrls = payload.dataUrls || []

  if (format === 'pdf') {
    const pdfDoc = await PDFDocument.create()
    const pointsPerPixel = 72 / Math.max(1, payload.dpi ?? 300)

    for (const dataUrl of dataUrls) {
      const matches = dataUrl.match(/^data:image\/(png|jpeg);base64,(.+)$/)
      const isPng = (matches?.[1] ?? 'png') === 'png'
      const base64 = matches ? matches[2] : dataUrl.replace(/^data:image\/.*;base64,/, '')
      const imageBytes = Buffer.from(base64, 'base64')
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

  for (let i = 0; i < dataUrls.length; i++) {
    const p = dataUrls.length === 1 ? normalizedPath : normalizedPath.replace(new RegExp(`\\.${extension}$`, 'i'), `-${i + 1}.${extension}`)
    const matches = dataUrls[i].match(new RegExp(`^data:image\\/(png|jpeg);base64,(.+)$`))
    const base64 = matches ? matches[2] : dataUrls[i].replace(/^data:image\/.*;base64,/, '')
    const buffer = Buffer.from(base64, 'base64')
    await fs.promises.writeFile(p, buffer)
  }

  return { ok: true, filePath: normalizedPath }
})

ipcMain.handle('rust:process', async (_event, request: RustProcessRequest): Promise<RustProcessResponse> => {
  try {
    const files = (request.files ?? []).filter(Boolean)
    if (files.length === 0) {
      return { ok: false, error: 'No image files were provided for processing.' }
    }

    const binaryPath = ensureRustEngineReady()
    const outputDir = request.outputDir ?? path.join(os.tmpdir(), 'polaroid_print_imposition_engine', `export_${Date.now()}`)
    const settings = request.settings ?? {}
    const args = ['--process', '--output-dir', outputDir]

    for (const file of files) {
      args.push('--file', file)
    }

    if (typeof settings.exposure === 'number') {
      args.push('--exposure', settings.exposure.toString())
    }
    if (typeof settings.brightness === 'number') {
      args.push('--brightness', settings.brightness.toString())
    }
    if (typeof settings.contrast === 'number') {
      args.push('--contrast', settings.contrast.toString())
    }
    if (typeof settings.gamma === 'number') {
      args.push('--gamma', settings.gamma.toString())
    }
    if (typeof settings.saturation === 'number') {
      args.push('--saturation', settings.saturation.toString())
    }
    if (typeof settings.sharpen === 'number') {
      args.push('--sharpen', settings.sharpen.toString())
    }
    if (typeof settings.temperature === 'number') {
      args.push('--temperature', settings.temperature.toString())
    }
    if (typeof settings.vignette === 'number') {
      args.push('--vignette', settings.vignette.toString())
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
    const outputFiles = (await fs.promises.readdir(outputDir))
      .filter((file) => /\.jpe?g$/i.test(file))
      .sort((left, right) => {
        const leftIndex = Number(left.match(/_(\d+)\.jpe?g$/i)?.[1] ?? 0)
        const rightIndex = Number(right.match(/_(\d+)\.jpe?g$/i)?.[1] ?? 0)
        return leftIndex - rightIndex
      })
      .map((file) => path.join(outputDir, file))
    return {
      ok: true,
      outputDir: normalized,
      files: outputFiles,
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

app.whenReady().then(createWindow)
