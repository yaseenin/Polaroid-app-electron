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
type SharedEdge = { segment: [Point, Point]; firstEdge: number; secondEdge: number }

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

function getSharedEdge(
  firstCorners: Point[],
  secondCorners: Point[],
  maxGapMm: number,
): SharedEdge | null {
  const tolerance = 0.05
  for (let firstIndex = 0; firstIndex < firstCorners.length; firstIndex += 1) {
    const firstStart = firstCorners[firstIndex]
    const firstEnd = firstCorners[(firstIndex + 1) % firstCorners.length]
    const dx = firstEnd.x - firstStart.x
    const dy = firstEnd.y - firstStart.y
    const length = Math.hypot(dx, dy)
    if (length <= tolerance) continue
    const axis = { x: dx / length, y: dy / length }

    for (let secondIndex = 0; secondIndex < secondCorners.length; secondIndex += 1) {
      const secondStart = secondCorners[secondIndex]
      const secondEnd = secondCorners[(secondIndex + 1) % secondCorners.length]
      const otherDx = secondEnd.x - secondStart.x
      const otherDy = secondEnd.y - secondStart.y
      const otherLength = Math.hypot(otherDx, otherDy)
      if (otherLength <= tolerance || Math.abs(axis.x * otherDy - axis.y * otherDx) / otherLength > 0.001) continue
      const signedDistance = axis.x * (secondStart.y - firstStart.y) - axis.y * (secondStart.x - firstStart.x)
      if (Math.abs(signedDistance) > maxGapMm + tolerance) continue

      const project = (point: Point) => (point.x - firstStart.x) * axis.x + (point.y - firstStart.y) * axis.y
      const overlapStart = Math.max(0, Math.min(project(secondStart), project(secondEnd)))
      const overlapEnd = Math.min(length, Math.max(project(secondStart), project(secondEnd)))
      if (overlapEnd - overlapStart <= tolerance) continue
      const offsetX = -axis.y * signedDistance / 2
      const offsetY = axis.x * signedDistance / 2
      return {
        segment: [
          { x: firstStart.x + axis.x * overlapStart + offsetX, y: firstStart.y + axis.y * overlapStart + offsetY },
          { x: firstStart.x + axis.x * overlapEnd + offsetX, y: firstStart.y + axis.y * overlapEnd + offsetY },
        ],
        firstEdge: firstIndex,
        secondEdge: secondIndex,
      }
    }
  }
  return null
}

export function getCutMarkLines(sheet: ImpositionSheet, forExport = false): CutMarkLine[] {
  const marks = sheet.cutMarks
  const edgeToEdge = sheet.layout.mode === 'edge-to-edge'
  if (!marks.enabled || (!edgeToEdge && marks.lineWidthMm <= 0) || (!forExport && !marks.showInWorkspace)) return []
  const dashArray = marks.style === 'dashed' ? `${marks.lengthMm / 3} ${marks.lengthMm / 4}`
    : marks.style === 'dotted' ? `${marks.lineWidthMm} ${marks.lineWidthMm * 2}`
      : undefined
  const lines: CutMarkLine[] = []
  const addLine = (
    a: Point,
    b: Point,
    kind: string,
    style?: { color?: string; dashArray?: string | null; widthMm?: number },
  ) => {
    lines.push({
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      widthMm: style?.widthMm ?? marks.lineWidthMm,
      color: style?.color ?? marks.color,
      dashArray: style?.dashArray === null ? undefined : style?.dashArray ?? dashArray,
      kind,
    })
  }
  const visibleObjects = sheet.objects.filter((object) => object.visible && sheet.layers.some((layer) => layer.id === object.layerId && layer.visible))
  if (edgeToEdge) {
    const imageBounds = visibleObjects
      .filter((object) => object.type === 'image')
      .map((object) => getBounds(objectCorners(object)))
    if (!imageBounds.length) return []

    const minX = Math.min(...imageBounds.map((box) => box.x))
    const maxX = Math.max(...imageBounds.map((box) => box.x + box.width))
    const minY = Math.min(...imageBounds.map((box) => box.y))
    const maxY = Math.max(...imageBounds.map((box) => box.y + box.height))
    const uniqueSorted = (values: number[]) => values.sort((a, b) => a - b).filter((value, index, sorted) => (
      index === 0 || Math.abs(value - sorted[index - 1]) > 0.05
    ))
    const columnBoundaries = uniqueSorted(imageBounds.flatMap((box) => [box.x, box.x + box.width]))
    const rowBoundaries = uniqueSorted(imageBounds.flatMap((box) => [box.y, box.y + box.height]))
    const tickStyle = { color: '#000000', dashArray: null, widthMm: 0.15 }
    const tickLengthMm = 4
    const artworkOffsetMm = 2

    for (const x of columnBoundaries) {
      addLine(
        { x, y: minY - artworkOffsetMm - tickLengthMm },
        { x, y: minY - artworkOffsetMm },
        'edge-to-edge-tick',
        tickStyle,
      )
      addLine(
        { x, y: maxY + artworkOffsetMm },
        { x, y: maxY + artworkOffsetMm + tickLengthMm },
        'edge-to-edge-tick',
        tickStyle,
      )
    }
    for (const y of rowBoundaries) {
      addLine(
        { x: minX - artworkOffsetMm - tickLengthMm, y },
        { x: minX - artworkOffsetMm, y },
        'edge-to-edge-tick',
        tickStyle,
      )
      addLine(
        { x: maxX + artworkOffsetMm, y },
        { x: maxX + artworkOffsetMm + tickLengthMm, y },
        'edge-to-edge-tick',
        tickStyle,
      )
    }
    return lines
  }

  const objectCornersList = visibleObjects.map((object) => objectCorners(object))
  const bounds = objectCornersList.map(getBounds)
  const sharedEdgesByObject = objectCornersList.map(() => new Set<number>())
  const sharedCutLines: Array<[Point, Point]> = []
  if (marks.sharedCutLines) {
    const sharedGap = Math.max(0, marks.spacingMm)
      + Math.max(0, sheet.layout.horizontalGapMm, sheet.layout.verticalGapMm)
    for (let first = 0; first < objectCornersList.length; first += 1) {
      for (let second = first + 1; second < objectCornersList.length; second += 1) {
        const a = bounds[first]
        const b = bounds[second]
        const tolerance = 0.05
        const gapX = a.x + a.width <= b.x ? b.x - (a.x + a.width)
          : b.x + b.width <= a.x ? a.x - (b.x + b.width) : null
        const gapY = a.y + a.height <= b.y ? b.y - (a.y + a.height)
          : b.y + b.height <= a.y ? a.y - (b.y + b.height) : null
        const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
        const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
        const neighboring = (
          gapX !== null && gapX <= sharedGap + tolerance && overlapY > tolerance
        ) || (
          gapY !== null && gapY <= sharedGap + tolerance && overlapX > tolerance
        )
        if (!neighboring) continue
        const sharedEdge = getSharedEdge(objectCornersList[first], objectCornersList[second], sharedGap)
        if (!sharedEdge) continue
        sharedEdgesByObject[first].add(sharedEdge.firstEdge)
        sharedEdgesByObject[second].add(sharedEdge.secondEdge)
        sharedCutLines.push(sharedEdge.segment)
      }
    }
  }

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

  if (marks.cornerCropMarks || marks.trimMarks) {
    const gap = Math.max(0, marks.offsetMm + marks.distanceFromArtworkMm)
    const length = Math.max(0, marks.lengthMm)
    for (const [objectIndex, corners] of objectCornersList.entries()) {
      corners.forEach((point, index) => {
        const adjacentEdges = [
          { adjacent: corners[(index + 1) % corners.length], edgeIndex: index },
          { adjacent: corners[(index + corners.length - 1) % corners.length], edgeIndex: (index + corners.length - 1) % corners.length },
        ]
        for (const { adjacent, edgeIndex } of adjacentEdges) {
          if (sharedEdgesByObject[objectIndex].has(edgeIndex)) continue
          const dx = point.x - adjacent.x
          const dy = point.y - adjacent.y
          const edgeLength = Math.hypot(dx, dy)
          if (!edgeLength) continue
          const direction = { x: dx / edgeLength, y: dy / edgeLength }
          addLine(
            { x: point.x + direction.x * gap, y: point.y + direction.y * gap },
            { x: point.x + direction.x * (gap + length), y: point.y + direction.y * (gap + length) },
            'crop-mark',
            { color: '#ed1c24', dashArray: null },
          )
        }
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
    const axisAlignedObjects = visibleObjects.map((object) => {
      const radians = object.rotationDeg * Math.PI / 180
      return Math.abs(Math.sin(radians)) <= 0.001 || Math.abs(Math.cos(radians)) <= 0.001
    })
    for (let first = 0; first < bounds.length; first += 1) {
      for (let second = first + 1; second < bounds.length; second += 1) {
        const a = bounds[first]
        const b = bounds[second]
        const overlapXStart = Math.max(a.x, b.x)
        const overlapXEnd = Math.min(a.x + a.width, b.x + b.width)
        const overlapYStart = Math.max(a.y, b.y)
        const overlapYEnd = Math.min(a.y + a.height, b.y + b.height)
        if (!axisAlignedObjects[first] || !axisAlignedObjects[second]) continue

        const verticalGap = a.x + a.width <= b.x
          ? b.x - (a.x + a.width)
          : b.x + b.width <= a.x ? a.x - (b.x + b.width) : -1
        const horizontalGap = a.y + a.height <= b.y
          ? b.y - (a.y + a.height)
          : b.y + b.height <= a.y ? a.y - (b.y + b.height) : -1
        if (
          marks.verticalCutGuides
          && overlapYEnd - overlapYStart > tolerance
          && verticalGap > tolerance
          && verticalGap <= Math.max(0, marks.spacingMm) + Math.max(0, sheet.layout.horizontalGapMm) + tolerance
        ) {
          const x = a.x + a.width <= b.x ? a.x + a.width + verticalGap / 2 : b.x + b.width + verticalGap / 2
          addLine({ x, y: overlapYStart }, { x, y: overlapYEnd }, 'vertical-cut-guide')
        }
        if (
          marks.horizontalCutGuides
          && overlapXEnd - overlapXStart > tolerance
          && horizontalGap > tolerance
          && horizontalGap <= Math.max(0, marks.spacingMm) + Math.max(0, sheet.layout.verticalGapMm) + tolerance
        ) {
          const y = a.y + a.height <= b.y ? a.y + a.height + horizontalGap / 2 : b.y + b.height + horizontalGap / 2
          addLine({ x: overlapXStart, y }, { x: overlapXEnd, y }, 'horizontal-cut-guide')
        }
      }
    }
  }

  for (const segment of sharedCutLines) addLine(segment[0], segment[1], 'shared-cut')

  if (marks.customGuides) {
    for (const guide of sheet.guides) {
      if (guide.orientation === 'vertical') addLine({ x: guide.positionMm, y: 0 }, { x: guide.positionMm, y: heightMm }, 'custom-guide')
      else addLine({ x: 0, y: guide.positionMm }, { x: widthMm, y: guide.positionMm }, 'custom-guide')
    }
  }
  return lines
}
