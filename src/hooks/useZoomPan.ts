import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { clamp } from '../lib/canvasUtils'
import { MAX_ZOOM, MIN_ZOOM } from '../lib/editorConstants'

type Options = {
  cropMode: boolean
  /** Zoom and pan reset whenever this value changes (the active photo id). */
  resetKey: unknown
}

export function useZoomPan(panelRef: RefObject<HTMLDivElement | null>, { cropMode, resetKey }: Options) {
  const [zoom, setZoom] = useState(1)
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)

  const zoomRef = useRef(1)
  const panRef = useRef({ x: 0, y: 0 })
  const lastPointerRef = useRef({ x: 0, y: 0 })
  const dragRef = useRef<{ pointerId: number; clientX: number; clientY: number; offsetX: number; offsetY: number } | null>(null)

  zoomRef.current = zoom
  panRef.current = panOffset

  const clampPan = (x: number, y: number) => {
    const bounds = panelRef.current?.getBoundingClientRect()
    if (!bounds) return { x, y }
    // Keep the image center inside the panel so it can never be dragged out of reach.
    return { x: clamp(x, -bounds.width / 2, bounds.width / 2), y: clamp(y, -bounds.height / 2, bounds.height / 2) }
  }

  const applyZoom = useCallback(
    (factor: number, anchor?: { x: number; y: number }) => {
      const current = zoomRef.current
      const next = clamp(Number((current * factor).toFixed(2)), MIN_ZOOM, MAX_ZOOM)
      if (next === current) return

      const point = anchor ?? lastPointerRef.current
      const ratio = next / current
      const pan = panRef.current
      const bounds = panelRef.current?.getBoundingClientRect()
      let x = point.x - ratio * (point.x - pan.x)
      let y = point.y - ratio * (point.y - pan.y)
      if (bounds) {
        x = clamp(x, -bounds.width / 2, bounds.width / 2)
        y = clamp(y, -bounds.height / 2, bounds.height / 2)
      }

      zoomRef.current = next
      panRef.current = { x, y }
      setZoom(next)
      setPanOffset({ x, y })
    },
    [panelRef],
  )

  const fitPreview = () => {
    setZoom(1)
    setPanOffset({ x: 0, y: 0 })
  }

  /** Jump to an absolute zoom level (the preset buttons), instead of multiplying the current zoom. */
  const setZoomLevel = (level: number) => {
    if (level === 1) {
      fitPreview()
      return
    }
    applyZoom(level / zoomRef.current, { x: 0, y: 0 })
  }

  // Mouse wheel zoom (needs a non-passive listener so the page does not scroll).
  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      const bounds = panel.getBoundingClientRect()
      const anchor = {
        x: event.clientX - (bounds.left + bounds.width / 2),
        y: event.clientY - (bounds.top + bounds.height / 2),
      }
      lastPointerRef.current = anchor
      applyZoom(event.deltaY < 0 ? 1.1 : 0.9, anchor)
    }

    panel.addEventListener('wheel', handleWheel, { passive: false })
    return () => panel.removeEventListener('wheel', handleWheel)
  }, [applyZoom, panelRef])

  // Reset the view whenever another photo becomes active.
  useEffect(() => {
    setZoom(1)
    setPanOffset({ x: 0, y: 0 })
  }, [resetKey])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (cropMode || zoom <= 1 || event.button !== 0) return

    event.preventDefault()
    const bounds = event.currentTarget.getBoundingClientRect()
    lastPointerRef.current = {
      x: event.clientX - (bounds.left + bounds.width / 2),
      y: event.clientY - (bounds.top + bounds.height / 2),
    }
    dragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      offsetX: panOffset.x,
      offsetY: panOffset.y,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setIsPanning(true)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    lastPointerRef.current = {
      x: event.clientX - (bounds.left + bounds.width / 2),
      y: event.clientY - (bounds.top + bounds.height / 2),
    }

    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    setPanOffset(clampPan(drag.offsetX + event.clientX - drag.clientX, drag.offsetY + event.clientY - drag.clientY))
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setIsPanning(false)
  }

  return {
    zoom,
    panOffset,
    isPanning,
    applyZoom,
    fitPreview,
    setZoomLevel,
    panHandlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
  }
}
