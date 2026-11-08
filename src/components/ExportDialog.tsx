import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  PAPER_SIZES,
  PRESETS,
  buildSheetLayout,
  fitImageToFrame,
  type PaperSizeKey,
  type PresetKey,
} from '../engine/polaroidEngine'
import { DEFAULT_BLUR_RADIUS } from '../lib/canvasUtils'
import type { BuildCard, ExportFormat, ExportOrientation, Photo } from '../types'

type ExportDialogProps = {
  photos: Photo[]
  preset: PresetKey
  onPresetChange: (value: PresetKey) => void
  paperSize: PaperSizeKey
  onPaperSizeChange: (value: PaperSizeKey) => void
  orientation: ExportOrientation
  onOrientationChange: (value: ExportOrientation) => void
  pageCount: number
  onPageCountChange: (value: number) => void
  autoRotate: boolean
  onAutoRotateChange: (value: boolean) => void
  fillBlur: boolean
  onFillBlurChange: (value: boolean) => void
  gridOffsetX: number
  gridOffsetY: number
  onGridOffsetChange: (x: number, y: number) => void
  format: ExportFormat
  onFormatChange: (value: ExportFormat) => void
  previewPage: number
  onPreviewPageChange: (updater: (page: number) => number) => void
  /** Builds a photo "card" exactly the way the real export does. */
  buildCard: BuildCard
  onClose: () => void
  onSave: () => void
  onPreviewError: (message: string) => void
}

export function ExportDialog({
  photos,
  preset,
  onPresetChange,
  paperSize,
  onPaperSizeChange,
  orientation,
  onOrientationChange,
  pageCount,
  onPageCountChange,
  autoRotate,
  onAutoRotateChange,
  fillBlur,
  onFillBlurChange,
  gridOffsetX,
  gridOffsetY,
  onGridOffsetChange,
  format,
  onFormatChange,
  previewPage,
  onPreviewPageChange,
  buildCard,
  onClose,
  onSave,
  onPreviewError,
}: ExportDialogProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerSize, setContainerSize] = useState<{ width: number; height: number } | null>(null)

  // Keeps the latest offset values so auto-repeat intervals never read stale state.
  const offsetRef = useRef({ x: gridOffsetX, y: gridOffsetY })
  offsetRef.current = { x: gridOffsetX, y: gridOffsetY }

  const repeatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intervalTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const startNudge = useCallback((dx: number, dy: number) => {
    const nudge = () => {
      const cur = offsetRef.current
      onGridOffsetChange(cur.x + dx, cur.y + dy)
    }
    nudge()
    repeatTimerRef.current = setTimeout(() => {
      intervalTimerRef.current = setInterval(nudge, 120)
    }, 400)
  }, [onGridOffsetChange])

  const stopNudge = useCallback(() => {
    if (repeatTimerRef.current) {
      clearTimeout(repeatTimerRef.current)
      repeatTimerRef.current = null
    }
    if (intervalTimerRef.current) {
      clearInterval(intervalTimerRef.current)
      intervalTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => stopNudge()
  }, [stopNudge])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        setContainerSize({ width, height })
      }
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  const maxImagesPerPage = useMemo(() => {
    const layout = buildSheetLayout(PRESETS[preset], 1, paperSize)
    return layout.cols * layout.rows
  }, [preset, paperSize])

  const totalPages = Math.max(1, Math.ceil(photos.length / maxImagesPerPage))
  const currentPage = Math.min(previewPage, totalPages - 1)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || photos.length === 0) return

    let cancelled = false

    const render = async () => {
      try {
        const layout = buildSheetLayout(PRESETS[preset], 1, paperSize)
        const startIndex = currentPage * maxImagesPerPage
        const pagePhotos = photos.slice(startIndex, startIndex + maxImagesPerPage)

        const containerW = Math.max(1, (containerSize?.width ?? 640) - 48)
        const containerH = Math.max(1, (containerSize?.height ?? 440) - 48)
        const previewScale = Math.min(containerW / layout.sheetW, containerH / layout.sheetH, 1)
        const sheetW = Math.max(1, Math.round(layout.sheetW * previewScale))
        const sheetH = Math.max(1, Math.round(layout.sheetH * previewScale))

        const base = PRESETS[preset]
        const scaled = {
          ...base,
          frameW: Math.round(base.frameW * previewScale),
          frameH: Math.round(base.frameH * previewScale),
          photoW: Math.round(base.photoW * previewScale),
          photoH: Math.round(base.photoH * previewScale),
          offsetX: Math.round(base.offsetX * previewScale),
          offsetY: Math.round(base.offsetY * previewScale),
        }

        const blurRadius = Math.max(1, DEFAULT_BLUR_RADIUS * previewScale)
        const cards: HTMLCanvasElement[] = []
        for (const photo of pagePhotos) {
          try {
            cards.push(await buildCard(photo, scaled.photoW, scaled.photoH, { preview: true, blurRadius }))
          } catch {
            // Skip photos that fail to load; the rest of the preview still renders.
          }
          if (cancelled) return
        }
        if (!cards.length) return

        const sheet = document.createElement('canvas')
        sheet.width = sheetW
        sheet.height = sheetH
        const sheetContext = sheet.getContext('2d')
        if (!sheetContext) return

        sheetContext.fillStyle = '#ffffff'
        sheetContext.fillRect(0, 0, sheetW, sheetH)

        const usedCols = Math.max(1, Math.ceil(cards.length / layout.rows))
        const usedRows = usedCols > 1 ? layout.rows : Math.max(1, cards.length)
        const marginX = (sheetW - usedCols * scaled.frameW) / 2 + Math.round(gridOffsetX * previewScale)
        const marginY = (sheetH - usedRows * scaled.frameH) / 2 + Math.round(gridOffsetY * previewScale)

        cards.forEach((card, i) => {
          const col = Math.floor(i / layout.rows)
          const row = i % layout.rows
          const x = marginX + col * scaled.frameW
          const y = marginY + row * scaled.frameH
          const fit = fitImageToFrame(card.width, card.height, scaled)
          sheetContext.drawImage(card, x + fit.offsetX, y + fit.offsetY, fit.width, fit.height)
        })

        // Crop marks
        sheetContext.strokeStyle = '#000000'
        sheetContext.lineWidth = 1
        const markLen = Math.round(layout.markLength * previewScale)
        const gridW = usedCols * scaled.frameW
        const gridH = usedRows * scaled.frameH

        for (let i = 0; i <= usedCols; i += 1) {
          const x = marginX + i * scaled.frameW
          sheetContext.beginPath()
          sheetContext.moveTo(x, marginY - markLen)
          sheetContext.lineTo(x, marginY)
          sheetContext.moveTo(x, marginY + gridH)
          sheetContext.lineTo(x, marginY + gridH + markLen)
          sheetContext.stroke()
        }
        for (let i = 0; i <= usedRows; i += 1) {
          const y = marginY + i * scaled.frameH
          sheetContext.beginPath()
          sheetContext.moveTo(marginX - markLen, y)
          sheetContext.lineTo(marginX, y)
          sheetContext.moveTo(marginX + gridW, y)
          sheetContext.lineTo(marginX + gridW + markLen, y)
          sheetContext.stroke()
        }

        canvas.width = sheetW + 40
        canvas.height = sheetH + 40
        const context = canvas.getContext('2d')
        if (!context || cancelled) return

        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, canvas.width, canvas.height)

        const baseX = (canvas.width - sheet.width) / 2
        const baseY = (canvas.height - sheet.height) / 2
        context.fillRect(baseX - 10, baseY - 10, sheet.width + 20, sheet.height + 20)
        context.drawImage(sheet, baseX, baseY)

      } catch {
        if (!cancelled) onPreviewError('Unable to build the export preview.')
      }
    }

    render()
    return () => {
      cancelled = true
    }
  }, [
    photos,
    preset,
    paperSize,
    orientation,
    pageCount,
    autoRotate,
    currentPage,
    maxImagesPerPage,
    buildCard,
    onPreviewError,
    containerSize,
    gridOffsetX,
    gridOffsetY,
  ])

  return (
    <div className="export-dialog-backdrop" onClick={onClose}>
      <div className="export-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="export-dialog-header">
          <div>
            <h3>Export preview</h3>
            <p>Print layout, pages, orientation, and sizing</p>
          </div>
          <button type="button" title="Close export dialog" className="close-dialog" onClick={onClose}>×</button>
        </div>

        <div className="export-dialog-body">
          <div className="export-settings-scroll">
            <div className="export-controls">
              <div className="template-row compact">
                <label>Layout</label>
                <select title="Choose print layout" value={preset} onChange={(event) => onPresetChange(event.target.value as PresetKey)}>
                  {Object.values(PRESETS).map((item) => (
                    <option key={item.key} value={item.key}>{item.label}</option>
                  ))}
                </select>
              </div>

              <div className="template-row compact">
                <label>Paper size</label>
                <select title="Choose paper size" value={paperSize} onChange={(event) => onPaperSizeChange(event.target.value as PaperSizeKey)}>
                  {Object.entries(PAPER_SIZES).map(([key, item]) => (
                    <option key={key} value={key}>{item.label}</option>
                  ))}
                </select>
              </div>

              <div className="template-row compact">
                <label>Orientation</label>
                <select title="Choose export orientation" value={orientation} onChange={(event) => onOrientationChange(event.target.value as ExportOrientation)}>
                  <option value="portrait">Portrait</option>
                  <option value="landscape">Landscape</option>
                </select>
              </div>

              <div className="template-row compact">
                <label>Pages</label>
                <input
                  title="Number of pages"
                  type="number"
                  min={1}
                  max={10}
                  value={pageCount}
                  onChange={(event) => onPageCountChange(Math.min(10, Math.max(1, Number(event.target.value) || 1)))}
                />
              </div>

              <div className="toggle-row">
                <label>Auto rotation</label>
                <input title="Auto rotate images" type="checkbox" checked={autoRotate} onChange={(event) => onAutoRotateChange(event.target.checked)} />
              </div>

              <div className="toggle-row">
                <label>Fill background with blur</label>
                <input title="Fill background with blurred image" type="checkbox" checked={fillBlur} onChange={(event) => onFillBlurChange(event.target.checked)} />
              </div>

              <div className="grid-position-row">
                <label>Grid position</label>
                <div className="grid-position-buttons">
                  <button
                    type="button"
                    title="Nudge grid left"
                    onMouseDown={() => startNudge(-10, 0)}
                    onMouseUp={stopNudge}
                    onMouseLeave={stopNudge}
                    onTouchStart={(event) => {
                      event.preventDefault()
                      startNudge(-10, 0)
                    }}
                    onTouchEnd={stopNudge}
                    onTouchCancel={stopNudge}
                  >
                    ←
                  </button>
                  <button
                    type="button"
                    title="Nudge grid right"
                    onMouseDown={() => startNudge(10, 0)}
                    onMouseUp={stopNudge}
                    onMouseLeave={stopNudge}
                    onTouchStart={(event) => {
                      event.preventDefault()
                      startNudge(10, 0)
                    }}
                    onTouchEnd={stopNudge}
                    onTouchCancel={stopNudge}
                  >
                    →
                  </button>
                  <button
                    type="button"
                    title="Nudge grid up"
                    onMouseDown={() => startNudge(0, -10)}
                    onMouseUp={stopNudge}
                    onMouseLeave={stopNudge}
                    onTouchStart={(event) => {
                      event.preventDefault()
                      startNudge(0, -10)
                    }}
                    onTouchEnd={stopNudge}
                    onTouchCancel={stopNudge}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    title="Nudge grid down"
                    onMouseDown={() => startNudge(0, 10)}
                    onMouseUp={stopNudge}
                    onMouseLeave={stopNudge}
                    onTouchStart={(event) => {
                      event.preventDefault()
                      startNudge(0, 10)
                    }}
                    onTouchEnd={stopNudge}
                    onTouchCancel={stopNudge}
                  >
                    ↓
                  </button>
                  <button type="button" title="Reset grid to center" onClick={() => onGridOffsetChange(0, 0)} className="reset-grid">Reset</button>
                </div>
                <span className="grid-offset-value">{gridOffsetX}, {gridOffsetY}</span>
              </div>

              <div className="template-row compact">
                <label>Export format</label>
                <select title="Choose export format" value={format} onChange={(event) => onFormatChange(event.target.value as ExportFormat)}>
                  <option value="png">PNG</option>
                  <option value="jpeg">JPEG</option>
                  <option value="webp">WebP</option>
                  <option value="pdf">PDF</option>
                </select>
              </div>

              {totalPages > 1 && (
                <div className="export-pagination">
                  <button type="button" onClick={() => onPreviewPageChange((p) => Math.max(0, p - 1))} disabled={currentPage === 0}>Previous</button>
                  <span>Page {currentPage + 1} of {totalPages}</span>
                  <button type="button" onClick={() => onPreviewPageChange((p) => Math.min(totalPages - 1, p + 1))} disabled={currentPage === totalPages - 1}>Next</button>
                </div>
              )}
            </div>
          </div>

          <div className="export-preview-panel">
            <div className="export-preview-header">
              <span className="export-preview-meta">Pages: {pageCount}</span>
              <span className="export-preview-divider">•</span>
              <span className="export-preview-meta">Orientation: {orientation}</span>
              <span className="export-preview-divider">•</span>
              <span className="export-preview-meta">Auto rotate: {autoRotate ? 'On' : 'Off'}</span>
            </div>
            <div className="export-preview-viewport" ref={containerRef}>
              <canvas ref={canvasRef} className="export-preview-canvas" />
            </div>
          </div>
        </div>

        <div className="export-dialog-actions">
          <button type="button" title="Cancel export" className="ghost-button" onClick={onClose}>Cancel</button>
          <button type="button" title="Save export" className="action-button" onClick={onSave}>Save export</button>
        </div>
      </div>
    </div>
  )
}
