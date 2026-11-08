import { applyProcessingToPixels, buildAdjustmentOperations, type AdjustmentSettings } from './polaroidEngine'

/**
 * Off-thread version of `renderProcessedImage`.
 *
 * The canvas draw + getImageData stay on the main thread (they need the DOM), but the heavy per-pixel
 * loop runs in a Web Worker, so dragging sliders no longer freezes the UI.
 * If the worker fails or is unsupported in an environment, it falls back seamlessly to main-thread processing.
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
  private failed = false
  private current: Job | null = null
  private queue: Job[] = []

  constructor(latestWins: boolean) {
    this.latestWins = latestWins
  }

  private ensureWorker(): Worker | null {
    if (this.failed) return null
    if (this.worker) return this.worker

    try {
      const worker = new Worker(new URL('./processWorker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (event: MessageEvent<{ buffer: ArrayBuffer }>) => {
        const job = this.current
        this.current = null
        job?.resolve(event.data.buffer)
        this.pump()
      }
      worker.onerror = () => {
        // Fall back gracefully to in-thread processing if worker crashes or fails
        const job = this.current
        this.current = null
        if (job) {
          try {
            const pixels = new Uint8ClampedArray(job.buffer)
            applyProcessingToPixels(pixels, job.width, job.height, job.settings)
            job.resolve(job.buffer)
          } catch (err) {
            job.reject(err instanceof Error ? err : new Error('Processing failed'))
          }
        }
        this.pump()
      }
      this.worker = worker
      return worker
    } catch {
      this.failed = true
      return null
    }
  }

  submit(buffer: ArrayBuffer, width: number, height: number, settings: AdjustmentSettings): Promise<ArrayBuffer> {
    const worker = this.ensureWorker()
    if (!worker || this.failed) {
      // In-thread synchronous execution fallback
      try {
        const pixels = new Uint8ClampedArray(buffer)
        applyProcessingToPixels(pixels, width, height, settings)
        return Promise.resolve(buffer)
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error('Processing failed'))
      }
    }

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
    const worker = this.ensureWorker()
    if (!worker) {
      this.current = null
      try {
        const pixels = new Uint8ClampedArray(job.buffer)
        applyProcessingToPixels(pixels, job.width, job.height, job.settings)
        job.resolve(job.buffer)
      } catch (err) {
        job.reject(err instanceof Error ? err : new Error('Processing failed'))
      }
      this.pump()
      return
    }

    try {
      worker.postMessage(
        { buffer: job.buffer, width: job.width, height: job.height, settings: job.settings },
        [job.buffer],
      )
    } catch {
      // Transfer failed or worker terminated; process inline
      this.current = null
      try {
        const pixels = new Uint8ClampedArray(job.buffer)
        applyProcessingToPixels(pixels, job.width, job.height, job.settings)
        job.resolve(job.buffer)
      } catch (err) {
        job.reject(err instanceof Error ? err : new Error('Processing failed'))
      }
      this.pump()
    }
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
  try {
    const result = await getChannel(options.channel ?? 'export').submit(
      imageData.data.buffer as ArrayBuffer,
      width,
      height,
      settings,
    )
    context.putImageData(new ImageData(new Uint8ClampedArray(result), width, height), 0, 0)
    return canvas
  } catch (err) {
    if (isSuperseded(err)) throw err
    // If worker fails, process in-place on context
    applyProcessingToPixels(imageData.data, width, height, settings)
    context.putImageData(imageData, 0, 0)
    return canvas
  }
}
