import { buildAdjustmentOperations, type AdjustmentSettings } from './polaroidEngine'

/**
 * Off-thread version of `renderProcessedImage`.
 *
 * The canvas draw + getImageData stay on the main thread (they need the DOM), but the heavy per-pixel
 * loop runs in a Web Worker, so dragging sliders no longer freezes the UI.
 *
 * Two channels, each with its own worker:
 *  - 'preview': latest-wins. While the worker is busy, only the newest request is kept; older queued
 *               requests are rejected with a SupersededError (use `isSuperseded` to ignore it).
 *  - 'export' : every request runs, in order.
 */
export type ProcessChannel = 'preview' | 'export'

class SupersededError extends Error {
  constructor() {
    super('Superseded by a newer preview request.')
    this.name = 'SupersededError'
  }
}

export const isSuperseded = (error: unknown): boolean => error instanceof SupersededError

type Job = {
  buffer: ArrayBuffer
  width: number
  height: number
  settings: AdjustmentSettings
  resolve: (buffer: ArrayBuffer) => void
  reject: (error: Error) => void
}

class WorkerChannel {
  private readonly latestWins: boolean
  private worker: Worker | null = null
  private current: Job | null = null
  private queue: Job[] = []

  constructor(latestWins: boolean) {
    this.latestWins = latestWins
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker

    const worker = new Worker(new URL('./processWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<{ buffer: ArrayBuffer }>) => {
      const job = this.current
      this.current = null
      job?.resolve(event.data.buffer)
      this.pump()
    }
    worker.onerror = (event) => {
      const job = this.current
      this.current = null
      job?.reject(new Error(event.message || 'The image worker failed.'))
      this.pump()
    }
    this.worker = worker
    return worker
  }

  submit(buffer: ArrayBuffer, width: number, height: number, settings: AdjustmentSettings): Promise<ArrayBuffer> {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      if (this.latestWins) {
        for (const stale of this.queue) stale.reject(new SupersededError())
        this.queue = []
      }
      this.queue.push({ buffer, width, height, settings, resolve, reject })
      this.pump()
    })
  }

  private pump() {
    if (this.current || this.queue.length === 0) return
    const job = this.queue.shift() as Job
    this.current = job
    this.ensureWorker().postMessage(
      { buffer: job.buffer, width: job.width, height: job.height, settings: job.settings },
      [job.buffer],
    )
  }
}

const channels: Record<ProcessChannel, WorkerChannel | null> = { preview: null, export: null }

function getChannel(name: ProcessChannel): WorkerChannel {
  channels[name] ??= new WorkerChannel(name === 'preview')
  return channels[name] as WorkerChannel
}

export async function renderProcessedImageAsync(
  image: HTMLImageElement | HTMLCanvasElement,
  settings: AdjustmentSettings,
  options: { channel?: ProcessChannel } = {},
): Promise<HTMLCanvasElement> {
  const width = 'naturalWidth' in image ? image.naturalWidth : image.width
  const height = 'naturalHeight' in image ? image.naturalHeight : image.height

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Canvas 2D context is not available.')
  }
  context.drawImage(image, 0, 0)

  // Nothing to do at neutral settings.
  if (buildAdjustmentOperations(settings).length === 0) {
    return canvas
  }

  const imageData = context.getImageData(0, 0, width, height)
  const result = await getChannel(options.channel ?? 'export').submit(
    imageData.data.buffer as ArrayBuffer,
    width,
    height,
    settings,
  )
  context.putImageData(new ImageData(new Uint8ClampedArray(result), width, height), 0, 0)
  return canvas
}
