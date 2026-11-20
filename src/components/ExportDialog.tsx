import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  PAPER_SIZES,
  PRESETS,
  buildSheetLayout,
  drawExportJobCard,
  getSheetCell,
  getSheetGridDimensions,
  renderSheet,
  type ExportFillOrder,
  type PaperSizeKey,
  type PresetKey,
} from '../engine/polaroidEngine'
import { NEUTRAL_SETTINGS } from '../lib/editorConstants'
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
  fillOrder: ExportFillOrder
  onFillOrderChange: (value: ExportFillOrder) => void
  includeJobCard: boolean
  onIncludeJobCardChange: (value: boolean) => void
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
  onPrint: () => void
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
  fillOrder,
  onFillOrderChange,
  includeJobCard,
  onIncludeJobCardChange,
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
  onPrint,
  onPreviewError,
}: ExportDialogProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 })
  const [sheetSize, setSheetSize] = useState({ width: 0, height: 0 })
  const [previewZoom, setPreviewZoom] = useState(1)
  const [processedAt] = useState(() => new Date())

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
    const viewport = viewportRef.current
    if (!viewport) return
    const observer = new ResizeObserver(([entry]) => {
      setViewportSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  const maxImagesPerPage = useMemo(() => {
    const layout = buildSheetLayout(PRESETS[preset], 1, paperSize, undefined, orientation, includeJobCard)
    return layout.cols * layout.rows
  }, [preset, paperSize, orientation, includeJobCard])

  const totalPages = Math.max(1, Math.ceil(photos.length / maxImagesPerPage))
  const currentPage = Math.min(previewPage, totalPages - 1)
  const photosOnCurrentSheet = Math.min(maxImagesPerPage, Math.max(0, photos.length - currentPage * maxImagesPerPage))
  const fitScale = sheetSize.width && sheetSize.height && viewportSize.width && viewportSize.height
    ? Math.min(
      Math.max(1, viewportSize.width - 32) / sheetSize.width,
      Math.max(1, viewportSize.height - 32) / sheetSize.height,
      1,
    )
    : 1
  const previewWidth = Math.round(sheetSize.width * fitScale * previewZoom)
  const previewHeight = Math.round(sheetSize.height * fitScale * previewZoom)
  const stageWidth = Math.max(viewportSize.width, previewWidth)
  const stageHeight = Math.max(viewportSize.height, previewHeight)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || photos.length === 0) return

    let cancelled = false

    const render = async () => {
      try {
        const startIndex = currentPage * maxImagesPerPage
        const pagePhotos = photos.slice(startIndex, startIndex + maxImagesPerPage)
        const base = PRESETS[preset]
        const cards: HTMLCanvasElement[] = []
        for (const photo of pagePhotos) {
          cards.push(await buildCard(photo, base.photoW, base.photoH, { preview: false }))
          if (cancelled) return
        }
        if (!cards.length) return

        const offset = { offsetX: gridOffsetX, offsetY: gridOffsetY }
        if (format !== 'pdf') {
          const sheet = await renderSheet(cards, preset, NEUTRAL_SETTINGS, paperSize, autoRotate, offset, orientation, processedAt, fillOrder, includeJobCard)
          if (cancelled) return
          canvas.width = sheet.width
          canvas.height = sheet.height
          const context = canvas.getContext('2d')
          if (!context) throw new Error('Unable to initialize the export preview canvas.')
          context.drawImage(sheet, 0, 0)
          setSheetSize({ width: sheet.width, height: sheet.height })
          return
        }

        const layout = buildSheetLayout(base, cards.length, paperSize, offset, orientation, includeJobCard)
        const { cols: usedCols, rows: usedRows } = getSheetGridDimensions(cards.length, layout, fillOrder)
        canvas.width = Math.round(layout.sheetW)
        canvas.height = Math.round(layout.sheetH)
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Unable to initialize the export preview canvas.')
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, canvas.width, canvas.height)

        cards.forEach((card, index) => {
          const { col, row } = getSheetCell(index, layout, fillOrder)
          context.drawImage(
            card,
            layout.marginX + col * base.frameW + base.offsetX,
            layout.marginY + row * base.frameH + base.offsetY,
            base.photoW,
            base.photoH,
          )
        })

        context.strokeStyle = '#000000'
        context.lineWidth = 2
        const gridW = usedCols * base.frameW
        const gridH = usedRows * base.frameH
        for (let i = 0; i <= usedCols; i += 1) {
          const x = layout.marginX + i * base.frameW
          context.beginPath()
          context.moveTo(x, layout.marginY - layout.markLength)
          context.lineTo(x, layout.marginY)
          context.moveTo(x, layout.marginY + gridH)
          context.lineTo(x, layout.marginY + gridH + layout.markLength)
          context.stroke()
        }
        for (let i = 0; i <= usedRows; i += 1) {
          const y = layout.marginY + i * base.frameH
          context.beginPath()
          context.moveTo(layout.marginX - layout.markLength, y)
          context.lineTo(layout.marginX, y)
          context.moveTo(layout.marginX + gridW, y)
          context.lineTo(layout.marginX + gridW + layout.markLength, y)
          context.stroke()
        }
        if (includeJobCard) {
          drawExportJobCard(context, preset, layout, usedRows, processedAt)
        }
        setSheetSize({ width: canvas.width, height: canvas.height })
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
    format,
    gridOffsetX,
    gridOffsetY,
    processedAt,
    fillOrder,
    includeJobCard,
  ])

  return (
    <div className="export-dialog-backdrop" onClick={onClose}>
      <div className="export-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="export-dialog-header">
          <div>
            <h3>Print / export preview</h3>
            <p>Preview the layout before printing or exporting</p>
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
                <label>Fill order</label>
                <select title="Choose photo arrangement order" value={fillOrder} onChange={(event) => onFillOrderChange(event.target.value as ExportFillOrder)}>
                  <option value="columns-first">Column first (top to bottom)</option>
                  <option value="rows-first">Row first (left to right)</option>
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

              <div className="toggle-row job-card-toggle">
                <label>Include job card</label>
                <input
                  type="checkbox"
                  aria-label="Include job card"
                  title="Include the processed date and Polaroid type on the export"
                  checked={includeJobCard}
                  onChange={(event) => onIncludeJobCardChange(event.target.checked)}
                />
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
              <span className="export-preview-meta">Photos on sheet: {photosOnCurrentSheet} / {maxImagesPerPage}</span>
              <span className="export-preview-divider">•</span>
              <span className="export-preview-meta">Pages: {pageCount}</span>
              <span className="export-preview-divider">•</span>
              <span className="export-preview-meta">Orientation: {orientation}</span>
              <span className="export-preview-divider">•</span>
              <span className="export-preview-meta">Fill order: {fillOrder === 'columns-first' ? 'Column first' : 'Row first'}</span>
              <span className="export-preview-divider">•</span>
              <span className="export-preview-meta">Auto rotate: {autoRotate ? 'On' : 'Off'}</span>
              <div className="export-preview-zoom" aria-label="Preview zoom controls">
                <button
                  type="button"
                  title="Zoom out"
                  aria-label="Zoom out"
                  onClick={() => setPreviewZoom((zoom) => Math.max(0.5, Math.round((zoom - 0.25) * 100) / 100))}
                  disabled={previewZoom <= 0.5}
                >
                  −
                </button>
                <span>{Math.round(previewZoom * 100)}%</span>
                <button
                  type="button"
                  title="Zoom in"
                  aria-label="Zoom in"
                  onClick={() => setPreviewZoom((zoom) => Math.min(4, Math.round((zoom + 0.25) * 100) / 100))}
                  disabled={previewZoom >= 4}
                >
                  +
                </button>
                <button type="button" title="Fit preview to window" onClick={() => setPreviewZoom(1)}>Fit</button>
              </div>
            </div>
            <div className="export-preview-viewport" ref={viewportRef}>
              <div className="export-preview-stage" style={{ width: stageWidth, height: stageHeight }}>
                <canvas
                  ref={canvasRef}
                  className="export-preview-canvas"
                  style={{ width: previewWidth, height: previewHeight }}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="export-dialog-actions">
          <button type="button" title="Cancel export" className="ghost-button" onClick={onClose}>Cancel</button>
          <button type="button" title="Open print preview and printer options" className="ghost-button" onClick={onPrint}>Print…</button>
          <button type="button" title="Save export" className="action-button" onClick={onSave}>Save export</button>
        </div>
      </div>
    </div>
  )
}
