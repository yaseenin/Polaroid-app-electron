import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  InputHTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { renderProcessedImageAsync } from '../engine/renderProcessed'
import { NEUTRAL_SETTINGS, SLIDERS } from '../lib/editorConstants'
import { createCroppedCanvas, createFitCanvas } from '../lib/canvasUtils'
import {
  fromMillimetres,
  getPaperBaseDimensionsMm,
  resolveSheetDimensionsMm,
  toMillimetres,
  parseImpositionDocument,
  type ImpositionDocument,
  type ImpositionPaperKey,
  type ImpositionUnits,
} from '../lib/impositionDocument'
import { createAutomaticLayout } from '../lib/impositionLayout'
import { getCutMarkLines } from '../lib/impositionCutMarks'
import { getBridge, toAppFileUrl, type SheetPagePayload } from '../lib/bridge'
import { createImpositionVectorOutput } from '../lib/impositionPdf'
import type { Photo } from '../types'
import './ImpositionBuilder.css'

type Props = {
  document: ImpositionDocument
  onDocumentChange: (document: ImpositionDocument) => void
  photos: Photo[]
  onAddPhoto: (photo: Photo, sheetId: string) => void
  onPrepareAllPhotos: (
    photos: Photo[],
    document: ImpositionDocument,
    sheetId: string,
  ) => Promise<ImpositionDocument>
  onNew: () => void
  onClose: () => void
}

const PAPER_LABELS: Record<ImpositionPaperKey, string> = {
  A3: 'A3',
  A4: 'A4',
  A5: 'A5',
  '13x19': '13 × 19 in',
  '13x9.5': '13 × 9.5 in',
  custom: 'Custom',
}

const UNIT_LABELS: Record<ImpositionUnits, string> = { mm: 'mm', cm: 'cm', in: 'in' }
const CSS_PIXELS_PER_MM = 96 / 25.4
type PreflightIssue = { severity: 'error' | 'warning' | 'info'; message: string }

async function loadAssetImage(source: string): Promise<HTMLImageElement> {
  const image = new Image()
  image.decoding = 'async'
  image.src = source
  try {
    await image.decode()
  } catch {
    throw new Error(`Unable to decode artwork image: ${source.startsWith('data:') ? 'embedded image data' : source}`)
  }
  if (!image.naturalWidth || !image.naturalHeight) throw new Error('Artwork image has invalid dimensions.')
  return image
}

async function canvasToBuffer(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.98))
  if (!blob) throw new Error('Unable to encode an imposition image for PDF export.')
  return blob.arrayBuffer()
}

function formatMeasurement(valueMm: number, units: ImpositionUnits): string {
  return fromMillimetres(valueMm, units).toFixed(units === 'mm' ? 1 : 2)
}

type NumericInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> & {
  value: number | string
  onChange: (value: string) => void
}

function NumericInput({ value, onChange, onFocus, onBlur, ...props }: NumericInputProps) {
  const displayValue = String(value)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(displayValue)

  useEffect(() => {
    if (!editing) setDraft(displayValue)
  }, [displayValue, editing])

  return (
    <input
      {...props}
      type="number"
      inputMode="decimal"
      value={editing ? draft : displayValue}
      onFocus={(event) => {
        setEditing(true)
        setDraft(event.currentTarget.value)
        onFocus?.(event)
      }}
      onBlur={(event) => {
        setEditing(false)
        onBlur?.(event)
      }}
      onChange={(event) => {
        setDraft(event.currentTarget.value)
        onChange(event.currentTarget.value)
      }}
    />
  )
}

export function ImpositionBuilder({
  document,
  onDocumentChange,
  photos,
  onAddPhoto,
  onPrepareAllPhotos,
  onNew,
  onClose,
}: Props) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<{
    mode: 'move' | 'resize'
    pointerId: number
    startX: number
    startY: number
    objectId: string
    sheetId: string
    initial: Map<string, { xMm: number; yMm: number; scaleX: number; scaleY: number }>
    widthMm: number
    heightMm: number
    initialDocument: ImpositionDocument
  } | null>(null)
  const pasteBufferRef = useRef<{
    objects: ImpositionDocument['sheets'][number]['objects']
    layerNames: Map<string, string>
  }>({ objects: [], layerNames: new Map() })
  const editHistoryStartedRef = useRef(false)
  const [zoom, setZoom] = useState(1)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [activeSheetId, setActiveSheetId] = useState(document.sheets[0]?.id ?? '')
  const [preflightIssues, setPreflightIssues] = useState<PreflightIssue[] | null>(null)
  const [exporting, setExporting] = useState(false)
  const [imagePreviews, setImagePreviews] = useState<Record<string, { url?: string; error?: string }>>({})
  const [undoStack, setUndoStack] = useState<ImpositionDocument[]>([])
  const [redoStack, setRedoStack] = useState<ImpositionDocument[]>([])
  const [lockAspectRatio, setLockAspectRatio] = useState(true)
  const [applySizeToAllArtwork, setApplySizeToAllArtwork] = useState(false)
  const [layoutPending, setLayoutPending] = useState(false)
  const activeSheetIndex = Math.max(0, document.sheets.findIndex((current) => current.id === activeSheetId))
  const sheet = document.sheets[activeSheetIndex]!
  const dimensions = useMemo(() => resolveSheetDimensionsMm(sheet), [sheet])
  const widthPx = dimensions.widthMm * CSS_PIXELS_PER_MM * zoom
  const heightPx = dimensions.heightMm * CSS_PIXELS_PER_MM * zoom

  const updateSheet = (update: (current: typeof sheet) => typeof sheet) => {
    if (!editHistoryStartedRef.current) {
      setUndoStack((current) => [...current.slice(-99), document])
      setRedoStack([])
    }
    onDocumentChange({
      ...document,
      sheets: document.sheets.map((current) => (current.id === sheet.id ? update(current) : current)),
    })
  }

  const commitDocument = (next: ImpositionDocument) => {
    setUndoStack((current) => [...current.slice(-99), document])
    setRedoStack([])
    onDocumentChange(next)
  }

  const beginFieldEdit = () => {
    if (editHistoryStartedRef.current) return
    editHistoryStartedRef.current = true
    setUndoStack((current) => [...current.slice(-99), document])
    setRedoStack([])
  }

  const endFieldEdit = () => {
    editHistoryStartedRef.current = false
  }

  const undo = () => {
    const previous = undoStack[undoStack.length - 1]
    if (!previous) return
    setUndoStack((current) => current.slice(0, -1))
    setRedoStack((current) => [...current, document])
    onDocumentChange(previous)
    setSelectedIds([])
  }

  const redo = () => {
    const next = redoStack[redoStack.length - 1]
    if (!next) return
    setRedoStack((current) => current.slice(0, -1))
    setUndoStack((current) => [...current, document])
    onDocumentChange(next)
    setSelectedIds([])
  }

  const createBaseObject = (name: string, type: 'rectangle' | 'ellipse' | 'line' | 'text') => {
    const layer = sheet.layers.find((item) => !item.locked)
    if (!layer) return
    const id = crypto.randomUUID()
    const base = {
      id,
      layerId: layer.id,
      name,
      xMm: sheet.marginsMm.left + 5,
      yMm: sheet.marginsMm.top + 5,
      widthMm: type === 'line' ? 45 : 35,
      heightMm: type === 'line' ? 0.1 : 25,
      rotationDeg: 0,
      scaleX: 1,
      scaleY: 1,
      locked: false,
      visible: true,
    }
    const object = type === 'rectangle'
      ? { ...base, type, fill: '#62a8d1', stroke: '#17232c', strokeWidthMm: 0.4 } as const
      : type === 'ellipse'
        ? { ...base, type, fill: '#62a8d1', stroke: '#17232c', strokeWidthMm: 0.4 } as const
        : type === 'line'
          ? { ...base, type, stroke: '#17232c', strokeWidthMm: 0.5 } as const
          : { ...base, type, text: 'Text', fontFamily: 'Arial', fontSizeMm: 6, fill: '#17232c' } as const
    commitDocument({
      ...document,
      sheets: document.sheets.map((current) => (
        current.id === sheet.id ? { ...current, objects: [...current.objects, object] } : current
      )),
    })
    setSelectedIds([id])
  }

  const selectedObjects = sheet.objects.filter((object) => selectedIds.includes(object.id))
  const selectedObject = selectedObjects[0] ?? null
  const selectedObjectLocked = selectedObject?.locked || sheet.layers.find((layer) => layer.id === selectedObject?.layerId)?.locked
  const activeLayerIds = new Set(sheet.layers.filter((layer) => layer.visible).map((layer) => layer.id))
  const previewSignature = useMemo(() => JSON.stringify(sheet.objects.filter((object) => object.type === 'image').map((object) => {
    if (object.type !== 'image') return null
    const design = document.designs.find((item) => item.id === object.designId)
    const asset = design ? document.assets.find((item) => item.id === design.assetId) : null
    return {
      id: object.id,
      designId: object.designId,
      source: asset?.dataUrl ?? asset?.sourcePath,
      settings: object.settingsOverride ?? design?.settings,
      crop: object.cropOverride !== undefined ? object.cropOverride : design?.crop,
    }
  })), [document.assets, document.designs, sheet.objects])

  const setObjects = (objects: typeof sheet.objects) => {
    commitDocument({
      ...document,
      sheets: document.sheets.map((current) => current.id === sheet.id ? { ...current, objects } : current),
    })
  }

  const objectPoint = (event: { clientX: number; clientY: number }) => {
    const bounds = svgRef.current?.getBoundingClientRect()
    if (!bounds) return { x: 0, y: 0 }
    return {
      x: (event.clientX - bounds.left) / bounds.width * dimensions.widthMm,
      y: (event.clientY - bounds.top) / bounds.height * dimensions.heightMm,
    }
  }

  const beginMove = (event: ReactPointerEvent<SVGGElement>, object: (typeof sheet.objects)[number]) => {
    event.stopPropagation()
    const groupIds = object.groupId
      ? sheet.objects.filter((item) => item.groupId === object.groupId).map((item) => item.id)
      : [object.id]
    const nextSelection = event.shiftKey
      ? selectedIds.includes(object.id)
        ? selectedIds.filter((id) => !groupIds.includes(id))
        : [...new Set([...selectedIds, ...groupIds])]
      : selectedIds.includes(object.id)
        ? selectedIds
        : groupIds
    setSelectedIds(nextSelection)
    const objectLayer = sheet.layers.find((layer) => layer.id === object.layerId)
    if (object.locked || objectLayer?.locked || !nextSelection.includes(object.id)) return
    const movableIds = sheet.objects
      .filter((item) => nextSelection.includes(item.id) && !item.locked && !sheet.layers.find((layer) => layer.id === item.layerId)?.locked)
      .map((item) => item.id)
    const point = objectPoint(event)
    setUndoStack((current) => [...current.slice(-99), document])
    setRedoStack([])
    dragRef.current = {
      mode: 'move',
      pointerId: event.pointerId,
      startX: point.x,
      startY: point.y,
      objectId: object.id,
      sheetId: sheet.id,
      initial: new Map(sheet.objects.filter((item) => movableIds.includes(item.id)).map((item) => [
        item.id,
        { xMm: item.xMm, yMm: item.yMm, scaleX: item.scaleX, scaleY: item.scaleY },
      ])),
      widthMm: object.widthMm * object.scaleX,
      heightMm: object.heightMm * object.scaleY,
      initialDocument: document,
    }
    svgRef.current?.setPointerCapture(event.pointerId)
  }

  const beginResize = (event: ReactPointerEvent<SVGCircleElement>, object: (typeof sheet.objects)[number]) => {
    event.stopPropagation()
    if (object.locked || sheet.layers.find((layer) => layer.id === object.layerId)?.locked) return
    const point = objectPoint(event)
    setSelectedIds([object.id])
    setUndoStack((current) => [...current.slice(-99), document])
    setRedoStack([])
    dragRef.current = {
      mode: 'resize',
      pointerId: event.pointerId,
      startX: point.x,
      startY: point.y,
      objectId: object.id,
      sheetId: sheet.id,
      initial: new Map([[object.id, {
        xMm: object.xMm,
        yMm: object.yMm,
        scaleX: object.scaleX,
        scaleY: object.scaleY,
      }]]),
      widthMm: object.widthMm * object.scaleX,
      heightMm: object.heightMm * object.scaleY,
      initialDocument: document,
    }
    svgRef.current?.setPointerCapture(event.pointerId)
  }

  const snapPosition = (object: (typeof sheet.objects)[number], x: number, y: number) => {
    let snappedX = x
    let snappedY = y
    if (sheet.layout.snapToGrid && sheet.layout.gridMm > 0) {
      snappedX = Math.round(snappedX / sheet.layout.gridMm) * sheet.layout.gridMm
      snappedY = Math.round(snappedY / sheet.layout.gridMm) * sheet.layout.gridMm
    }
    for (const guide of sheet.guides) {
      if (guide.orientation === 'vertical' && Math.abs(snappedX - guide.positionMm) < 1.5) snappedX = guide.positionMm
      if (guide.orientation === 'horizontal' && Math.abs(snappedY - guide.positionMm) < 1.5) snappedY = guide.positionMm
    }
    if (sheet.layout.snapToObjects) {
      const currentWidth = object.widthMm * object.scaleX
      const currentHeight = object.heightMm * object.scaleY
      for (const other of sheet.objects) {
        if (other.id === object.id || dragRef.current?.initial.has(other.id) || !other.visible) continue
        const otherWidth = other.widthMm * other.scaleX
        const otherHeight = other.heightMm * other.scaleY
        const xCandidates = [other.xMm, other.xMm + otherWidth, other.xMm + otherWidth / 2]
        const yCandidates = [other.yMm, other.yMm + otherHeight, other.yMm + otherHeight / 2]
        for (const candidate of xCandidates) {
          if (Math.abs(snappedX - candidate) < 1.5) snappedX = candidate
          if (Math.abs(snappedX + currentWidth - candidate) < 1.5) snappedX = candidate - currentWidth
        }
        for (const candidate of yCandidates) {
          if (Math.abs(snappedY - candidate) < 1.5) snappedY = candidate
          if (Math.abs(snappedY + currentHeight - candidate) < 1.5) snappedY = candidate - currentHeight
        }
      }
    }
    return { x: snappedX, y: snappedY }
  }

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const point = objectPoint(event)
    const dx = point.x - drag.startX
    const dy = point.y - drag.startY
    const currentObject = drag.initialDocument.sheets.find((current) => current.id === drag.sheetId)?.objects.find((item) => item.id === drag.objectId)
    if (!currentObject) return
    if (drag.mode === 'resize') {
      const radians = currentObject.rotationDeg * Math.PI / 180
      const cosine = Math.cos(radians)
      const sine = Math.sin(radians)
      const localDx = dx * cosine + dy * sine
      const localDy = -dx * sine + dy * cosine
      const nextWidth = Math.max(2, drag.widthMm + localDx)
      let nextHeight = Math.max(2, drag.heightMm + localDy)
      const aspect = drag.widthMm / Math.max(0.001, drag.heightMm)
      let width = nextWidth
      if (lockAspectRatio) {
        if (nextWidth / nextHeight > aspect) nextHeight = nextWidth / aspect
        else width = nextHeight * aspect
      }
      const initial = drag.initial.get(currentObject.id)
      if (!initial) return
      const fixedX = currentObject.xMm + drag.widthMm / 2 - drag.widthMm / 2 * cosine + drag.heightMm / 2 * sine
      const fixedY = currentObject.yMm + drag.heightMm / 2 - drag.widthMm / 2 * sine - drag.heightMm / 2 * cosine
      const xMm = fixedX - width / 2 + width / 2 * cosine - nextHeight / 2 * sine
      const yMm = fixedY - nextHeight / 2 + width / 2 * sine + nextHeight / 2 * cosine
      onDocumentChange({
        ...drag.initialDocument,
        sheets: drag.initialDocument.sheets.map((current) => current.id === drag.sheetId ? {
          ...current,
          objects: current.objects.map((item) => item.id === currentObject.id
            ? { ...item, xMm, yMm, scaleX: width / item.widthMm, scaleY: nextHeight / item.heightMm }
            : item),
        } : current),
      })
      return
    }

    const initialActive = drag.initial.get(currentObject.id)
    if (!initialActive) return
    const snapped = snapPosition(currentObject, initialActive.xMm + dx, initialActive.yMm + dy)
    const moveX = snapped.x - initialActive.xMm
    const moveY = snapped.y - initialActive.yMm
    onDocumentChange({
      ...drag.initialDocument,
      sheets: drag.initialDocument.sheets.map((current) => current.id === drag.sheetId ? {
        ...current,
        objects: current.objects.map((item) => {
          const initial = drag.initial.get(item.id)
          return initial ? { ...item, xMm: initial.xMm + moveX, yMm: initial.yMm + moveY } : item
        }),
      } : current),
    })
  }

  const finishPointerAction = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    if (svgRef.current?.hasPointerCapture(event.pointerId)) svgRef.current.releasePointerCapture(event.pointerId)
  }

  const getSelectedObjects = () => {
    const selectedGroupIds = new Set(sheet.objects
      .filter((object) => selectedIds.includes(object.id))
      .map((object) => object.groupId)
      .filter((groupId): groupId is string => Boolean(groupId)))
    return sheet.objects.filter((object) => (
      selectedIds.includes(object.id) || Boolean(object.groupId && selectedGroupIds.has(object.groupId))
    ))
  }

  const cloneObjects = (
    objects: ImpositionDocument['sheets'][number]['objects'],
    resolveLayerId: (object: ImpositionDocument['sheets'][number]['objects'][number]) => string,
  ) => {
    const groupIds = new Map<string, string>()
    return objects.map((object) => {
      const groupId = object.groupId
        ? groupIds.get(object.groupId) ?? crypto.randomUUID()
        : undefined
      if (object.groupId && groupId) groupIds.set(object.groupId, groupId)
      return {
        ...object,
        id: crypto.randomUUID(),
        groupId,
        layerId: resolveLayerId(object),
        name: `${object.name} copy`,
        xMm: object.xMm + 5,
        yMm: object.yMm + 5,
      }
    })
  }

  const duplicateSelected = () => {
    if (!selectedIds.length) return
    const copies = cloneObjects(getSelectedObjects(), (object) => object.layerId)
    setObjects([...sheet.objects, ...copies])
    setSelectedIds(copies.map((object) => object.id))
  }

  const deleteSelected = () => {
    if (!selectedIds.length) return
    setObjects(sheet.objects.filter((object) => !selectedIds.includes(object.id)))
    setSelectedIds([])
  }

  const updateSelected = (update: (object: (typeof sheet.objects)[number]) => (typeof sheet.objects)[number]) => {
    if (!selectedIds.length) return
    if (!editHistoryStartedRef.current) {
      setUndoStack((current) => [...current.slice(-99), document])
      setRedoStack([])
    }
    onDocumentChange({
      ...document,
      sheets: document.sheets.map((current) => current.id === sheet.id ? {
        ...current,
        objects: current.objects.map((object) => selectedIds.includes(object.id) ? update(object) : object),
      } : current),
    })
  }

  const updateArtworkSize = (key: 'widthMm' | 'heightMm', value: number) => {
    if (!selectedObject) return
    const nextSizeMm = toMillimetres(value, document.units)
    if (!applySizeToAllArtwork || selectedObject.type !== 'image') {
      updateSelected((object) => {
        const oldAspect = object.widthMm * object.scaleX / Math.max(0.001, object.heightMm * object.scaleY)
        if (key === 'widthMm') {
          const scaleX = nextSizeMm / Math.max(0.001, object.widthMm)
          const scaleY = lockAspectRatio ? nextSizeMm / oldAspect / Math.max(0.001, object.heightMm) : object.scaleY
          return { ...object, scaleX, scaleY }
        }
        const scaleY = nextSizeMm / Math.max(0.001, object.heightMm)
        const scaleX = lockAspectRatio ? nextSizeMm * oldAspect / Math.max(0.001, object.widthMm) : object.scaleX
        return { ...object, scaleX, scaleY }
      })
      return
    }

    if (!editHistoryStartedRef.current) {
      setUndoStack((current) => [...current.slice(-99), document])
      setRedoStack([])
    }
    const designs = document.designs.map((design) => {
      const aspect = design.widthMm / Math.max(0.001, design.heightMm)
      return {
        ...design,
        widthMm: key === 'widthMm'
          ? nextSizeMm
          : lockAspectRatio ? nextSizeMm * aspect : design.widthMm,
        heightMm: key === 'heightMm'
          ? nextSizeMm
          : lockAspectRatio ? nextSizeMm / aspect : design.heightMm,
      }
    })
    const sizesByDesign = new Map(designs.map((design) => [design.id, design]))
    onDocumentChange({
      ...document,
      designs,
      sheets: document.sheets.map((current) => ({
        ...current,
        objects: current.objects.map((object) => {
          if (object.type !== 'image') return object
          const design = sizesByDesign.get(object.designId)
          return design
            ? { ...object, widthMm: design.widthMm, heightMm: design.heightMm, scaleX: 1, scaleY: 1 }
            : object
        }),
      })),
    })
  }

  const alignSelected = (alignment: 'left' | 'right' | 'top' | 'bottom' | 'center-x' | 'center-y') => {
    if (selectedObjects.length < 2) return
    const bounds = selectedObjects.map((object) => ({
      object,
      width: object.widthMm * object.scaleX,
      height: object.heightMm * object.scaleY,
    }))
    const minX = Math.min(...bounds.map(({ object }) => object.xMm))
    const minY = Math.min(...bounds.map(({ object }) => object.yMm))
    const maxX = Math.max(...bounds.map(({ object, width }) => object.xMm + width))
    const maxY = Math.max(...bounds.map(({ object, height }) => object.yMm + height))
    setObjects(sheet.objects.map((object) => {
      const entry = bounds.find((item) => item.object.id === object.id)
      if (!entry) return object
      const { width, height } = entry
      const xMm = alignment === 'left' ? minX
        : alignment === 'right' ? maxX - width
          : alignment === 'center-x' ? (minX + maxX - width) / 2
            : object.xMm
      const yMm = alignment === 'top' ? minY
        : alignment === 'bottom' ? maxY - height
          : alignment === 'center-y' ? (minY + maxY - height) / 2
            : object.yMm
      return { ...object, xMm, yMm }
    }))
  }

  const distributeSelected = (axis: 'horizontal' | 'vertical') => {
    if (selectedObjects.length < 3) return
    const sorted = [...selectedObjects].sort((a, b) => axis === 'horizontal' ? a.xMm - b.xMm : a.yMm - b.yMm)
    const first = sorted[0]
    const last = sorted[sorted.length - 1]
    const start = axis === 'horizontal' ? first.xMm : first.yMm
    const lastSize = axis === 'horizontal' ? last.widthMm * last.scaleX : last.heightMm * last.scaleY
    const end = axis === 'horizontal' ? last.xMm + lastSize : last.yMm + lastSize
    const totalSize = sorted.reduce((sum, object) => sum + (axis === 'horizontal' ? object.widthMm * object.scaleX : object.heightMm * object.scaleY), 0)
    const gap = (end - start - totalSize) / (sorted.length - 1)
    let cursor = start
    const positions = new Map<string, number>()
    for (const object of sorted) {
      positions.set(object.id, cursor)
      cursor += (axis === 'horizontal' ? object.widthMm * object.scaleX : object.heightMm * object.scaleY) + gap
    }
    setObjects(sheet.objects.map((object) => {
      const position = positions.get(object.id)
      if (position === undefined) return object
      return axis === 'horizontal' ? { ...object, xMm: position } : { ...object, yMm: position }
    }))
  }

  const groupSelected = () => {
    if (selectedIds.length < 2) return
    const groupId = crypto.randomUUID()
    setObjects(sheet.objects.map((object) => selectedIds.includes(object.id) ? { ...object, groupId } : object))
  }

  const ungroupSelected = () => {
    if (!selectedIds.length) return
    setObjects(sheet.objects.map((object) => selectedIds.includes(object.id) ? { ...object, groupId: undefined } : object))
  }

  const addGuide = (orientation: 'horizontal' | 'vertical') => {
    const positionMm = orientation === 'horizontal' ? dimensions.heightMm / 2 : dimensions.widthMm / 2
    const guide = { id: crypto.randomUUID(), orientation, positionMm, locked: false }
    commitDocument({
      ...document,
      sheets: document.sheets.map((current) => (
        current.id === sheet.id ? { ...current, guides: [...current.guides, guide] } : current
      )),
    })
  }

  const addLayer = () => {
    const layer = { id: crypto.randomUUID(), name: `Layer ${sheet.layers.length + 1}`, visible: true, locked: false }
    commitDocument({
      ...document,
      sheets: document.sheets.map((current) => (
        current.id === sheet.id ? { ...current, layers: [...current.layers, layer] } : current
      )),
    })
  }

  const updateLayer = (layerId: string, update: (layer: (typeof sheet.layers)[number]) => (typeof sheet.layers)[number]) => {
    commitDocument({
      ...document,
      sheets: document.sheets.map((current) => current.id === sheet.id
        ? { ...current, layers: current.layers.map((layer) => layer.id === layerId ? update(layer) : layer) }
        : current),
    })
  }

  const makeSheetCopy = (includeObjects: boolean, name: string) => {
    const layerIds = new Map(sheet.layers.map((layer) => [layer.id, crypto.randomUUID()]))
    const groupIds = new Map<string, string>()
    const objects = includeObjects ? sheet.objects.map((object) => {
      const groupId = object.groupId
        ? groupIds.get(object.groupId) ?? crypto.randomUUID()
        : undefined
      if (object.groupId && groupId) groupIds.set(object.groupId, groupId)
      return {
        ...object,
        id: crypto.randomUUID(),
        layerId: layerIds.get(object.layerId) ?? object.layerId,
        groupId,
      }
    }) : []
    return {
      ...sheet,
      id: crypto.randomUUID(),
      name,
      generatedFromSheetId: undefined,
      layers: sheet.layers.map((layer) => ({ ...layer, id: layerIds.get(layer.id)! })),
      objects,
      guides: includeObjects ? sheet.guides.map((guide) => ({ ...guide, id: crypto.randomUUID() })) : [],
    }
  }

  const addSheet = () => {
    const newSheet = makeSheetCopy(false, `Sheet ${document.sheets.length + 1}`)
    commitDocument({ ...document, sheets: [...document.sheets, newSheet] })
    setActiveSheetId(newSheet.id)
    setSelectedIds([])
  }

  const duplicateSheet = () => {
    const duplicate = makeSheetCopy(true, `${sheet.name} copy`)
    const sheets = [...document.sheets]
    sheets.splice(activeSheetIndex + 1, 0, duplicate)
    commitDocument({ ...document, sheets })
    setActiveSheetId(duplicate.id)
    setSelectedIds([])
  }

  const deleteSheet = () => {
    if (document.sheets.length < 2) return
    if (!window.confirm(`Delete "${sheet.name}" and all of its objects?`)) return
    const sheets = document.sheets.filter((item) => item.id !== sheet.id)
    commitDocument({ ...document, sheets })
    setActiveSheetId(sheets[Math.max(0, activeSheetIndex - 1)].id)
    setSelectedIds([])
  }

  const moveSheet = (direction: -1 | 1) => {
    const targetIndex = activeSheetIndex + direction
    if (targetIndex < 0 || targetIndex >= document.sheets.length) return
    const sheets = [...document.sheets]
    ;[sheets[activeSheetIndex], sheets[targetIndex]] = [sheets[targetIndex], sheets[activeSheetIndex]]
    commitDocument({ ...document, sheets })
  }

  const generateAutomaticLayout = async (includeLibraryPhotos = false) => {
    if (layoutPending) return
    setLayoutPending(true)
    try {
      const sourceDocument = includeLibraryPhotos && photos.length
        ? await onPrepareAllPhotos(photos, document, sheet.id)
        : document
      const result = createAutomaticLayout(sourceDocument, sheet.id)
      commitDocument(result.document)
      setActiveSheetId(result.sourceSheetId)
      setSelectedIds([])
      const warning = result.unplacedDesignNames.length
        ? ` ${result.unplacedDesignNames.length} copy/copies could not fit: ${[...new Set(result.unplacedDesignNames)].join(', ')}.`
        : ''
      const quantities = result.designQuantities
        .map((item) => `${item.name}: ${item.placed}/${item.requested}`)
        .join('; ')
      const wastePercent = Math.max(0, 100 - result.utilizationPercent)
      window.alert(
        `Placed ${result.placedCopies}/${result.requestedCopies} requested copies across ${result.sheetsUsed} sheet(s). `
        + `Artwork utilization: ${result.utilizationPercent.toFixed(1)}%; unused printable area: ${wastePercent.toFixed(1)}%. `
        + `Quantities: ${quantities}.${warning}`,
      )
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Could not generate the automatic layout.')
    } finally {
      setLayoutPending(false)
    }
  }

  const saveImpositionProject = async () => {
    try {
      const bridge = getBridge()
      if (!bridge?.saveProject) throw new Error('Project saving is available only in the desktop application.')
      const result = await bridge.saveProject(document)
      if (result.canceled) return
      if (!result.ok) throw new Error(result.error ?? 'Unable to save the imposition project.')
      window.alert(`Imposition project saved to ${result.filePath ?? 'the selected location'}.`)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Unable to save the imposition project.')
    }
  }

  const openImpositionProject = async () => {
    try {
      const bridge = getBridge()
      if (!bridge?.openProject) throw new Error('Project opening is available only in the desktop application.')
      const result = await bridge.openProject()
      if (result.canceled) return
      if (result.error) throw new Error(result.error)
      const next = parseImpositionDocument(result.project)
      onDocumentChange(next)
      setActiveSheetId(next.sheets[0].id)
      setSelectedIds([])
      setUndoStack([])
      setRedoStack([])
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Unable to open the imposition project.')
    }
  }

  const getObjectBounds = (object: (typeof sheet.objects)[number]) => {
    const width = object.widthMm * object.scaleX
    const height = object.heightMm * object.scaleY
    const centerX = object.xMm + width / 2
    const centerY = object.yMm + height / 2
    const angle = object.rotationDeg * Math.PI / 180
    const corners = [
      [-width / 2, -height / 2],
      [width / 2, -height / 2],
      [width / 2, height / 2],
      [-width / 2, height / 2],
    ].map(([x, y]) => ({
      x: centerX + x * Math.cos(angle) - y * Math.sin(angle),
      y: centerY + x * Math.sin(angle) + y * Math.cos(angle),
    }))
    const xs = corners.map((point) => point.x)
    const ys = corners.map((point) => point.y)
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    }
  }

  const collectPreflightIssues = async (): Promise<PreflightIssue[]> => {
    const issues: PreflightIssue[] = []
    const verifiedAssets = new Map<string, { width: number; height: number } | null>()
    const verifyAsset = async (assetId: string) => {
      if (verifiedAssets.has(assetId)) return verifiedAssets.get(assetId) ?? null
      const asset = document.assets.find((item) => item.id === assetId)
      if (!asset || (!asset.dataUrl && !asset.sourcePath)) {
        verifiedAssets.set(assetId, null)
        return null
      }
      try {
        const image = await loadAssetImage(asset.dataUrl ?? toAppFileUrl(asset.sourcePath!))
        const result = { width: image.naturalWidth, height: image.naturalHeight }
        image.src = ''
        verifiedAssets.set(assetId, result)
        return result
      } catch {
        verifiedAssets.set(assetId, null)
        return null
      }
    }

    for (const currentSheet of document.sheets) {
      const size = resolveSheetDimensionsMm(currentSheet)
      if (!Number.isFinite(size.widthMm) || !Number.isFinite(size.heightMm) || size.widthMm <= 0 || size.heightMm <= 0) {
        issues.push({ severity: 'error', message: `${currentSheet.name}: invalid sheet dimensions.` })
        continue
      }
      const visibleObjects = currentSheet.objects.filter((object) => (
        object.visible && currentSheet.layers.some((layer) => layer.id === object.layerId && layer.visible)
      ))
      const imageBounds: ReturnType<typeof getObjectBounds>[] = []
      for (const object of visibleObjects) {
        const bounds = getObjectBounds(object)
        if (bounds.x < 0 || bounds.y < 0 || bounds.x + bounds.width > size.widthMm || bounds.y + bounds.height > size.heightMm) {
          issues.push({ severity: 'error', message: `${currentSheet.name}: "${object.name}" extends outside the sheet.` })
        } else if (
          bounds.x < currentSheet.marginsMm.left
          || bounds.y < currentSheet.marginsMm.top
          || bounds.x + bounds.width > size.widthMm - currentSheet.marginsMm.right
          || bounds.y + bounds.height > size.heightMm - currentSheet.marginsMm.bottom
        ) {
          issues.push({ severity: 'warning', message: `${currentSheet.name}: "${object.name}" extends outside the printable margins.` })
        }
        if (object.type === 'image') {
          imageBounds.push(bounds)
          const design = document.designs.find((item) => item.id === object.designId)
          const asset = design ? document.assets.find((item) => item.id === design.assetId) : null
          if (!design || !asset) {
            issues.push({ severity: 'error', message: `${currentSheet.name}: "${object.name}" has a missing artwork or design reference.` })
            continue
          }
          const decoded = await verifyAsset(asset.id)
          if (!decoded) {
            issues.push({ severity: 'error', message: `${currentSheet.name}: "${asset.name}" has missing or unreadable image data.` })
            continue
          }
          const crop = object.cropOverride !== undefined ? object.cropOverride : design.crop
          const cropWidth = crop?.width ?? 1
          const cropHeight = crop?.height ?? 1
          const effectiveDpi = Math.min(
            decoded.width * cropWidth / Math.max(0.001, object.widthMm * object.scaleX / 25.4),
            decoded.height * cropHeight / Math.max(0.001, object.heightMm * object.scaleY / 25.4),
          )
          if (effectiveDpi < document.export.dpi) {
            issues.push({
              severity: 'warning',
              message: `${currentSheet.name}: "${object.name}" is about ${Math.round(effectiveDpi)} effective DPI; below the ${document.export.dpi} DPI export setting.`,
            })
          }
        } else if (object.type === 'pdf-page') {
          issues.push({ severity: 'error', message: `${currentSheet.name}: embedded PDF pages are not yet supported for output.` })
        }
      }
      for (let first = 0; first < imageBounds.length; first += 1) {
        for (let second = first + 1; second < imageBounds.length; second += 1) {
          const a = imageBounds[first]
          const b = imageBounds[second]
          if (a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y) {
            issues.push({ severity: 'warning', message: `${currentSheet.name}: artwork objects overlap.` })
          }
        }
      }
      if (currentSheet.cutMarks.enabled && currentSheet.bleedMm <= 0) {
        issues.push({ severity: 'warning', message: `${currentSheet.name}: cut marks are enabled but no bleed is configured.` })
      }
      if (document.export.includeCutMarks) {
        const outside = getCutMarkLines(currentSheet, true).some((mark) => (
          mark.x1 < 0 || mark.y1 < 0 || mark.x2 < 0 || mark.y2 < 0
          || mark.x1 > size.widthMm || mark.x2 > size.widthMm
          || mark.y1 > size.heightMm || mark.y2 > size.heightMm
        ))
        if (outside) issues.push({ severity: 'error', message: `${currentSheet.name}: one or more cut marks fall outside the page.` })
      }
    }
    issues.push({
      severity: 'info',
      message: 'PDF images remain RGB. This exporter does not embed ICC profiles or certify PDF/X/CMYK output.',
    })
    return issues
  }

  const reviewPreflight = async () => {
    setExporting(true)
    try {
      setPreflightIssues(await collectPreflightIssues())
    } catch (error) {
      setPreflightIssues([{
        severity: 'error',
        message: error instanceof Error ? error.message : 'Preflight could not inspect this document.',
      }])
    } finally {
      setExporting(false)
    }
  }

  const exportPrintReadyPdf = async () => {
    setExporting(true)
    try {
      const bridge = getBridge()
      if (!bridge?.saveExport) throw new Error('PDF export is available only in the desktop application.')
      const dpi = document.export.dpi
      const pixelsPerMm = dpi / 25.4
      const pages: SheetPagePayload[] = []
      for (const currentSheet of document.sheets) {
        const dimensions = resolveSheetDimensionsMm(currentSheet)
        const images: SheetPagePayload['images'] = []
        const lines: SheetPagePayload['lines'] = []
        const vectors: NonNullable<SheetPagePayload['vectors']> = []
        const text: NonNullable<SheetPagePayload['text']> = []
        for (const object of currentSheet.objects) {
          if (!object.visible || !currentSheet.layers.some((layer) => layer.id === object.layerId && layer.visible)) continue
          if (object.type === 'image') {
            const design = document.designs.find((item) => item.id === object.designId)
            const asset = design ? document.assets.find((item) => item.id === design.assetId) : null
            if (!design || !asset) throw new Error(`"${object.name}" references missing image data.`)
            const source = await loadAssetImage(asset.dataUrl ?? toAppFileUrl(asset.sourcePath!))
            const settings = object.settingsOverride ?? design.settings
            const crop = object.cropOverride !== undefined ? object.cropOverride : design.crop
            let processed = await renderProcessedImageAsync(source, settings, { channel: 'export' })
            if (crop) processed = createCroppedCanvas(processed, crop)
            const targetWidth = Math.max(1, Math.round(object.widthMm * object.scaleX * pixelsPerMm))
            const targetHeight = Math.max(1, Math.round(object.heightMm * object.scaleY * pixelsPerMm))
            const fitted = createFitCanvas(processed, targetWidth, targetHeight, false, object.fit)
            let encodedCanvas = fitted
            if (object.flipX || object.flipY) {
              const flipped = window.document.createElement('canvas')
              flipped.width = fitted.width
              flipped.height = fitted.height
              const context = flipped.getContext('2d')
              if (!context) throw new Error(`Unable to prepare "${object.name}" for export.`)
              context.translate(object.flipX ? flipped.width : 0, object.flipY ? flipped.height : 0)
              context.scale(object.flipX ? -1 : 1, object.flipY ? -1 : 1)
              context.drawImage(fitted, 0, 0)
              encodedCanvas = flipped
            }
            const buffer = await canvasToBuffer(encodedCanvas)
            source.src = ''
            encodedCanvas.width = 0
            encodedCanvas.height = 0
            if (fitted !== encodedCanvas) {
              fitted.width = 0
              fitted.height = 0
            }
            if (processed instanceof HTMLCanvasElement && processed !== fitted) {
              processed.width = 0
              processed.height = 0
            }
            images.push({
              buffer,
              x: object.xMm * pixelsPerMm,
              y: object.yMm * pixelsPerMm,
              width: object.widthMm * object.scaleX * pixelsPerMm,
              height: object.heightMm * object.scaleY * pixelsPerMm,
              rotationDeg: object.rotationDeg,
            })
          } else if (object.type !== 'pdf-page') {
            const output = createImpositionVectorOutput(object, dpi)
            vectors.push(...output.vectors)
            text.push(...output.text)
          } else {
            throw new Error(`"${object.name}" is a PDF page, which is not yet supported in output.`)
          }
        }
        if (document.export.includeCutMarks) {
          for (const mark of getCutMarkLines(currentSheet, true)) {
            lines.push({
              x1: mark.x1 * pixelsPerMm,
              y1: mark.y1 * pixelsPerMm,
              x2: mark.x2 * pixelsPerMm,
              y2: mark.y2 * pixelsPerMm,
              width: mark.widthMm * pixelsPerMm,
              color: mark.color,
              dashArray: mark.dashArray?.split(' ').map((value) => Number(value) * pixelsPerMm),
            })
          }
        }
        pages.push({
          width: dimensions.widthMm * pixelsPerMm,
          height: dimensions.heightMm * pixelsPerMm,
          images,
          lines,
          vectors,
          text,
        })
      }
      const result = await bridge.saveExport({
        mime: 'image/jpeg',
        defaultName: `${document.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'imposition'}.pdf`,
        format: 'pdf',
        dpi,
        pdfPages: pages,
      })
      if (result.canceled) return
      if (!result.ok) throw new Error(result.error ?? 'Unable to save the print-ready PDF.')
      window.alert(`Print-ready PDF saved to ${result.filePath ?? 'the selected location'}.`)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Unable to export the print-ready PDF.')
    } finally {
      setExporting(false)
    }
  }

  const copySelected = () => {
    pasteBufferRef.current = {
      objects: getSelectedObjects(),
      layerNames: new Map(sheet.layers.map((layer) => [layer.id, layer.name])),
    }
  }

  const pasteSelected = () => {
    if (!pasteBufferRef.current.objects.length) return
    const targetLayerIds = new Map<string, string>()
    for (const object of pasteBufferRef.current.objects) {
      if (targetLayerIds.has(object.layerId)) continue
      const sourceLayerName = pasteBufferRef.current.layerNames.get(object.layerId)
      const targetLayer = sheet.layers.find((layer) => layer.id === object.layerId)
        ?? sheet.layers.find((layer) => layer.name === sourceLayerName)
        ?? sheet.layers.find((layer) => !layer.locked)
      if (!targetLayer) {
        window.alert('The current sheet has no layer available for pasted objects.')
        return
      }
      targetLayerIds.set(object.layerId, targetLayer.id)
    }
    const copies = cloneObjects(
      pasteBufferRef.current.objects,
      (object) => targetLayerIds.get(object.layerId) ?? object.layerId,
    )
    setObjects([...sheet.objects, ...copies])
    setSelectedIds(copies.map((object) => object.id))
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return
    const mod = event.ctrlKey || event.metaKey
    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      if (event.shiftKey) redo()
      else undo()
    } else if (mod && event.key.toLowerCase() === 'y') {
      event.preventDefault()
      redo()
    } else if (mod && event.key.toLowerCase() === 'c') {
      event.preventDefault()
      copySelected()
    } else if (mod && event.key.toLowerCase() === 'v') {
      event.preventDefault()
      pasteSelected()
    } else if (mod && event.key.toLowerCase() === 'd') {
      event.preventDefault()
      duplicateSelected()
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedIds.length) {
      event.preventDefault()
      deleteSelected()
    } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && selectedIds.length) {
      event.preventDefault()
      const step = event.shiftKey ? 5 : 1
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
      const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
      setObjects(sheet.objects.map((object) => selectedIds.includes(object.id)
        ? { ...object, xMm: object.xMm + dx, yMm: object.yMm + dy }
        : object))
    }
  }

  const fitSheet = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const availableWidth = Math.max(100, viewport.clientWidth - 100)
    const availableHeight = Math.max(100, viewport.clientHeight - 100)
    setZoom(Math.min(1, availableWidth / (dimensions.widthMm * CSS_PIXELS_PER_MM), availableHeight / (dimensions.heightMm * CSS_PIXELS_PER_MM)))
  }, [dimensions.heightMm, dimensions.widthMm])

  useEffect(() => {
    fitSheet()
    const viewport = viewportRef.current
    if (!viewport) return
    const observer = new ResizeObserver(fitSheet)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [fitSheet])

  useEffect(() => {
    if (!document.sheets.some((current) => current.id === activeSheetId)) {
      setActiveSheetId(document.sheets[0]?.id ?? '')
      setSelectedIds([])
    }
  }, [activeSheetId, document.sheets])

  useEffect(() => {
    let cancelled = false
    const createdUrls = new Set<string>()
    setImagePreviews({})
    const buildPreviews = async () => {
      const results: Record<string, { url?: string; error?: string }> = {}
      const cache = new Map<string, string>()
      const previewItems = JSON.parse(previewSignature) as Array<{
        id: string
        source?: string
        settings?: ImpositionDocument['designs'][number]['settings']
        crop?: ImpositionDocument['designs'][number]['crop']
      }>
      for (const item of previewItems) {
        if (!item.settings || !item.source) {
          results[item.id] = { error: 'Missing image or design reference.' }
          continue
        }
        const source = item.source.startsWith('data:') ? item.source : toAppFileUrl(item.source)
        const cacheKey = JSON.stringify([source, item.settings, item.crop])
        const cached = cache.get(cacheKey)
        if (cached) {
          results[item.id] = { url: cached }
          continue
        }
        let proxy: HTMLCanvasElement | null = null
        let processed: HTMLCanvasElement | null = null
        try {
          const image = await loadAssetImage(source)
          if (cancelled) {
            image.src = ''
            return
          }
          const scale = Math.min(1, 1200 / Math.max(image.naturalWidth, image.naturalHeight))
          proxy = window.document.createElement('canvas')
          proxy.width = Math.max(1, Math.round(image.naturalWidth * scale))
          proxy.height = Math.max(1, Math.round(image.naturalHeight * scale))
          const context = proxy.getContext('2d')
          if (!context) throw new Error('Unable to prepare artwork preview.')
          context.drawImage(image, 0, 0, proxy.width, proxy.height)
          image.src = ''
          processed = await renderProcessedImageAsync(proxy, item.settings, { channel: 'preview' })
          if (item.crop) processed = createCroppedCanvas(processed, item.crop)
          const blob = await new Promise<Blob | null>((resolve) => processed?.toBlob(resolve, 'image/png'))
          if (!blob) throw new Error('Unable to encode artwork preview.')
          const url = URL.createObjectURL(blob)
          createdUrls.add(url)
          cache.set(cacheKey, url)
          results[item.id] = { url }
        } catch (error) {
          results[item.id] = { error: error instanceof Error ? error.message : 'Unable to render artwork preview.' }
        } finally {
          if (proxy) {
            proxy.width = 0
            proxy.height = 0
          }
          if (processed && processed !== proxy) {
            processed.width = 0
            processed.height = 0
          }
        }
      }
      if (!cancelled) setImagePreviews(results)
    }
    void buildPreviews().catch((error) => {
      if (!cancelled) setImagePreviews({ '*': { error: error instanceof Error ? error.message : 'Unable to render artwork previews.' } })
    })
    return () => {
      cancelled = true
      createdUrls.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [previewSignature, sheet.id])

  const updateMeasurement = (key: 'top' | 'right' | 'bottom' | 'left', value: string) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < 0) return
    updateSheet((current) => ({
      ...current,
      marginsMm: { ...current.marginsMm, [key]: toMillimetres(parsed, document.units) },
    }))
  }

  const setPaperSize = (size: ImpositionPaperKey) => {
    if (size === 'custom') {
      updateSheet((current) => ({ ...current, paper: { ...current.paper, size } }))
      return
    }
    const [widthMm, heightMm] = getPaperBaseDimensionsMm(size)
    updateSheet((current) => ({ ...current, paper: { ...current.paper, size, widthMm, heightMm } }))
  }

  const setCustomDimension = (key: 'widthMm' | 'heightMm', value: string) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) return
    updateSheet((current) => {
      const baseIsPortrait = current.paper.heightMm >= current.paper.widthMm
      const orientationIsPortrait = current.paper.orientation === 'portrait'
      const storedKey = baseIsPortrait !== orientationIsPortrait
        ? key === 'widthMm' ? 'heightMm' : 'widthMm'
        : key
      return {
        ...current,
        paper: { ...current.paper, size: 'custom', [storedKey]: toMillimetres(parsed, document.units) },
      }
    })
  }

  const renderObject = (object: (typeof sheet.objects)[number]) => {
    const width = object.widthMm * object.scaleX
    const height = Math.max(0, object.heightMm * object.scaleY)
    const centerX = object.xMm + width / 2
    const centerY = object.yMm + height / 2
    const selected = selectedIds.includes(object.id)
    const design = object.type === 'image' ? document.designs.find((item) => item.id === object.designId) : null
    const objectLayerLocked = sheet.layers.find((layer) => layer.id === object.layerId)?.locked
    const asset = object.type === 'pdf-page'
      ? document.assets.find((item) => item.id === object.assetId)
      : design ? document.assets.find((item) => item.id === design.assetId) : null
    const imagePreview = object.type === 'image' ? imagePreviews[object.id] ?? imagePreviews['*'] : undefined
    const href = object.type === 'image'
      ? imagePreview?.url ?? ''
      : asset?.dataUrl ?? (asset?.sourcePath ? toAppFileUrl(asset.sourcePath) : '')
    const interaction = {
      onPointerDown: (event: ReactPointerEvent<SVGGElement>) => beginMove(event, object),
    }

    return (
      <g key={object.id} className={`imposition-object${selected ? ' selected' : ''}${object.locked ? ' locked' : ''}`} {...interaction}>
        <g transform={`rotate(${object.rotationDeg} ${centerX} ${centerY})`}>
          {object.type === 'image' ? (
            href ? (
              <image
                href={href}
                x={object.xMm}
                y={object.yMm}
                width={width}
                height={height}
                preserveAspectRatio={object.fit === 'contain' ? 'xMidYMid meet' : 'xMidYMid slice'}
                transform={`translate(${object.flipX ? 2 * centerX : 0} ${object.flipY ? 2 * centerY : 0}) scale(${object.flipX ? -1 : 1} ${object.flipY ? -1 : 1})`}
              />
            ) : (
              <g>
                <rect x={object.xMm} y={object.yMm} width={width} height={height} fill={imagePreview?.error ? '#5d3030' : '#28323b'} stroke={imagePreview?.error ? '#e26d6d' : '#53616c'} />
                <text x={centerX} y={centerY} textAnchor="middle" fontSize="4" fill="#e7edf2">
                  {imagePreview?.error ? 'Preview unavailable' : 'Rendering preview...'}
                </text>
              </g>
            )
          ) : object.type === 'rectangle' ? (
            <rect x={object.xMm} y={object.yMm} width={width} height={height} fill={object.fill ?? 'none'} stroke={object.stroke} strokeWidth={object.strokeWidthMm} />
          ) : object.type === 'ellipse' ? (
            <ellipse cx={centerX} cy={centerY} rx={width / 2} ry={height / 2} fill={object.fill ?? 'none'} stroke={object.stroke} strokeWidth={object.strokeWidthMm} />
          ) : object.type === 'line' ? (
            <line x1={object.xMm} y1={object.yMm} x2={object.xMm + width} y2={object.yMm + height} stroke={object.stroke} strokeWidth={object.strokeWidthMm} />
          ) : object.type === 'polygon' ? (
            <polygon points={object.points.map((point) => `${object.xMm + point.xMm * object.scaleX},${object.yMm + point.yMm * object.scaleY}`).join(' ')} fill={object.fill ?? 'none'} stroke={object.stroke} strokeWidth={object.strokeWidthMm} />
          ) : object.type === 'text' ? (
            <text x={object.xMm} y={object.yMm + object.fontSizeMm} fontFamily={object.fontFamily} fontSize={object.fontSizeMm} fill={object.fill}>{object.text}</text>
          ) : (
            <g>
              <rect x={object.xMm} y={object.yMm} width={width} height={height} fill="#e9eef2" stroke="#71808b" strokeDasharray="2 1" />
              <text x={centerX} y={centerY} textAnchor="middle" fontSize="4" fill="#43515c">{asset?.name ?? 'PDF page'}</text>
            </g>
          )}
          {selected ? (
            <rect
              className="imposition-selection"
              x={object.xMm}
              y={object.yMm}
              width={width}
              height={height}
              fill="none"
              stroke="#168fe0"
              strokeWidth="0.35"
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          ) : null}
        </g>
        {selected && selectedIds.length === 1 && !object.locked && !objectLayerLocked ? (
          <circle
            className="imposition-resize-handle"
            cx={centerX + width / 2 * Math.cos(object.rotationDeg * Math.PI / 180) - height / 2 * Math.sin(object.rotationDeg * Math.PI / 180)}
            cy={centerY + width / 2 * Math.sin(object.rotationDeg * Math.PI / 180) + height / 2 * Math.cos(object.rotationDeg * Math.PI / 180)}
            r="2"
            onPointerDown={(event) => beginResize(event, object)}
          />
        ) : null}
      </g>
    )
  }

  const rulerStep = dimensions.widthMm > 500 ? 50 : 10
  const horizontalTicks = Array.from({ length: Math.floor(dimensions.widthMm / rulerStep) + 1 }, (_, index) => index * rulerStep)
  const verticalTicks = Array.from({ length: Math.floor(dimensions.heightMm / rulerStep) + 1 }, (_, index) => index * rulerStep)
  const margin = sheet.marginsMm

  return (
    <div className="imposition-app" tabIndex={0} onKeyDown={handleKeyDown}>
      <header className="imposition-toolbar">
        <div className="imposition-brand"><span className="imposition-brand-mark">P</span><strong>Imposition Builder</strong></div>
        <div className="imposition-toolbar-actions">
          <div className="imposition-toolbar-group" role="group" aria-label="Project">
            <button type="button" onClick={onNew}>New</button>
            <button type="button" onClick={() => void openImpositionProject()}>Open</button>
            <button type="button" onClick={() => void saveImpositionProject()}>Save</button>
          </div>
          <span className="imposition-toolbar-separator" />
          <div className="imposition-toolbar-group" role="group" aria-label="Layout and export">
            <button type="button" className="imposition-toolbar-primary" title="Import and arrange all photos from the artwork library" onClick={() => void generateAutomaticLayout(true)} disabled={layoutPending || (!document.designs.length && !photos.length)}>
              {layoutPending ? 'Arranging…' : 'Arrange all photos'}
            </button>
            <button type="button" onClick={() => void reviewPreflight()} disabled={exporting}>{exporting ? 'Checking…' : 'Preflight'}</button>
            <button type="button" onClick={() => void reviewPreflight()} disabled={exporting}>Export</button>
            <button type="button" onClick={() => void reviewPreflight()} disabled={exporting}>Print-ready PDF</button>
          </div>
          <span className="imposition-toolbar-separator" />
          <div className="imposition-toolbar-group" role="group" aria-label="Edit">
            <button type="button" title="Undo" onClick={undo} disabled={!undoStack.length}>Undo</button>
            <button type="button" title="Redo" onClick={redo} disabled={!redoStack.length}>Redo</button>
            <button type="button" title="Copy" onClick={copySelected} disabled={!selectedIds.length}>Copy</button>
            <button type="button" title="Paste" onClick={pasteSelected} disabled={!pasteBufferRef.current.objects.length}>Paste</button>
          </div>
          <span className="imposition-toolbar-separator" />
          <div className="imposition-toolbar-group imposition-zoom-controls" role="group" aria-label="Canvas zoom">
            <button type="button" title="Zoom out" onClick={() => setZoom((value) => Math.max(0.1, value / 1.2))}>−</button>
            <span className="imposition-zoom-value">{Math.round(zoom * 100)}%</span>
            <button type="button" title="Zoom in" onClick={() => setZoom((value) => Math.min(4, value * 1.2))}>+</button>
            <button type="button" onClick={fitSheet}>Fit sheet</button>
            <button type="button" onClick={() => setZoom(1)} title="Preview at 96 CSS pixels per inch">Actual size</button>
          </div>
          <button type="button" className="imposition-close" onClick={onClose}>Back to editor</button>
        </div>
      </header>

      <div className="imposition-body">
        <aside className="imposition-library">
          <section>
            <div className="imposition-section-heading">
              <h2>Artwork</h2>
              <span className="imposition-count">{photos.length}</span>
            </div>
            <p className="imposition-help-text">Click a photo to add it to this sheet.</p>
            {photos.length === 0 ? <p className="imposition-empty">Photos added in the editor will appear here.</p> : null}
            {photos.map((photo) => (
              <button type="button" className="imposition-artwork-entry" key={photo.id} onClick={() => onAddPhoto(photo, sheet.id)} title={`Place ${photo.name} on the sheet`}>
                <img src={photo.thumbnailUrl ?? photo.url} alt="" />
                <span>{photo.name}</span>
                <b aria-hidden="true">+</b>
              </button>
            ))}
          </section>
          <section>
            <h2>Shapes</h2>
            <div className="imposition-shape-tools">
              <button type="button" onClick={() => createBaseObject('Rectangle', 'rectangle')}>Rectangle</button>
              <button type="button" onClick={() => createBaseObject('Ellipse', 'ellipse')}>Ellipse</button>
              <button type="button" onClick={() => createBaseObject('Line', 'line')}>Line</button>
              <button type="button" onClick={() => createBaseObject('Text', 'text')}>Text</button>
              <button type="button" onClick={() => addGuide('horizontal')}>Horizontal guide</button>
              <button type="button" onClick={() => addGuide('vertical')}>Vertical guide</button>
            </div>
          </section>
          <section>
            <div className="imposition-section-heading">
              <h2>Layers</h2>
              <span className="imposition-count">{sheet.layers.length}</span>
              <button type="button" title="Add layer" onClick={addLayer}>+</button>
            </div>
            {sheet.layers.map((layer) => (
              <div className="imposition-layer-row" key={layer.id}>
                <button type="button" title={layer.visible ? 'Hide layer' : 'Show layer'} onClick={() => updateLayer(layer.id, (item) => ({ ...item, visible: !item.visible }))}>{layer.visible ? '◉' : '○'}</button>
                <span>{layer.name}</span>
                <button type="button" title={layer.locked ? 'Unlock layer' : 'Lock layer'} onClick={() => updateLayer(layer.id, (item) => ({ ...item, locked: !item.locked }))}>{layer.locked ? '🔒' : '⌑'}</button>
              </div>
            ))}
          </section>
          <section>
            <div className="imposition-section-heading">
              <h2>Objects on sheet</h2>
              <span className="imposition-count">{sheet.objects.length}</span>
            </div>
            {sheet.objects.length === 0 ? <p className="imposition-empty">Add artwork or a shape to get started.</p> : null}
            {sheet.objects.map((object) => (
              <button
                type="button"
                key={object.id}
                className={`imposition-object-entry${selectedIds.includes(object.id) ? ' active' : ''}`}
                onClick={() => setSelectedIds([object.id])}
              >
                {object.visible ? '◉' : '○'} {object.name}{object.locked ? ' 🔒' : ''}
              </button>
            ))}
          </section>
          <section>
            <div className="imposition-section-heading">
              <h2>Sheets</h2>
              <span className="imposition-count">{document.sheets.length}</span>
              <button type="button" title="Add sheet" onClick={addSheet}>+</button>
            </div>
            {document.sheets.map((item, index) => (
              <div className="imposition-sheet-row" key={item.id}>
                <button type="button" className={`imposition-sheet-entry${item.id === sheet.id ? ' active' : ''}`} aria-current={item.id === sheet.id ? 'page' : undefined} onClick={() => {
                  setActiveSheetId(item.id)
                  setSelectedIds([])
                }}>{index + 1}. {item.name}</button>
                {item.id === sheet.id ? (
                  <div className="imposition-sheet-actions">
                    <button type="button" title="Duplicate sheet" onClick={duplicateSheet}>⧉</button>
                    <button type="button" title="Move sheet up" disabled={activeSheetIndex === 0} onClick={() => moveSheet(-1)}>↑</button>
                    <button type="button" title="Move sheet down" disabled={activeSheetIndex === document.sheets.length - 1} onClick={() => moveSheet(1)}>↓</button>
                    <button type="button" title="Delete sheet" disabled={document.sheets.length < 2} onClick={deleteSheet}>×</button>
                  </div>
                ) : null}
              </div>
            ))}
          </section>
        </aside>

        <main className="imposition-workspace">
          <div className="imposition-ruler imposition-ruler-top" style={{ width: widthPx }}>
            {horizontalTicks.map((tick) => (
              <span key={tick} style={{ left: tick * CSS_PIXELS_PER_MM * zoom }}>{formatMeasurement(tick, document.units)}</span>
            ))}
          </div>
          <div className="imposition-canvas-area" ref={viewportRef}>
            <div className="imposition-sheet-wrap" style={{ width: widthPx, height: heightPx }}>
              <svg
                ref={svgRef}
                className="imposition-sheet"
                width={widthPx}
                height={heightPx}
                viewBox={`0 0 ${dimensions.widthMm} ${dimensions.heightMm}`}
                role="img"
                aria-label={`${sheet.name}, ${PAPER_LABELS[sheet.paper.size]}, ${sheet.paper.orientation}`}
                onPointerMove={handlePointerMove}
                onPointerUp={finishPointerAction}
                onPointerCancel={finishPointerAction}
                onPointerDown={(event) => {
                  if (event.target === event.currentTarget) setSelectedIds([])
                }}
              >
                <defs>
                  <pattern id="imposition-grid" width={sheet.layout.gridMm} height={sheet.layout.gridMm} patternUnits="userSpaceOnUse">
                    <path d={`M ${sheet.layout.gridMm} 0 L 0 0 0 ${sheet.layout.gridMm}`} fill="none" stroke="#cbd6de" strokeWidth="0.18" />
                  </pattern>
                </defs>
                <rect width={dimensions.widthMm} height={dimensions.heightMm} fill="#fff" />
                <rect width={dimensions.widthMm} height={dimensions.heightMm} fill="transparent" onPointerDown={(event) => {
                  if (event.currentTarget === event.target) setSelectedIds([])
                }} />
                {sheet.layout.snapToGrid && sheet.layout.gridMm > 0 ? <rect width={dimensions.widthMm} height={dimensions.heightMm} fill="url(#imposition-grid)" pointerEvents="none" /> : null}
                <rect
                  x={margin.left}
                  y={margin.top}
                  width={Math.max(0, dimensions.widthMm - margin.left - margin.right)}
                  height={Math.max(0, dimensions.heightMm - margin.top - margin.bottom)}
                  fill="none"
                  stroke="#3b9bd8"
                  strokeDasharray="1.5 1"
                  vectorEffect="non-scaling-stroke"
                />
                <rect
                  x={sheet.safeAreaMm}
                  y={sheet.safeAreaMm}
                  width={Math.max(0, dimensions.widthMm - sheet.safeAreaMm * 2)}
                  height={Math.max(0, dimensions.heightMm - sheet.safeAreaMm * 2)}
                  fill="none"
                  stroke="#e1a34b"
                  strokeDasharray="1 1"
                  vectorEffect="non-scaling-stroke"
                />
                {sheet.guides.map((guide) => guide.orientation === 'horizontal' ? (
                  <line key={guide.id} x1={0} y1={guide.positionMm} x2={dimensions.widthMm} y2={guide.positionMm} stroke="#2aa9e8" strokeDasharray="2 1" vectorEffect="non-scaling-stroke" pointerEvents="none" />
                ) : (
                  <line key={guide.id} x1={guide.positionMm} y1={0} x2={guide.positionMm} y2={dimensions.heightMm} stroke="#2aa9e8" strokeDasharray="2 1" vectorEffect="non-scaling-stroke" pointerEvents="none" />
                ))}
                {sheet.objects.filter((object) => object.visible && activeLayerIds.has(object.layerId)).map(renderObject)}
                {getCutMarkLines(sheet).map((mark, index) => (
                  <line
                    key={`${mark.kind}-${index}`}
                    className={`imposition-cut-mark ${mark.kind}`}
                    x1={mark.x1}
                    y1={mark.y1}
                    x2={mark.x2}
                    y2={mark.y2}
                    stroke={mark.color}
                    strokeWidth={Math.max(mark.widthMm, 0.15 / (CSS_PIXELS_PER_MM * zoom))}
                    strokeDasharray={mark.dashArray}
                    pointerEvents="none"
                  />
                ))}
              </svg>
            </div>
          </div>
          <div className="imposition-ruler imposition-ruler-bottom">
            {verticalTicks.map((tick) => <span key={tick}>{formatMeasurement(tick, document.units)}</span>)}
            <span className="imposition-canvas-status">{sheet.name} · {formatMeasurement(dimensions.widthMm, document.units)} × {formatMeasurement(dimensions.heightMm, document.units)} {UNIT_LABELS[document.units]}</span>
          </div>
        </main>

        <aside className="imposition-properties">
          <h2>{selectedObject ? 'Object properties' : 'Sheet properties'}</h2>
          <p className="imposition-help-text">
            {selectedObject
              ? `Edit “${selectedObject.name}” or use the object list to select another item.`
              : 'Set up the page and layout, or select an object to edit it.'}
          </p>
          {selectedObject ? (
            <>
              <label>
                Name
                <input value={selectedObject.name} onFocus={beginFieldEdit} onBlur={endFieldEdit} disabled={selectedObjectLocked} onChange={(event) => updateSelected((object) => ({ ...object, name: event.target.value }))} />
              </label>
              <div className="imposition-dimensions">
                {(['xMm', 'yMm'] as const).map((key) => (
                  <label key={key}>{key[0].toUpperCase()} ({UNIT_LABELS[document.units]})
                    <NumericInput
                      step="0.1"
                      value={formatMeasurement(selectedObject[key], document.units)}
                      onFocus={beginFieldEdit}
                      onBlur={endFieldEdit}
                      disabled={selectedObjectLocked}
                      onChange={(rawValue) => {
                        const value = Number(rawValue)
                        if (Number.isFinite(value)) updateSelected((object) => ({ ...object, [key]: toMillimetres(value, document.units) }))
                      }}
                    />
                  </label>
                ))}
              </div>
              <div className="imposition-dimensions">
                {(['widthMm', 'heightMm'] as const).map((key) => (
                  <label key={key}>{key === 'widthMm' ? 'Width' : 'Height'} ({UNIT_LABELS[document.units]})
                    <NumericInput
                      min="0.1"
                      step="0.1"
                      value={formatMeasurement(selectedObject[key] * (key === 'widthMm' ? selectedObject.scaleX : selectedObject.scaleY), document.units)}
                      onFocus={beginFieldEdit}
                      onBlur={endFieldEdit}
                      disabled={selectedObjectLocked}
                      onChange={(rawValue) => {
                        const value = Number(rawValue)
                        if (Number.isFinite(value) && value > 0) updateArtworkSize(key, value)
                      }}
                    />
                  </label>
                ))}
              </div>
              <label className="imposition-checkbox"><input type="checkbox" checked={lockAspectRatio} onChange={(event) => setLockAspectRatio(event.target.checked)} /> Lock aspect ratio</label>
              {selectedObject.type === 'image' ? (
                <label className="imposition-checkbox imposition-global-size">
                  <input type="checkbox" checked={applySizeToAllArtwork} onChange={(event) => setApplySizeToAllArtwork(event.target.checked)} />
                  Apply size changes to all designs
                </label>
              ) : null}
              <div className="imposition-dimensions">
                {(['scaleX', 'scaleY'] as const).map((key) => (
                  <label key={key}>{key === 'scaleX' ? 'Scale X' : 'Scale Y'}
                    <NumericInput min="0.01" step="0.01" value={selectedObject[key]} onFocus={beginFieldEdit} onBlur={endFieldEdit} disabled={selectedObjectLocked} onChange={(rawValue) => {
                      const value = Number(rawValue)
                      if (Number.isFinite(value) && value > 0) updateSelected((object) => ({ ...object, [key]: value }))
                    }} />
                  </label>
                ))}
              </div>
              <label>
                Rotation (°)
                <NumericInput step="1" value={selectedObject.rotationDeg} onFocus={beginFieldEdit} onBlur={endFieldEdit} disabled={selectedObjectLocked} onChange={(rawValue) => {
                  const value = Number(rawValue)
                  if (Number.isFinite(value)) updateSelected((object) => ({ ...object, rotationDeg: value }))
                }} />
              </label>
              {selectedObject.type === 'image' ? (
                <>
                  <label>
                    Copies of design
                    <NumericInput
                      min="1"
                      step="1"
                      value={document.designs.find((design) => design.id === selectedObject.designId)?.quantity ?? 1}
                      onFocus={beginFieldEdit}
                      onBlur={endFieldEdit}
                      disabled={selectedObjectLocked}
                      onChange={(rawValue) => {
                        const quantity = Math.floor(Number(rawValue))
                        if (Number.isFinite(quantity) && quantity > 0) {
                          onDocumentChange({
                            ...document,
                            designs: document.designs.map((design) => design.id === selectedObject.designId ? { ...design, quantity } : design),
                          })
                        }
                      }}
                    />
                  </label>
                  <details className="imposition-adjustments">
                    <summary>Image adjustments</summary>
                    {SLIDERS.map(({ key, label, min, max }) => {
                      const design = document.designs.find((item) => item.id === selectedObject.designId)
                      const value = selectedObject.settingsOverride?.[key] ?? design?.settings[key] ?? NEUTRAL_SETTINGS[key]
                      return (
                        <label key={key}>
                          <span>{label} <output>{value.toFixed(2)}</output></span>
                          <input
                            type="range"
                            min={min}
                            max={max}
                            step="0.01"
                            value={value}
                            disabled={selectedObjectLocked}
                            onFocus={beginFieldEdit}
                            onBlur={endFieldEdit}
                            onPointerDown={beginFieldEdit}
                            onPointerUp={endFieldEdit}
                            onChange={(event) => {
                              const nextValue = Number(event.target.value)
                              updateSelected((object) => {
                                if (object.type !== 'image') return object
                                const sourceDesign = document.designs.find((item) => item.id === object.designId)
                                if (!sourceDesign) return object
                                return {
                                  ...object,
                                  settingsOverride: {
                                    ...(object.settingsOverride ?? sourceDesign.settings),
                                    [key]: nextValue,
                                  },
                                }
                              })
                            }}
                          />
                        </label>
                      )
                    })}
                    <button type="button" onClick={() => updateSelected((object) => (
                      object.type === 'image'
                        ? { ...object, settingsOverride: NEUTRAL_SETTINGS, cropOverride: null }
                        : object
                    ))}>Reset to original</button>
                  </details>
                </>
              ) : null}
              <div className="imposition-property-actions">
                <button type="button" onClick={duplicateSelected}>Duplicate</button>
                <button type="button" onClick={() => updateSelected((object) => ({ ...object, locked: !object.locked }))}>{selectedObject.locked ? 'Unlock' : 'Lock'}</button>
                <button type="button" onClick={() => updateSelected((object) => ({ ...object, visible: !object.visible }))}>{selectedObject.visible ? 'Hide' : 'Show'}</button>
                <button type="button" onClick={() => {
                  const objects = [...sheet.objects]
                  const index = objects.findIndex((object) => object.id === selectedObject.id)
                  if (index >= 0 && index < objects.length - 1) [objects[index], objects[index + 1]] = [objects[index + 1], objects[index]]
                  setObjects(objects)
                }}>Bring forward</button>
                <button type="button" onClick={() => {
                  const objects = [...sheet.objects]
                  const index = objects.findIndex((object) => object.id === selectedObject.id)
                  if (index > 0) [objects[index], objects[index - 1]] = [objects[index - 1], objects[index]]
                  setObjects(objects)
                }}>Send backward</button>
                <button type="button" className="danger" onClick={deleteSelected}>Delete</button>
              </div>
              <label>
                Layer
                <select value={selectedObject.layerId} onChange={(event) => updateSelected((object) => ({ ...object, layerId: event.target.value }))}>
                  {sheet.layers.map((layer) => <option key={layer.id} value={layer.id} disabled={layer.locked || !layer.visible}>{layer.name}</option>)}
                </select>
              </label>
              <div className="imposition-inspector-subheading">
                <strong>Arrange selection</strong>
                <span>Select 2 or more objects to align or group them.</span>
              </div>
              <div className="imposition-align-actions">
                {([
                  ['left', 'Left'],
                  ['center-x', 'Center H'],
                  ['right', 'Right'],
                  ['top', 'Top'],
                  ['center-y', 'Center V'],
                  ['bottom', 'Bottom'],
                ] as const).map(([alignment, label]) => (
                  <button type="button" key={alignment} title={`Align ${alignment}`} disabled={selectedObjects.length < 2} onClick={() => alignSelected(alignment)}>{label}</button>
                ))}
                <button type="button" title="Distribute horizontally" disabled={selectedObjects.length < 3} onClick={() => distributeSelected('horizontal')}>Distribute H</button>
                <button type="button" title="Distribute vertically" disabled={selectedObjects.length < 3} onClick={() => distributeSelected('vertical')}>Distribute V</button>
                <button type="button" title="Group selected objects" disabled={selectedObjects.length < 2} onClick={groupSelected}>Group</button>
                <button type="button" title="Ungroup objects" disabled={!selectedObject?.groupId} onClick={ungroupSelected}>Ungroup</button>
              </div>
            </>
          ) : (
          <>
          <details className="imposition-settings-group">
            <summary>
              <span>Page setup</span>
              <span className="imposition-summary-meta">{PAPER_LABELS[sheet.paper.size]} · {sheet.paper.orientation}</span>
            </summary>
            <p className="imposition-help-text">Choose the paper, units, printable area, and PDF resolution.</p>
            <div className="imposition-settings-content">
          <label>
            Sheet name
            <input value={sheet.name} onFocus={beginFieldEdit} onBlur={endFieldEdit} onChange={(event) => updateSheet((current) => ({ ...current, name: event.target.value }))} />
          </label>
          <label>
            Units
            <select value={document.units} onChange={(event) => commitDocument({ ...document, units: event.target.value as ImpositionUnits })}>
              {Object.entries(UNIT_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
          <label>
            Paper size
            <select value={sheet.paper.size} onChange={(event) => setPaperSize(event.target.value as ImpositionPaperKey)}>
              {Object.entries(PAPER_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
          <label>
            Orientation
            <select
              value={sheet.paper.orientation}
              onChange={(event) => updateSheet((current) => ({
                ...current,
                paper: { ...current.paper, orientation: event.target.value as 'portrait' | 'landscape' },
              }))}
            >
              <option value="portrait">Portrait</option>
              <option value="landscape">Landscape</option>
            </select>
          </label>
          {sheet.paper.size === 'custom' ? (
            <div className="imposition-dimensions">
              <label>Width ({UNIT_LABELS[document.units]})<NumericInput min="0.1" step="0.1" value={formatMeasurement(dimensions.widthMm, document.units)} onFocus={beginFieldEdit} onBlur={endFieldEdit} onChange={(value) => setCustomDimension('widthMm', value)} /></label>
              <label>Height ({UNIT_LABELS[document.units]})<NumericInput min="0.1" step="0.1" value={formatMeasurement(dimensions.heightMm, document.units)} onFocus={beginFieldEdit} onBlur={endFieldEdit} onChange={(value) => setCustomDimension('heightMm', value)} /></label>
            </div>
          ) : null}
          <fieldset>
            <legend>Margins ({UNIT_LABELS[document.units]})</legend>
            {(['top', 'right', 'bottom', 'left'] as const).map((edge) => (
              <label className="imposition-margin-field" key={edge}>
                {edge[0].toUpperCase() + edge.slice(1)}
                <NumericInput min="0" step="0.1" value={formatMeasurement(sheet.marginsMm[edge], document.units)} onFocus={beginFieldEdit} onBlur={endFieldEdit} onChange={(value) => updateMeasurement(edge, value)} />
              </label>
            ))}
          </fieldset>
          <label>
            Bleed ({UNIT_LABELS[document.units]})
            <NumericInput
              min="0"
              step="0.1"
              value={formatMeasurement(sheet.bleedMm, document.units)}
              onFocus={beginFieldEdit}
              onBlur={endFieldEdit}
              onChange={(rawValue) => {
                const value = Number(rawValue)
                if (Number.isFinite(value) && value >= 0) updateSheet((current) => ({ ...current, bleedMm: toMillimetres(value, document.units) }))
              }}
            />
          </label>
          <label>
            Safe area ({UNIT_LABELS[document.units]})
            <NumericInput
              min="0"
              step="0.1"
              value={formatMeasurement(sheet.safeAreaMm, document.units)}
              onFocus={beginFieldEdit}
              onBlur={endFieldEdit}
              onChange={(rawValue) => {
                const value = Number(rawValue)
                if (Number.isFinite(value) && value >= 0) updateSheet((current) => ({ ...current, safeAreaMm: toMillimetres(value, document.units) }))
              }}
            />
          </label>
          <label>
            PDF output resolution (DPI)
            <NumericInput
              min="72"
              max="1200"
              step="1"
              value={document.export.dpi}
              onFocus={beginFieldEdit}
              onBlur={endFieldEdit}
              onChange={(rawValue) => {
                const dpi = Math.floor(Number(rawValue))
                if (Number.isFinite(dpi) && dpi >= 72 && dpi <= 1200) {
                  onDocumentChange({ ...document, export: { ...document.export, dpi } })
                }
              }}
            />
          </label>
            </div>
          </details>
          <fieldset>
            <legend>Automatic layout</legend>
            <p className="imposition-help-text">Choose how imported artwork is repeated and spaced on the sheet.</p>
            <label>
              Strategy
              <select value={sheet.layout.mode} onChange={(event) => updateSheet((current) => ({
                ...current,
                layout: {
                  ...current.layout,
                  mode: event.target.value as typeof current.layout.mode,
                  ...(event.target.value === 'edge-to-edge' ? { horizontalGapMm: 0, verticalGapMm: 0 } : {}),
                },
              }))}>
                <option value="edge-to-edge">Edge to edge (cut marks)</option>
                <option value="grid">Grid</option>
                <option value="step-repeat">Step and repeat</option>
                <option value="best-fit">Best fit (shelf heuristic)</option>
                <option value="manual">Manual</option>
              </select>
            </label>
            {(['horizontalGapMm', 'verticalGapMm'] as const).map((key) => (
              <label className="imposition-margin-field" key={key}>
                {key === 'horizontalGapMm' ? 'Horizontal gap' : 'Vertical gap'} ({UNIT_LABELS[document.units]})
                <NumericInput
                  min="0"
                  step="0.1"
                  value={formatMeasurement(sheet.layout[key], document.units)}
                  onFocus={beginFieldEdit}
                  onBlur={endFieldEdit}
                  disabled={sheet.layout.mode === 'edge-to-edge'}
                  onChange={(rawValue) => {
                    const value = Number(rawValue)
                    if (Number.isFinite(value) && value >= 0) {
                      updateSheet((current) => ({
                        ...current,
                        layout: { ...current.layout, [key]: toMillimetres(value, document.units) },
                      }))
                    }
                  }}
                />
              </label>
            ))}
            <label className="imposition-checkbox">
              <input type="checkbox" checked={sheet.layout.allowRotation} onChange={(event) => updateSheet((current) => ({
                ...current,
                layout: { ...current.layout, allowRotation: event.target.checked },
              }))} />
              Allow 90° rotation
            </label>
            <button type="button" className="imposition-run-layout" title="Import and arrange all photos from the artwork library" onClick={() => void generateAutomaticLayout(true)} disabled={layoutPending || (!document.designs.length && !photos.length)}>
              {layoutPending ? 'Arranging photos…' : 'Arrange all photos'}
            </button>
          </fieldset>
          <details className="imposition-settings-group">
            <summary>
              <span>Cut marks</span>
              <span className={`imposition-summary-meta${sheet.cutMarks.enabled ? ' is-on' : ''}`}>{sheet.cutMarks.enabled ? 'On' : 'Off'}</span>
            </summary>
            <p className="imposition-help-text">Control cutting guides and choose whether they appear in the workspace and PDF.</p>
            <fieldset>
            <legend>Mark options</legend>
            <label className="imposition-checkbox">
              <input type="checkbox" checked={sheet.cutMarks.enabled} onChange={(event) => updateSheet((current) => ({
                ...current,
                cutMarks: { ...current.cutMarks, enabled: event.target.checked },
              }))} />
              Enable cut marks
            </label>
            <label className="imposition-checkbox">
              <input type="checkbox" checked={sheet.cutMarks.showInWorkspace} onChange={(event) => updateSheet((current) => ({
                ...current,
                cutMarks: { ...current.cutMarks, showInWorkspace: event.target.checked },
              }))} />
              Show preview
            </label>
            {([
              ['cornerCropMarks', 'Corner crop marks'],
              ['trimMarks', 'Trim marks'],
              ['registrationMarks', 'Registration marks'],
              ['horizontalCutGuides', 'Horizontal cut guides'],
              ['verticalCutGuides', 'Vertical cut guides'],
              ['crossMarks', 'Cross marks'],
              ['bleedBoundary', 'Bleed boundaries'],
              ['objectOutlines', 'Object cutting outlines'],
              ['sharedCutLines', 'Shared cut lines'],
              ['customGuides', 'Custom guides'],
            ] as const).map(([key, label]) => (
              <label className="imposition-checkbox" key={key}>
                <input type="checkbox" checked={sheet.cutMarks[key]} onChange={(event) => updateSheet((current) => ({
                  ...current,
                  cutMarks: { ...current.cutMarks, [key]: event.target.checked },
                }))} />
                {label}
              </label>
            ))}
            {([
              ['lineWidthMm', 'Line thickness'],
              ['lengthMm', 'Mark length'],
              ['offsetMm', 'Mark offset'],
              ['spacingMm', 'Mark spacing'],
              ['distanceFromArtworkMm', 'Distance from artwork'],
            ] as const).map(([key, label]) => (
              <label className="imposition-margin-field" key={key}>
                {label} (mm)
                <NumericInput
                  min="0"
                  step={key === 'lineWidthMm' ? '0.01' : '0.1'}
                  value={key === 'lineWidthMm' ? sheet.cutMarks.lineWidthMm.toFixed(2) : formatMeasurement(sheet.cutMarks[key], 'mm')}
                  onFocus={beginFieldEdit}
                  onBlur={endFieldEdit}
                  onChange={(rawValue) => {
                    const value = Number(rawValue)
                    if (Number.isFinite(value) && value >= 0) {
                      updateSheet((current) => ({
                        ...current,
                        cutMarks: { ...current.cutMarks, [key]: value },
                      }))
                    }
                  }}
                />
              </label>
            ))}
            <label>
              Mark colour
              <input type="color" value={sheet.cutMarks.color} onChange={(event) => updateSheet((current) => ({
                ...current,
                cutMarks: { ...current.cutMarks, color: event.target.value },
              }))} />
            </label>
            <label>
              Mark style
              <select value={sheet.cutMarks.style} onChange={(event) => updateSheet((current) => ({
                ...current,
                cutMarks: { ...current.cutMarks, style: event.target.value as typeof current.cutMarks.style },
              }))}>
                <option value="solid">Solid</option>
                <option value="dashed">Dashed</option>
                <option value="dotted">Dotted</option>
              </select>
            </label>
            <label className="imposition-checkbox">
              <input type="checkbox" checked={document.export.includeCutMarks} onChange={(event) => commitDocument({
                ...document,
                export: { ...document.export, includeCutMarks: event.target.checked },
              })} />
              Include marks in export
            </label>
            </fieldset>
          </details>
          </>
          )}
        </aside>
      </div>
      {preflightIssues ? (
        <div className="imposition-modal-backdrop" role="presentation">
          <section className="imposition-preflight" role="dialog" aria-modal="true" aria-labelledby="imposition-preflight-title">
            <h2 id="imposition-preflight-title">PDF preflight report</h2>
            <p>{document.sheets.length} sheet(s) · {document.sheets.reduce((count, item) => count + item.objects.length, 0)} object(s) · {document.export.dpi} DPI</p>
            {preflightIssues.length ? (
              <ul>
                {preflightIssues.map((issue, index) => (
                  <li className={`severity-${issue.severity}`} key={`${issue.severity}-${index}`}>
                    <strong>{issue.severity.toUpperCase()}</strong> {issue.message}
                  </li>
                ))}
              </ul>
            ) : <p className="preflight-pass">No preflight problems were found.</p>}
            <div className="imposition-modal-actions">
              <button type="button" onClick={() => setPreflightIssues(null)} disabled={exporting}>Close</button>
              <button
                type="button"
                className="primary"
                onClick={() => void exportPrintReadyPdf()}
                disabled={exporting || preflightIssues.some((issue) => issue.severity === 'error')}
              >
                {exporting ? 'Preparing PDF…' : 'Export print-ready PDF'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}
