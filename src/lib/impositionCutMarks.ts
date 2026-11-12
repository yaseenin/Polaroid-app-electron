import { resolveSheetDimensionsMm, type ImpositionSheet } from './impositionDocument'

export type CutMarkLine = {
  x1: number
  y1: number
  x2: number
  y2: number
  widthMm: number
  color: string
  dashArray?: string
  kind: string
}

type Point = { x: number; y: number }
type Bounds = { x: number; y: number; width: number; height: number }

function objectCorners(object: ImpositionSheet['objects'][number], expansion = 0): Point[] {
  const width = object.widthMm * object.scaleX + expansion * 2
  const height = object.heightMm * object.scaleY + expansion * 2
  const centerX = object.xMm + object.widthMm * object.scaleX / 2
  const centerY = object.yMm + object.heightMm * object.scaleY / 2
  const angle = object.rotationDeg * Math.PI / 180
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)
  return [
    { x: -width / 2, y: -height / 2 },
    { x: width / 2, y: -height / 2 },
    { x: width / 2, y: height / 2 },
    { x: -width / 2, y: height / 2 },
  ].map(({ x, y }) => ({
    x: centerX + x * cosine - y * sine,
    y: centerY + x * sine + y * cosine,
  }))
}

function getBounds(corners: Point[]): Bounds {
  const xs = corners.map((point) => point.x)
  const ys = corners.map((point) => point.y)
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  }
}

export function getCutMarkLines(sheet: ImpositionSheet, forExport = false): CutMarkLine[] {
  const marks = sheet.cutMarks
  if (!marks.enabled || (!forExport && !marks.showInWorkspace)) return []
  const dashArray = marks.style === 'dashed' ? `${marks.lengthMm / 3} ${marks.lengthMm / 4}`
    : marks.style === 'dotted' ? `${marks.lineWidthMm} ${marks.lineWidthMm * 2}`
      : undefined
  const lines: CutMarkLine[] = []
  const addLine = (a: Point, b: Point, kind: string) => {
    lines.push({
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      widthMm: marks.lineWidthMm,
      color: marks.color,
      dashArray,
      kind,
    })
  }
  const visibleObjects = sheet.objects.filter((object) => object.visible && sheet.layers.some((layer) => layer.id === object.layerId && layer.visible))
  const objectCornersList = visibleObjects.map((object) => objectCorners(object))
  const bounds = objectCornersList.map(getBounds)
  const shouldDrawCropMarks = marks.cornerCropMarks || marks.trimMarks

  if (marks.objectOutlines) {
    for (const corners of objectCornersList) {
      for (let index = 0; index < corners.length; index += 1) {
        addLine(corners[index], corners[(index + 1) % corners.length], 'object-outline')
      }
    }
  }

  if (marks.bleedBoundary && sheet.bleedMm > 0) {
    for (const object of visibleObjects) {
      const corners = objectCorners(object, sheet.bleedMm)
      for (let index = 0; index < corners.length; index += 1) {
        addLine(corners[index], corners[(index + 1) % corners.length], 'bleed-boundary')
      }
    }
  }

  if (shouldDrawCropMarks) {
    const gap = Math.max(0, marks.offsetMm + marks.distanceFromArtworkMm)
    const length = Math.max(0, marks.lengthMm)
    for (let objectIndex = 0; objectIndex < visibleObjects.length; objectIndex += 1) {
      const corners = objectCornersList[objectIndex]
      const object = visibleObjects[objectIndex]
      const radians = object.rotationDeg * Math.PI / 180
      const axisX = { x: Math.cos(radians), y: Math.sin(radians) }
      const axisY = { x: -Math.sin(radians), y: Math.cos(radians) }
      corners.forEach((point, index) => {
        const horizontalSign = index === 0 || index === 3 ? -1 : 1
        const verticalSign = index < 2 ? -1 : 1
        const horizontalOffset = { x: axisY.x * verticalSign * gap, y: axisY.y * verticalSign * gap }
        const verticalOffset = { x: axisX.x * horizontalSign * gap, y: axisX.y * horizontalSign * gap }
        addLine(
          { x: point.x + horizontalOffset.x, y: point.y + horizontalOffset.y },
          { x: point.x + horizontalOffset.x + axisX.x * horizontalSign * length, y: point.y + horizontalOffset.y + axisX.y * horizontalSign * length },
          'crop-mark',
        )
        addLine(
          { x: point.x + verticalOffset.x, y: point.y + verticalOffset.y },
          { x: point.x + verticalOffset.x + axisY.x * verticalSign * length, y: point.y + verticalOffset.y + axisY.y * verticalSign * length },
          'crop-mark',
        )
      })
    }
  }

  const { widthMm, heightMm } = resolveSheetDimensionsMm(sheet)
  const registrationCenters: Point[] = [
    { x: widthMm / 2, y: marks.offsetMm + marks.lengthMm / 2 },
    { x: widthMm / 2, y: heightMm - marks.offsetMm - marks.lengthMm / 2 },
    { x: marks.offsetMm + marks.lengthMm / 2, y: heightMm / 2 },
    { x: widthMm - marks.offsetMm - marks.lengthMm / 2, y: heightMm / 2 },
  ]
  if (marks.registrationMarks || marks.crossMarks) {
    const arm = Math.max(marks.lengthMm / 2, 1)
    for (const center of registrationCenters) {
      const overlapsArtwork = bounds.some((box) => center.x >= box.x && center.x <= box.x + box.width && center.y >= box.y && center.y <= box.y + box.height)
      if (overlapsArtwork) continue
      addLine({ x: center.x - arm, y: center.y }, { x: center.x + arm, y: center.y }, marks.registrationMarks ? 'registration' : 'cross')
      addLine({ x: center.x, y: center.y - arm }, { x: center.x, y: center.y + arm }, marks.registrationMarks ? 'registration' : 'cross')
    }
  }

  if (marks.horizontalCutGuides || marks.verticalCutGuides || marks.sharedCutLines) {
    const tolerance = 0.05
    for (let first = 0; first < bounds.length; first += 1) {
      for (let second = first + 1; second < bounds.length; second += 1) {
        const a = bounds[first]
        const b = bounds[second]
        const overlapXStart = Math.max(a.x, b.x)
        const overlapXEnd = Math.min(a.x + a.width, b.x + b.width)
        const overlapYStart = Math.max(a.y, b.y)
        const overlapYEnd = Math.min(a.y + a.height, b.y + b.height)
        if (marks.sharedCutLines && Math.abs(a.x + a.width - b.x) <= tolerance && overlapYEnd > overlapYStart) {
          addLine({ x: b.x, y: overlapYStart }, { x: b.x, y: overlapYEnd }, 'shared-cut')
        } else if (marks.sharedCutLines && Math.abs(b.x + b.width - a.x) <= tolerance && overlapYEnd > overlapYStart) {
          addLine({ x: a.x, y: overlapYStart }, { x: a.x, y: overlapYEnd }, 'shared-cut')
        } else if (marks.sharedCutLines && Math.abs(a.y + a.height - b.y) <= tolerance && overlapXEnd > overlapXStart) {
          addLine({ x: overlapXStart, y: b.y }, { x: overlapXEnd, y: b.y }, 'shared-cut')
        } else if (marks.sharedCutLines && Math.abs(b.y + b.height - a.y) <= tolerance && overlapXEnd > overlapXStart) {
          addLine({ x: overlapXStart, y: a.y }, { x: overlapXEnd, y: a.y }, 'shared-cut')
        } else if (marks.verticalCutGuides && overlapYEnd > overlapYStart && (Math.abs(a.x + a.width - b.x) < 20 || Math.abs(b.x + b.width - a.x) < 20)) {
          const x = (a.x + a.width <= b.x ? a.x + a.width + b.x : b.x + b.width + a.x) / 2
          addLine({ x, y: overlapYStart }, { x, y: overlapYEnd }, 'vertical-cut-guide')
        } else if (marks.horizontalCutGuides && overlapXEnd > overlapXStart && (Math.abs(a.y + a.height - b.y) < 20 || Math.abs(b.y + b.height - a.y) < 20)) {
          const y = (a.y + a.height <= b.y ? a.y + a.height + b.y : b.y + b.height + a.y) / 2
          addLine({ x: overlapXStart, y }, { x: overlapXEnd, y }, 'horizontal-cut-guide')
        }
      }
    }
  }

  if (marks.customGuides) {
    for (const guide of sheet.guides) {
      if (guide.orientation === 'vertical') addLine({ x: guide.positionMm, y: 0 }, { x: guide.positionMm, y: heightMm }, 'custom-guide')
      else addLine({ x: 0, y: guide.positionMm }, { x: widthMm, y: guide.positionMm }, 'custom-guide')
    }
  }
  return lines
}
