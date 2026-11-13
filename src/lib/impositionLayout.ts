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
  requestedCopies: number
  utilizationPercent: number
  designQuantities: Array<{ designId: string; name: string; requested: number; placed: number }>
  unplacedDesignNames: string[]
}

type FreeRectangle = {
  xMm: number
  yMm: number
  widthMm: number
  heightMm: number
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
  freeRectangles: FreeRectangle[]
}

function getReserveMm(sheet: ImpositionSheet): number {
  const marks = sheet.cutMarks
  const hasMarks = marks.enabled && marks.lineWidthMm > 0 && (
    marks.cornerCropMarks
    || marks.trimMarks
    || marks.registrationMarks
    || marks.horizontalCutGuides
    || marks.verticalCutGuides
    || marks.crossMarks
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
  const gapX = Math.max(0, sheet.layout.horizontalGapMm) + Math.max(0, sheet.cutMarks.spacingMm)
  const gapY = Math.max(0, sheet.layout.verticalGapMm) + Math.max(0, sheet.cutMarks.spacingMm)
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

function splitFreeRectangles(page: PageState, used: FreeRectangle): void {
  const nextRectangles: FreeRectangle[] = []
  for (const free of page.freeRectangles) {
    const freeRight = free.xMm + free.widthMm
    const freeBottom = free.yMm + free.heightMm
    const usedRight = used.xMm + used.widthMm
    const usedBottom = used.yMm + used.heightMm
    if (used.xMm >= freeRight || usedRight <= free.xMm || used.yMm >= freeBottom || usedBottom <= free.yMm) {
      nextRectangles.push(free)
      continue
    }

    if (used.yMm > free.yMm && used.yMm < freeBottom) {
      nextRectangles.push({ ...free, heightMm: used.yMm - free.yMm })
    }
    if (usedBottom < freeBottom && usedBottom > free.yMm) {
      nextRectangles.push({ ...free, yMm: usedBottom, heightMm: freeBottom - usedBottom })
    }
    if (used.xMm > free.xMm && used.xMm < freeRight) {
      const top = Math.max(free.yMm, used.yMm)
      const bottom = Math.min(freeBottom, usedBottom)
      if (bottom > top) nextRectangles.push({ xMm: free.xMm, yMm: top, widthMm: used.xMm - free.xMm, heightMm: bottom - top })
    }
    if (usedRight < freeRight && usedRight > free.xMm) {
      const top = Math.max(free.yMm, used.yMm)
      const bottom = Math.min(freeBottom, usedBottom)
      if (bottom > top) nextRectangles.push({ xMm: usedRight, yMm: top, widthMm: freeRight - usedRight, heightMm: bottom - top })
    }
  }

  page.freeRectangles = nextRectangles.filter((rectangle, index) => !nextRectangles.some((other, otherIndex) => {
    if (index === otherIndex) return false
    const contained = rectangle.xMm >= other.xMm
      && rectangle.yMm >= other.yMm
      && rectangle.xMm + rectangle.widthMm <= other.xMm + other.widthMm
      && rectangle.yMm + rectangle.heightMm <= other.yMm + other.heightMm
    const equal = rectangle.xMm === other.xMm
      && rectangle.yMm === other.yMm
      && rectangle.widthMm === other.widthMm
      && rectangle.heightMm === other.heightMm
    return contained && (!equal || otherIndex < index)
  }))
}

function findBestFitPlacement(page: PageState, design: ImpositionDesign, sheet: ImpositionSheet): Placement | null {
  const reserveMm = getReserveMm(sheet)
  const gapX = Math.max(0, sheet.layout.horizontalGapMm) + Math.max(0, sheet.cutMarks.spacingMm)
  const gapY = Math.max(0, sheet.layout.verticalGapMm) + Math.max(0, sheet.cutMarks.spacingMm)
  const candidates = page.freeRectangles.flatMap((free) => getOrientations(design, sheet.layout.allowRotation, reserveMm)
    .filter((orientation) => orientation.widthMm <= free.widthMm && orientation.heightMm <= free.heightMm)
    .map((orientation) => {
      const remainingWidth = free.widthMm - orientation.widthMm
      const remainingHeight = free.heightMm - orientation.heightMm
      return {
        free,
        orientation,
        shortSideFit: Math.min(remainingWidth, remainingHeight),
        longSideFit: Math.max(remainingWidth, remainingHeight),
        areaFit: free.widthMm * free.heightMm - orientation.widthMm * orientation.heightMm,
      }
    }))
  candidates.sort((a, b) => a.shortSideFit - b.shortSideFit
    || a.longSideFit - b.longSideFit
    || a.areaFit - b.areaFit
    || a.orientation.rotationDeg - b.orientation.rotationDeg)
  const chosen = candidates[0]
  if (!chosen) return null

  splitFreeRectangles(page, {
    xMm: chosen.free.xMm,
    yMm: chosen.free.yMm,
    widthMm: Math.min(chosen.free.widthMm, chosen.orientation.widthMm + gapX),
    heightMm: Math.min(chosen.free.heightMm, chosen.orientation.heightMm + gapY),
  })
  return {
    ...chosen.orientation,
    xMm: chosen.free.xMm,
    yMm: chosen.free.yMm,
  }
}

function createPageState(sheet: ImpositionSheet): PageState {
  const dimensions = resolveSheetDimensionsMm(sheet)
  return {
    sheet,
    cursorX: sheet.marginsMm.left,
    cursorY: sheet.marginsMm.top,
    rowHeight: 0,
    freeRectangles: [{
      xMm: sheet.marginsMm.left,
      yMm: sheet.marginsMm.top,
      widthMm: Math.max(0, dimensions.widthMm - sheet.marginsMm.left - sheet.marginsMm.right),
      heightMm: Math.max(0, dimensions.heightMm - sheet.marginsMm.top - sheet.marginsMm.bottom),
    }],
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
  let requestedCopies = document.designs.reduce((sum, design) => sum + Math.max(0, Math.floor(design.quantity)), 0)
  const placedByDesign = new Map(document.designs.map((design) => [design.id, 0]))
  const requestedByDesign = new Map(document.designs.map((design) => [design.id, Math.max(0, Math.floor(design.quantity))]))
  const unplacedDesignNames: string[] = []
  const designs = document.designs
    .filter((design) => design.quantity > 0)
    .flatMap((design) => Array.from({ length: Math.floor(design.quantity) }, () => design))
  if (sourceSheet.layout.mode === 'best-fit') {
    designs.sort((a, b) => b.widthMm * b.heightMm - a.widthMm * a.heightMm)
  }
  const findLayoutPlacement = (currentPage: PageState, design: ImpositionDesign, currentSheet: ImpositionSheet) => (
    sourceSheet.layout.mode === 'best-fit'
      ? findBestFitPlacement(currentPage, design, currentSheet)
      : findPlacement(currentPage, design, currentSheet)
  )
  const placeOnShelf = (design: ImpositionDesign) => {
    if (!page.sheet.layers.some((layer) => !layer.locked)) {
      unplacedDesignNames.push(design.name)
      return
    }
    let placement = findLayoutPlacement(page, design, page.sheet)
    if (!placement) {
      const trial = createPageState(baseSheet)
      if (!findLayoutPlacement(trial, design, baseSheet)) {
        unplacedDesignNames.push(design.name)
        return
      }
      const nextSheet = cloneEmptySheet(sourceSheet, outputSheets.length + 1, sourceSheetId)
      outputSheets.push(nextSheet)
      page = createPageState(nextSheet)
      placement = findLayoutPlacement(page, design, nextSheet)
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
    placedCopies += 1
    placedByDesign.set(design.id, (placedByDesign.get(design.id) ?? 0) + 1)
  }

  if (sourceSheet.layout.mode === 'edge-to-edge') {
    const dimensions = resolveSheetDimensionsMm(sourceSheet)
    const availableWidth = Math.max(0, dimensions.widthMm - sourceSheet.marginsMm.left - sourceSheet.marginsMm.right)
    const availableHeight = Math.max(0, dimensions.heightMm - sourceSheet.marginsMm.top - sourceSheet.marginsMm.bottom)
    let edgeSheetCount = 0
    requestedCopies = 0

    for (const design of document.designs.filter((item) => item.quantity > 0)) {
      const orientations: Array<Omit<Placement, 'xMm' | 'yMm'>> = [{
        widthMm: design.widthMm,
        heightMm: design.heightMm,
        rotationDeg: 0,
      }]
      if (sourceSheet.layout.allowRotation && design.allowRotation && design.widthMm !== design.heightMm) {
        orientations.push({
          widthMm: design.heightMm,
          heightMm: design.widthMm,
          rotationDeg: 90,
        })
      }
      const candidates = orientations.map((orientation) => {
        const columns = Math.floor(availableWidth / orientation.widthMm)
        const rows = Math.floor(availableHeight / orientation.heightMm)
        return { ...orientation, columns, rows, capacity: columns * rows }
      }).sort((a, b) => b.capacity - a.capacity || a.rotationDeg - b.rotationDeg)
      const chosen = candidates[0]
      if (!chosen || chosen.capacity === 0) {
        requestedCopies += Math.max(0, Math.floor(design.quantity))
        unplacedDesignNames.push(design.name)
        continue
      }

      requestedByDesign.set(design.id, chosen.capacity)
      requestedCopies += chosen.capacity
      const layerId = sourceSheet.layers.find((layer) => !layer.locked)?.id
      if (!layerId) {
        unplacedDesignNames.push(design.name)
        continue
      }

      const targetSheet = edgeSheetCount === 0
        ? baseSheet
        : cloneEmptySheet(sourceSheet, outputSheets.length + 1, sourceSheetId)
      if (edgeSheetCount > 0) outputSheets.push(targetSheet)
      edgeSheetCount += 1
      page = createPageState(targetSheet)
      const gridWidth = chosen.columns * chosen.widthMm
      const gridHeight = chosen.rows * chosen.heightMm
      const startX = sourceSheet.marginsMm.left + (availableWidth - gridWidth) / 2
      const startY = sourceSheet.marginsMm.top + (availableHeight - gridHeight) / 2

      for (let index = 0; index < chosen.capacity; index += 1) {
        const placement: Placement = {
          xMm: startX + (index % chosen.columns) * chosen.widthMm,
          yMm: startY + Math.floor(index / chosen.columns) * chosen.heightMm,
          widthMm: chosen.widthMm,
          heightMm: chosen.heightMm,
          rotationDeg: chosen.rotationDeg,
        }
        page.sheet.objects.push(createImageObject(design, layerId, placement))
        placedCopies += 1
        placedByDesign.set(design.id, (placedByDesign.get(design.id) ?? 0) + 1)
      }
    }
  } else if (sourceSheet.layout.mode === 'grid') {
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
    const gapX = Math.max(0, sourceSheet.layout.horizontalGapMm) + Math.max(0, sourceSheet.cutMarks.spacingMm)
    const gapY = Math.max(0, sourceSheet.layout.verticalGapMm) + Math.max(0, sourceSheet.cutMarks.spacingMm)
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
        placedByDesign.set(design.id, (placedByDesign.get(design.id) ?? 0) + 1)
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
  const placedArtworkAreaMm2 = document.designs.reduce((sum, design) => (
    sum + design.widthMm * design.heightMm * (placedByDesign.get(design.id) ?? 0)
  ), 0)
  const printableAreaMm2 = outputSheets.reduce((sum, outputSheet) => {
    const dimensions = resolveSheetDimensionsMm(outputSheet)
    const printableWidth = Math.max(0, dimensions.widthMm - outputSheet.marginsMm.left - outputSheet.marginsMm.right)
    const printableHeight = Math.max(0, dimensions.heightMm - outputSheet.marginsMm.top - outputSheet.marginsMm.bottom)
    return sum + printableWidth * printableHeight
  }, 0)
  return {
    document: { ...document, sheets },
    sourceSheetId,
    sheetsUsed: outputSheets.length,
    placedCopies,
    requestedCopies,
    utilizationPercent: printableAreaMm2 > 0 ? placedArtworkAreaMm2 / printableAreaMm2 * 100 : 0,
    designQuantities: document.designs.map((design) => ({
      designId: design.id,
      name: design.name,
      requested: requestedByDesign.get(design.id) ?? 0,
      placed: placedByDesign.get(design.id) ?? 0,
    })),
    unplacedDesignNames,
  }
}
