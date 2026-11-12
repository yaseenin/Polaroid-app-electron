import type {
  ImpositionArtworkObject,
  ImpositionDocument,
  ImpositionDesign,
  ImpositionSheet,
} from './impositionDocument'
import { resolveSheetDimensionsMm } from './impositionDocument'

export type AutomaticLayoutResult = {
  document: ImpositionDocument
  sourceSheetId: string
  sheetsUsed: number
  placedCopies: number
  unplacedDesignNames: string[]
}

type Placement = {
  xMm: number
  yMm: number
  widthMm: number
  heightMm: number
  rotationDeg: number
}

type PageState = {
  sheet: ImpositionSheet
  cursorX: number
  cursorY: number
  rowHeight: number
  imageAreaMm2: number
}

function getReserveMm(sheet: ImpositionSheet): number {
  const marks = sheet.cutMarks
  const hasMarks = marks.enabled && (
    marks.cornerCropMarks
    || marks.trimMarks
    || marks.registrationMarks
    || marks.horizontalCutGuides
    || marks.verticalCutGuides
    || marks.crossMarks
    || marks.objectOutlines
    || marks.sharedCutLines
  )
  const markReserve = hasMarks
    ? marks.distanceFromArtworkMm + marks.offsetMm + marks.lengthMm
    : 0
  return Math.max(0, sheet.bleedMm) + Math.max(0, markReserve)
}

function cloneEmptySheet(sheet: ImpositionSheet, index: number, generatedFromSheetId: string): ImpositionSheet {
  const layerIds = new Map(sheet.layers.map((layer) => [layer.id, crypto.randomUUID()]))
  return {
    ...sheet,
    id: crypto.randomUUID(),
    name: `${sheet.name} (${index})`,
    generatedFromSheetId,
    layers: sheet.layers.map((layer) => ({ ...layer, id: layerIds.get(layer.id)! })),
    objects: sheet.objects
      .filter((object) => object.type !== 'image')
      .map((object) => ({
        ...object,
        id: crypto.randomUUID(),
        layerId: layerIds.get(object.layerId) ?? object.layerId,
        groupId: undefined,
      })),
    guides: sheet.guides.map((guide) => ({ ...guide, id: crypto.randomUUID() })),
  }
}

function getOrientations(design: ImpositionDesign, allowRotation: boolean, reserveMm: number): Array<Omit<Placement, 'xMm' | 'yMm'>> {
  const orientations: Array<Omit<Placement, 'xMm' | 'yMm'>> = [{
    widthMm: design.widthMm + reserveMm * 2,
    heightMm: design.heightMm + reserveMm * 2,
    rotationDeg: 0,
  }]
  if (allowRotation && design.allowRotation && design.widthMm !== design.heightMm) {
    orientations.push({
      widthMm: design.heightMm + reserveMm * 2,
      heightMm: design.widthMm + reserveMm * 2,
      rotationDeg: 90,
    })
  }
  return orientations
}

function findPlacement(page: PageState, design: ImpositionDesign, sheet: ImpositionSheet): Placement | null {
  const dimensions = resolveSheetDimensionsMm(sheet)
  const minX = sheet.marginsMm.left
  const maxX = dimensions.widthMm - sheet.marginsMm.right
  const maxY = dimensions.heightMm - sheet.marginsMm.bottom
  const reserveMm = getReserveMm(sheet)
  const gapX = Math.max(0, sheet.layout.horizontalGapMm, sheet.cutMarks.spacingMm)
  const gapY = Math.max(0, sheet.layout.verticalGapMm, sheet.cutMarks.spacingMm)
  const rowY = page.cursorY
  const candidates = getOrientations(design, sheet.layout.allowRotation, reserveMm)
    .map((item) => {
      let x = page.cursorX
      let y = rowY
      let rowHeight = page.rowHeight
      if (x + item.widthMm > maxX || y + item.heightMm > maxY) {
        x = minX
        y = rowY + page.rowHeight + gapY
        rowHeight = 0
      }
      if (x + item.widthMm > maxX || y + item.heightMm > maxY) return null
      return {
        ...item,
        xMm: x,
        yMm: y,
        rowHeight: Math.max(rowHeight, item.heightMm),
      }
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
  if (!candidates.length) return null
  candidates.sort((a, b) => {
    const aNextX = a.xMm + a.widthMm + gapX
    const bNextX = b.xMm + b.widthMm + gapX
    const aNewRow = a.xMm === minX && page.cursorX !== minX
    const bNewRow = b.xMm === minX && page.cursorX !== minX
    return Number(aNewRow) - Number(bNewRow) || (maxX - aNextX) - (maxX - bNextX)
  })
  const chosen = candidates[0]
  page.cursorX = chosen.xMm + chosen.widthMm + gapX
  if (chosen.yMm !== rowY) {
    page.cursorY = chosen.yMm
    page.rowHeight = chosen.heightMm
  } else {
    page.rowHeight = Math.max(page.rowHeight, chosen.heightMm)
  }
  return {
    xMm: chosen.xMm,
    yMm: chosen.yMm,
    widthMm: chosen.widthMm,
    heightMm: chosen.heightMm,
    rotationDeg: chosen.rotationDeg,
  }
}

function createPageState(sheet: ImpositionSheet): PageState {
  return {
    sheet,
    cursorX: sheet.marginsMm.left,
    cursorY: sheet.marginsMm.top,
    rowHeight: 0,
    imageAreaMm2: 0,
  }
}

function createImageObject(design: ImpositionDesign, layerId: string, placement: Placement): ImpositionArtworkObject {
  const isQuarterTurn = placement.rotationDeg % 180 !== 0
  const visualWidth = isQuarterTurn ? design.heightMm : design.widthMm
  const visualHeight = isQuarterTurn ? design.widthMm : design.heightMm
  const offsetX = (placement.widthMm - visualWidth) / 2 + (visualWidth - design.widthMm) / 2
  const offsetY = (placement.heightMm - visualHeight) / 2 + (visualHeight - design.heightMm) / 2
  return {
    id: crypto.randomUUID(),
    type: 'image',
    layerId,
    name: design.name,
    designId: design.id,
    xMm: placement.xMm + offsetX,
    yMm: placement.yMm + offsetY,
    widthMm: design.widthMm,
    heightMm: design.heightMm,
    rotationDeg: placement.rotationDeg,
    scaleX: 1,
    scaleY: 1,
    locked: false,
    visible: true,
    fit: 'contain',
    flipX: false,
    flipY: false,
  }
}

export function createAutomaticLayout(document: ImpositionDocument, sheetId: string): AutomaticLayoutResult {
  const selectedSheet = document.sheets.find((sheet) => sheet.id === sheetId)
  if (!selectedSheet) throw new Error('The selected imposition sheet no longer exists.')
  const previousSourceSheetId = selectedSheet.generatedFromSheetId
  const previousSourceSheet = previousSourceSheetId
    ? document.sheets.find((sheet) => sheet.id === previousSourceSheetId)
    : undefined
  const sourceSheet = previousSourceSheet ?? selectedSheet
  const sourceSheetIndex = document.sheets.findIndex((sheet) => sheet.id === sourceSheet.id)
  const sourceSheetId = sourceSheet.id
  const orphanedSourceSheetId = previousSourceSheet ? undefined : previousSourceSheetId
  if (!document.designs.length) throw new Error('Add at least one artwork design before generating a layout.')

  const shouldRemoveSheet = (sheet: ImpositionSheet) => (
    sheet.id === sourceSheetId
    || sheet.generatedFromSheetId === sourceSheetId
    || Boolean(orphanedSourceSheetId && sheet.generatedFromSheetId === orphanedSourceSheetId)
  )
  const baseSheet: ImpositionSheet = {
    ...sourceSheet,
    generatedFromSheetId: undefined,
    objects: sourceSheet.objects.filter((object) => object.type !== 'image'),
  }
  const outputSheets: ImpositionSheet[] = [baseSheet]
  let page = createPageState(baseSheet)
  let placedCopies = 0
  const unplacedDesignNames: string[] = []
  const designs = document.designs
    .filter((design) => design.quantity > 0)
    .flatMap((design) => Array.from({ length: Math.floor(design.quantity) }, () => design))
  if (sourceSheet.layout.mode === 'best-fit') {
    designs.sort((a, b) => b.widthMm * b.heightMm - a.widthMm * a.heightMm)
  }
  const placeOnShelf = (design: ImpositionDesign) => {
    let placement = findPlacement(page, design, page.sheet)
    if (!placement) {
      const trial = createPageState(baseSheet)
      if (!findPlacement(trial, design, baseSheet)) {
        unplacedDesignNames.push(design.name)
        return
      }
      const nextSheet = cloneEmptySheet(sourceSheet, outputSheets.length + 1, sourceSheetId)
      outputSheets.push(nextSheet)
      page = createPageState(nextSheet)
      placement = findPlacement(page, design, nextSheet)
    }
    if (!placement) {
      unplacedDesignNames.push(design.name)
      return
    }
    const layerId = page.sheet.layers.find((layer) => !layer.locked)?.id
    if (!layerId) {
      unplacedDesignNames.push(design.name)
      return
    }
    page.sheet.objects.push(createImageObject(design, layerId, placement))
    page.imageAreaMm2 += placement.widthMm * placement.heightMm
    placedCopies += 1
  }

  if (sourceSheet.layout.mode === 'grid') {
    const dimensions = resolveSheetDimensionsMm(sourceSheet)
    const availableWidth = dimensions.widthMm - sourceSheet.marginsMm.left - sourceSheet.marginsMm.right
    const availableHeight = dimensions.heightMm - sourceSheet.marginsMm.top - sourceSheet.marginsMm.bottom
    const reserveMm = getReserveMm(sourceSheet)
    const gridOrientations = new Map<string, ReturnType<typeof getOrientations>[number]>()
    for (const design of document.designs.filter((item) => item.quantity > 0)) {
      const options = getOrientations(design, sourceSheet.layout.allowRotation, reserveMm)
      options.sort((a, b) => b.heightMm - a.heightMm)
      gridOrientations.set(design.id, options[0])
    }
    const cellWidth = Math.max(...[...gridOrientations.values()].map((item) => item.widthMm), 0)
    const cellHeight = Math.max(...[...gridOrientations.values()].map((item) => item.heightMm), 0)
    const gapX = Math.max(0, sourceSheet.layout.horizontalGapMm, sourceSheet.cutMarks.spacingMm)
    const gapY = Math.max(0, sourceSheet.layout.verticalGapMm, sourceSheet.cutMarks.spacingMm)
    const columns = cellWidth > 0 ? Math.floor((availableWidth + gapX) / (cellWidth + gapX)) : 0
    const rows = cellHeight > 0 ? Math.floor((availableHeight + gapY) / (cellHeight + gapY)) : 0
    const capacity = columns * rows
    if (capacity > 0) {
      for (let index = 0; index < designs.length; index += 1) {
        const design = designs[index]
        const orientation = gridOrientations.get(design.id)
        if (!orientation) {
          unplacedDesignNames.push(design.name)
          continue
        }
        const pageIndex = Math.floor(placedCopies / capacity)
        while (outputSheets.length <= pageIndex) {
          outputSheets.push(cloneEmptySheet(sourceSheet, outputSheets.length + 1, sourceSheetId))
        }
        page = createPageState(outputSheets[pageIndex])
        const cellIndex = placedCopies % capacity
        const column = cellIndex % columns
        const row = Math.floor(cellIndex / columns)
        const cellX = sourceSheet.marginsMm.left + column * (cellWidth + gapX)
        const cellY = sourceSheet.marginsMm.top + row * (cellHeight + gapY)
        const placement: Placement = {
          xMm: cellX + (cellWidth - orientation.widthMm) / 2,
          yMm: cellY + (cellHeight - orientation.heightMm) / 2,
          ...orientation,
        }
        const layerId = page.sheet.layers.find((layer) => !layer.locked)?.id
        if (!layerId) {
          unplacedDesignNames.push(design.name)
          continue
        }
        page.sheet.objects.push(createImageObject(design, layerId, placement))
        placedCopies += 1
      }
    }
    if (!capacity) {
      for (const design of designs) placeOnShelf(design)
    }
  } else {
    for (const design of designs) placeOnShelf(design)
  }

  const sheets = [
    ...document.sheets.slice(0, sourceSheetIndex).filter((sheet) => !shouldRemoveSheet(sheet)),
    ...outputSheets,
    ...document.sheets.slice(sourceSheetIndex + 1).filter((sheet) => !shouldRemoveSheet(sheet)),
  ]
  return {
    document: { ...document, sheets },
    sourceSheetId,
    sheetsUsed: outputSheets.length,
    placedCopies,
    unplacedDesignNames,
  }
}
