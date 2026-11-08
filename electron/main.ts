import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, net, type MenuItemConstructorOptions } from 'electron'
import { PDFDocument } from 'pdf-lib'
import { spawn, spawnSync } from 'node:child_process'
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

ipcMain.handle('save-export', async (_event, payload: { buffers?: ArrayBuffer[]; dataUrls?: string[]; defaultName: string; format?: string; dpi?: number }) => {
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

  if (nodeBuffers.length === 0) {
    return { ok: false, error: 'No image data to save.' }
  }

  if (format === 'pdf') {
    const pdfDoc = await PDFDocument.create()
    const pointsPerPixel = 72 / Math.max(1, payload.dpi ?? 300)

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

  for (let i = 0; i < nodeBuffers.length; i++) {
    const p = nodeBuffers.length === 1 ? normalizedPath : normalizedPath.replace(new RegExp(`\\.${extension}$`, 'i'), `-${i + 1}.${extension}`)
    await fs.promises.writeFile(p, nodeBuffers[i])
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
        { label: 'Process (Rust)', click: () => sendMenuAction('process') },
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
