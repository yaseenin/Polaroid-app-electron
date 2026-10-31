import { applyProcessingToPixels, type AdjustmentSettings } from './polaroidEngine'

type WorkerRequest = {
  buffer: ArrayBuffer
  width: number
  height: number
  settings: AdjustmentSettings
}

const workerScope = self as unknown as { postMessage: (message: unknown, transfer: Transferable[]) => void }

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { buffer, width, height, settings } = event.data
  const pixels = new Uint8ClampedArray(buffer)
  applyProcessingToPixels(pixels, width, height, settings)
  // Hand the same memory back without copying.
  workerScope.postMessage({ buffer }, [buffer])
}
