import type { AdjustmentSettings, PaperSizeKey } from '../engine/polaroidEngine'
import type { ExportOrientation } from '../types'

export const IMPOSITION_DOCUMENT_TYPE = 'polaroid-imposition'
export const IMPOSITION_DOCUMENT_VERSION = 1

export type ImpositionUnits = 'mm' | 'cm' | 'in'
export type ImpositionPaperKey = PaperSizeKey | 'A3' | 'A5' | 'custom'
export type ImpositionLayoutMode = 'edge-to-edge' | 'manual' | 'grid' | 'step-repeat' | 'best-fit'
export type CutMarkStyle = 'solid' | 'dashed' | 'dotted'

export type ImpositionAsset = {
  id: string
  name: string
  mimeType: string
  sourcePath: string | null
  dataUrl: string | null
  widthPx: number
  heightPx: number
}

export type ImpositionDesign = {
  id: string
  name: string
  assetId: string
  widthMm: number
  heightMm: number
  quantity: number
  allowRotation: boolean
  settings: AdjustmentSettings
  crop: { x: number; y: number; width: number; height: number; rotation: number } | null
}

export type ImpositionLayer = {
  id: string
  name: string
  visible: boolean
  locked: boolean
}

export type ImpositionArtworkObject = {
  id: string
  layerId: string
  name: string
  xMm: number
  yMm: number
  widthMm: number
  heightMm: number
  rotationDeg: number
  scaleX: number
  scaleY: number
  locked: boolean
  visible: boolean
  groupId?: string
} & (
  | {
      type: 'image'
      designId: string
      fit: 'contain' | 'cover'
      flipX: boolean
      flipY: boolean
      settingsOverride?: AdjustmentSettings
      cropOverride?: { x: number; y: number; width: number; height: number; rotation: number } | null
    }
  | { type: 'rectangle' | 'ellipse'; fill: string | null; stroke: string; strokeWidthMm: number }
  | { type: 'line'; stroke: string; strokeWidthMm: number }
  | { type: 'polygon'; points: Array<{ xMm: number; yMm: number }>; fill: string | null; stroke: string; strokeWidthMm: number }
  | { type: 'text'; text: string; fontFamily: string; fontSizeMm: number; fill: string }
  | { type: 'pdf-page'; assetId: string; pageIndex: number }
)

export type ImpositionGuide = {
  id: string
  orientation: 'horizontal' | 'vertical'
  positionMm: number
  locked: boolean
}

export type CutMarkSettings = {
  enabled: boolean
  showInWorkspace: boolean
  cornerCropMarks: boolean
  trimMarks: boolean
  registrationMarks: boolean
  horizontalCutGuides: boolean
  verticalCutGuides: boolean
  crossMarks: boolean
  bleedBoundary: boolean
  objectOutlines: boolean
  sharedCutLines: boolean
  customGuides: boolean
  lineWidthMm: number
  lengthMm: number
  offsetMm: number
  spacingMm: number
  distanceFromArtworkMm: number
  color: string
  style: CutMarkStyle
}

export type ImpositionSheet = {
  id: string
  name: string
  generatedFromSheetId?: string
  paper: {
    size: ImpositionPaperKey
    orientation: ExportOrientation
    widthMm: number
    heightMm: number
  }
  marginsMm: { top: number; right: number; bottom: number; left: number }
  bleedMm: number
  safeAreaMm: number
  layers: ImpositionLayer[]
  objects: ImpositionArtworkObject[]
  guides: ImpositionGuide[]
  cutMarks: CutMarkSettings
  layout: {
    mode: ImpositionLayoutMode
    horizontalGapMm: number
    verticalGapMm: number
    allowRotation: boolean
    snapToGrid: boolean
    snapToObjects: boolean
    gridMm: number
  }
}

export type ImpositionDocument = {
  type: typeof IMPOSITION_DOCUMENT_TYPE
  version: typeof IMPOSITION_DOCUMENT_VERSION
  name: string
  units: ImpositionUnits
  assets: ImpositionAsset[]
  designs: ImpositionDesign[]
  sheets: ImpositionSheet[]
  export: { dpi: number; includeCutMarks: boolean }
}

const PAPER_DIMENSIONS_MM: Record<Exclude<ImpositionPaperKey, 'custom'>, [number, number]> = {
  A3: [297, 420],
  A4: [210, 297],
  A5: [148, 210],
  '13x19': [330.2, 482.6],
  '13x9.5': [330.2, 241.3],
}

export function getPaperBaseDimensionsMm(size: Exclude<ImpositionPaperKey, 'custom'>): [number, number] {
  return [...PAPER_DIMENSIONS_MM[size]]
}

export function toMillimetres(value: number, units: ImpositionUnits): number {
  if (!Number.isFinite(value)) throw new Error('Measurement must be a finite number.')
  if (units === 'cm') return value * 10
  if (units === 'in') return value * 25.4
  return value
}

export function fromMillimetres(valueMm: number, units: ImpositionUnits): number {
  if (!Number.isFinite(valueMm)) throw new Error('Measurement must be a finite number.')
  if (units === 'cm') return valueMm / 10
  if (units === 'in') return valueMm / 25.4
  return valueMm
}

export function resolveSheetDimensionsMm(sheet: ImpositionSheet): { widthMm: number; heightMm: number } {
  const [baseWidth, baseHeight] =
    sheet.paper.size === 'custom'
      ? [sheet.paper.widthMm, sheet.paper.heightMm]
      : getPaperBaseDimensionsMm(sheet.paper.size)
  const isPortrait = baseHeight >= baseWidth
  const wantsPortrait = sheet.paper.orientation === 'portrait'
  return isPortrait === wantsPortrait
    ? { widthMm: baseWidth, heightMm: baseHeight }
    : { widthMm: baseHeight, heightMm: baseWidth }
}

export function createNewImpositionDocument(name = 'Untitled imposition'): ImpositionDocument {
  const sheetId = crypto.randomUUID()
  return {
    type: IMPOSITION_DOCUMENT_TYPE,
    version: IMPOSITION_DOCUMENT_VERSION,
    name,
    units: 'mm',
    assets: [],
    designs: [],
    sheets: [
      {
        id: sheetId,
        name: 'Sheet 1',
        paper: { size: 'A4', orientation: 'portrait', widthMm: 210, heightMm: 297 },
        marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
        bleedMm: 3,
        safeAreaMm: 5,
        layers: [{ id: crypto.randomUUID(), name: 'Artwork', visible: true, locked: false }],
        objects: [],
        guides: [],
        cutMarks: {
          enabled: true,
          showInWorkspace: true,
          cornerCropMarks: true,
          trimMarks: false,
          registrationMarks: false,
          horizontalCutGuides: false,
          verticalCutGuides: false,
          crossMarks: false,
          bleedBoundary: false,
          objectOutlines: false,
          sharedCutLines: true,
          customGuides: true,
          lineWidthMm: 0.25,
          lengthMm: 3,
          offsetMm: 0,
          spacingMm: 0,
          distanceFromArtworkMm: 0,
          color: '#000000',
          style: 'solid',
        },
        layout: {
          mode: 'manual',
          horizontalGapMm: 3,
          verticalGapMm: 3,
          allowRotation: true,
          snapToGrid: true,
          snapToObjects: true,
          gridMm: 5,
        },
      },
    ],
    export: { dpi: 300, includeCutMarks: true },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireFinite(value: unknown, path: string, minimum = -Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new Error(`Invalid imposition project: ${path} must be a finite number${minimum > -Infinity ? ` greater than or equal to ${minimum}` : ''}.`)
  }
  return value
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid imposition project: ${path} must be a string.`)
  return value
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Invalid imposition project: ${path} must be a boolean.`)
  return value
}

function requireColor(value: unknown, path: string, allowNone = false): string | null {
  if (allowNone && value === null) return null
  const color = requireString(value, path)
  if (!/^#[\da-f]{6}$/i.test(color)) throw new Error(`Invalid imposition project: ${path} must be a six-digit hex colour.`)
  return color
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid imposition project: ${path} must be an array.`)
  return value
}

export function parseImpositionDocument(input: unknown): ImpositionDocument {
  if (!isRecord(input) || input.type !== IMPOSITION_DOCUMENT_TYPE) {
    throw new Error('This file is not an imposition project.')
  }
  if (input.version !== IMPOSITION_DOCUMENT_VERSION) {
    throw new Error(`Unsupported imposition project version: ${String(input.version)}.`)
  }
  requireString(input.name, 'name')

  const assets = requireArray(input.assets, 'assets')
  const designs = requireArray(input.designs, 'designs')
  const sheets = requireArray(input.sheets, 'sheets')
  if (sheets.length === 0) throw new Error('Invalid imposition project: at least one sheet is required.')

  const assetIds = new Set<string>()
  for (const [index, raw] of assets.entries()) {
    const path = `assets[${index}]`
    if (!isRecord(raw)) throw new Error(`Invalid imposition project: ${path} must be an object.`)
    const id = requireString(raw.id, `${path}.id`)
    if (assetIds.has(id)) throw new Error(`Invalid imposition project: duplicate asset id ${id}.`)
    assetIds.add(id)
    requireString(raw.name, `${path}.name`)
    requireString(raw.mimeType, `${path}.mimeType`)
    requireFinite(raw.widthPx, `${path}.widthPx`, 1)
    requireFinite(raw.heightPx, `${path}.heightPx`, 1)
    if (raw.sourcePath !== null && typeof raw.sourcePath !== 'string') {
      throw new Error(`Invalid imposition project: ${path}.sourcePath must be a string or null.`)
    }
    if (raw.dataUrl !== null && typeof raw.dataUrl !== 'string') {
      throw new Error(`Invalid imposition project: ${path}.dataUrl must be a string or null.`)
    }
    if (!raw.sourcePath && !raw.dataUrl) throw new Error(`Invalid imposition project: ${path} has no image data reference.`)
  }

  const designIds = new Set<string>()
  for (const [index, raw] of designs.entries()) {
    const path = `designs[${index}]`
    if (!isRecord(raw)) throw new Error(`Invalid imposition project: ${path} must be an object.`)
    const id = requireString(raw.id, `${path}.id`)
    if (designIds.has(id)) throw new Error(`Invalid imposition project: duplicate design id ${id}.`)
    designIds.add(id)
    requireString(raw.name, `${path}.name`)
    const assetId = requireString(raw.assetId, `${path}.assetId`)
    if (!assetIds.has(assetId)) throw new Error(`Invalid imposition project: ${path} references missing asset ${assetId}.`)
    requireFinite(raw.widthMm, `${path}.widthMm`, 0.001)
    requireFinite(raw.heightMm, `${path}.heightMm`, 0.001)
    requireFinite(raw.quantity, `${path}.quantity`, 1)
    if (!Number.isInteger(raw.quantity)) throw new Error(`Invalid imposition project: ${path}.quantity must be an integer.`)
    requireBoolean(raw.allowRotation, `${path}.allowRotation`)
    if (!isRecord(raw.settings)) throw new Error(`Invalid imposition project: ${path}.settings must be an object.`)
    for (const [key, value] of Object.entries(raw.settings)) requireFinite(value, `${path}.settings.${key}`)
    if (raw.crop !== null) {
      if (!isRecord(raw.crop)) throw new Error(`Invalid imposition project: ${path}.crop must be an object or null.`)
      for (const key of ['x', 'y', 'width', 'height', 'rotation']) requireFinite(raw.crop[key], `${path}.crop.${key}`)
    }
  }

  const sheetIds = new Set<string>()
  for (const [index, raw] of sheets.entries()) {
    const path = `sheets[${index}]`
    if (!isRecord(raw)) throw new Error(`Invalid imposition project: ${path} must be an object.`)
    const sheetId = requireString(raw.id, `${path}.id`)
    if (sheetIds.has(sheetId)) throw new Error(`Invalid imposition project: duplicate sheet id ${sheetId}.`)
    sheetIds.add(sheetId)
    requireString(raw.name, `${path}.name`)
    if (raw.generatedFromSheetId !== undefined) requireString(raw.generatedFromSheetId, `${path}.generatedFromSheetId`)
    if (!isRecord(raw.paper)) throw new Error(`Invalid imposition project: ${path}.paper must be an object.`)
    if (!['A3', 'A4', 'A5', '13x19', '13x9.5', 'custom'].includes(String(raw.paper.size))) {
      throw new Error(`Invalid imposition project: ${path}.paper.size is unsupported.`)
    }
    if (raw.paper.orientation !== 'portrait' && raw.paper.orientation !== 'landscape') {
      throw new Error(`Invalid imposition project: ${path}.paper.orientation is unsupported.`)
    }
    requireFinite(raw.paper.widthMm, `${path}.paper.widthMm`, 0.001)
    requireFinite(raw.paper.heightMm, `${path}.paper.heightMm`, 0.001)
    if (!isRecord(raw.marginsMm)) throw new Error(`Invalid imposition project: ${path}.marginsMm must be an object.`)
    for (const edge of ['top', 'right', 'bottom', 'left']) requireFinite(raw.marginsMm[edge], `${path}.marginsMm.${edge}`, 0)
    requireFinite(raw.bleedMm, `${path}.bleedMm`, 0)
    requireFinite(raw.safeAreaMm, `${path}.safeAreaMm`, 0)
    const layers = requireArray(raw.layers, `${path}.layers`)
    if (layers.length === 0) throw new Error(`Invalid imposition project: ${path} must have at least one layer.`)
    const layerIds = new Set<string>()
    for (const [layerIndex, layer] of layers.entries()) {
      const layerPath = `${path}.layers[${layerIndex}]`
      if (!isRecord(layer)) throw new Error(`Invalid imposition project: ${layerPath} must be an object.`)
      const id = requireString(layer.id, `${layerPath}.id`)
      if (layerIds.has(id)) throw new Error(`Invalid imposition project: duplicate layer id ${id} in ${path}.`)
      layerIds.add(id)
      requireString(layer.name, `${layerPath}.name`)
      requireBoolean(layer.visible, `${layerPath}.visible`)
      requireBoolean(layer.locked, `${layerPath}.locked`)
    }
    const objects = requireArray(raw.objects, `${path}.objects`)
    const objectIds = new Set<string>()
    for (const [objectIndex, object] of objects.entries()) {
      const objectPath = `${path}.objects[${objectIndex}]`
      if (!isRecord(object)) throw new Error(`Invalid imposition project: ${objectPath} must be an object.`)
      const objectId = requireString(object.id, `${objectPath}.id`)
      if (objectIds.has(objectId)) throw new Error(`Invalid imposition project: duplicate object id ${objectId} in ${path}.`)
      objectIds.add(objectId)
      requireString(object.name, `${objectPath}.name`)
      const layerId = requireString(object.layerId, `${objectPath}.layerId`)
      if (!layerIds.has(layerId)) throw new Error(`Invalid imposition project: ${objectPath} references missing layer ${layerId}.`)
      for (const key of ['xMm', 'yMm', 'rotationDeg']) requireFinite(object[key], `${objectPath}.${key}`)
      for (const key of ['widthMm', 'heightMm', 'scaleX', 'scaleY']) requireFinite(object[key], `${objectPath}.${key}`, 0.001)
      requireBoolean(object.locked, `${objectPath}.locked`)
      requireBoolean(object.visible, `${objectPath}.visible`)
      if (object.groupId !== undefined) requireString(object.groupId, `${objectPath}.groupId`)
      if (object.type === 'image') {
        const designId = requireString(object.designId, `${objectPath}.designId`)
        if (!designIds.has(designId)) throw new Error(`Invalid imposition project: ${objectPath} references missing design ${designId}.`)
        if (object.fit !== 'contain' && object.fit !== 'cover') throw new Error(`Invalid imposition project: ${objectPath}.fit is unsupported.`)
        requireBoolean(object.flipX, `${objectPath}.flipX`)
        requireBoolean(object.flipY, `${objectPath}.flipY`)
        if (object.settingsOverride !== undefined) {
          if (!isRecord(object.settingsOverride)) throw new Error(`Invalid imposition project: ${objectPath}.settingsOverride must be an object.`)
          for (const [key, value] of Object.entries(object.settingsOverride)) requireFinite(value, `${objectPath}.settingsOverride.${key}`)
        }
        if (object.cropOverride !== undefined && object.cropOverride !== null) {
          if (!isRecord(object.cropOverride)) throw new Error(`Invalid imposition project: ${objectPath}.cropOverride must be an object or null.`)
          for (const key of ['x', 'y', 'width', 'height', 'rotation']) requireFinite(object.cropOverride[key], `${objectPath}.cropOverride.${key}`)
        }
      } else if (object.type === 'rectangle' || object.type === 'ellipse') {
        requireColor(object.fill, `${objectPath}.fill`, true)
        requireColor(object.stroke, `${objectPath}.stroke`)
        requireFinite(object.strokeWidthMm, `${objectPath}.strokeWidthMm`, 0)
      } else if (object.type === 'line') {
        requireColor(object.stroke, `${objectPath}.stroke`)
        requireFinite(object.strokeWidthMm, `${objectPath}.strokeWidthMm`, 0)
      } else if (object.type === 'polygon') {
        const points = requireArray(object.points, `${objectPath}.points`)
        if (points.length < 3) throw new Error(`Invalid imposition project: ${objectPath}.points must contain at least three points.`)
        for (const [pointIndex, point] of points.entries()) {
          if (!isRecord(point)) throw new Error(`Invalid imposition project: ${objectPath}.points[${pointIndex}] must be an object.`)
          requireFinite(point.xMm, `${objectPath}.points[${pointIndex}].xMm`)
          requireFinite(point.yMm, `${objectPath}.points[${pointIndex}].yMm`)
        }
        requireColor(object.fill, `${objectPath}.fill`, true)
        requireColor(object.stroke, `${objectPath}.stroke`)
        requireFinite(object.strokeWidthMm, `${objectPath}.strokeWidthMm`, 0)
      } else if (object.type === 'text') {
        requireString(object.text, `${objectPath}.text`)
        requireString(object.fontFamily, `${objectPath}.fontFamily`)
        requireFinite(object.fontSizeMm, `${objectPath}.fontSizeMm`, 0.001)
        requireColor(object.fill, `${objectPath}.fill`)
      } else if (object.type === 'pdf-page') {
        const assetId = requireString(object.assetId, `${objectPath}.assetId`)
        if (!assetIds.has(assetId)) throw new Error(`Invalid imposition project: ${objectPath} references missing asset ${assetId}.`)
        requireFinite(object.pageIndex, `${objectPath}.pageIndex`, 0)
        if (!Number.isInteger(object.pageIndex)) throw new Error(`Invalid imposition project: ${objectPath}.pageIndex must be an integer.`)
      } else {
        throw new Error(`Invalid imposition project: ${objectPath}.type is unsupported.`)
      }
    }
    const guides = requireArray(raw.guides, `${path}.guides`)
    for (const [guideIndex, guide] of guides.entries()) {
      const guidePath = `${path}.guides[${guideIndex}]`
      if (!isRecord(guide)) throw new Error(`Invalid imposition project: ${guidePath} must be an object.`)
      requireString(guide.id, `${guidePath}.id`)
      if (guide.orientation !== 'horizontal' && guide.orientation !== 'vertical') {
        throw new Error(`Invalid imposition project: ${guidePath}.orientation is unsupported.`)
      }
      requireFinite(guide.positionMm, `${guidePath}.positionMm`, 0)
      requireBoolean(guide.locked, `${guidePath}.locked`)
    }
    if (!isRecord(raw.cutMarks) || !isRecord(raw.layout)) {
      throw new Error(`Invalid imposition project: ${path} is missing cutting-mark or layout settings.`)
    }
    for (const key of [
      'enabled', 'showInWorkspace', 'cornerCropMarks', 'trimMarks', 'registrationMarks',
      'horizontalCutGuides', 'verticalCutGuides', 'crossMarks', 'bleedBoundary',
      'objectOutlines', 'sharedCutLines', 'customGuides',
    ]) requireBoolean(raw.cutMarks[key], `${path}.cutMarks.${key}`)
    requireFinite(raw.cutMarks.lineWidthMm, `${path}.cutMarks.lineWidthMm`, 0)
    for (const key of ['lengthMm', 'offsetMm', 'spacingMm', 'distanceFromArtworkMm']) requireFinite(raw.cutMarks[key], `${path}.cutMarks.${key}`, 0)
    requireColor(raw.cutMarks.color, `${path}.cutMarks.color`)
    if (!['solid', 'dashed', 'dotted'].includes(String(raw.cutMarks.style))) {
      throw new Error(`Invalid imposition project: ${path}.cutMarks.style is unsupported.`)
    }
    if (!['edge-to-edge', 'manual', 'grid', 'step-repeat', 'best-fit'].includes(String(raw.layout.mode))) {
      throw new Error(`Invalid imposition project: ${path}.layout.mode is unsupported.`)
    }
    for (const key of ['horizontalGapMm', 'verticalGapMm']) requireFinite(raw.layout[key], `${path}.layout.${key}`, 0)
    requireFinite(raw.layout.gridMm, `${path}.layout.gridMm`, 0.001)
    requireBoolean(raw.layout.allowRotation, `${path}.layout.allowRotation`)
    requireBoolean(raw.layout.snapToGrid, `${path}.layout.snapToGrid`)
    requireBoolean(raw.layout.snapToObjects, `${path}.layout.snapToObjects`)
  }

  if (!['mm', 'cm', 'in'].includes(String(input.units))) {
    throw new Error('Invalid imposition project: units are unsupported.')
  }
  if (!isRecord(input.export)) throw new Error('Invalid imposition project: export settings are missing.')
  requireFinite(input.export.dpi, 'export.dpi', 1)
  if (typeof input.export.includeCutMarks !== 'boolean') {
    throw new Error('Invalid imposition project: export.includeCutMarks must be a boolean.')
  }

  return input as unknown as ImpositionDocument
}
