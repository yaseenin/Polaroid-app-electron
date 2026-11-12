import type { PdfTextPayload, PdfVectorPayload } from './bridge'
import type { ImpositionArtworkObject } from './impositionDocument'

export type ImpositionVectorOutput = {
  vectors: PdfVectorPayload[]
  text: PdfTextPayload[]
}

type Point = { x: number; y: number }
const BEZIER_CIRCLE = 0.5522847498307936

export function createImpositionVectorOutput(object: ImpositionArtworkObject, dpi: number): ImpositionVectorOutput {
  if (object.type === 'image' || object.type === 'pdf-page') return { vectors: [], text: [] }
  const pixelsPerMm = dpi / 25.4
  const width = object.widthMm * object.scaleX * pixelsPerMm
  const height = object.heightMm * object.scaleY * pixelsPerMm
  const left = object.xMm * pixelsPerMm
  const top = object.yMm * pixelsPerMm
  const center = { x: left + width / 2, y: top + height / 2 }
  const radians = object.rotationDeg * Math.PI / 180
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  const transform = (point: Point): Point => ({
    x: center.x + (point.x - width / 2) * cosine - (point.y - height / 2) * sine,
    y: center.y + (point.x - width / 2) * sine + (point.y - height / 2) * cosine,
  })
  const pathPoint = (point: Point) => {
    const transformed = transform(point)
    return `${transformed.x} ${transformed.y}`
  }
  const strokeWidth = object.type === 'text' ? 0 : object.strokeWidthMm * pixelsPerMm
  if (object.type === 'text') {
    return {
      vectors: [],
      text: [{
        text: object.text,
        x: left,
        y: top + object.fontSizeMm * pixelsPerMm,
        fontSize: object.fontSizeMm * pixelsPerMm,
        color: object.fill,
        rotationDeg: object.rotationDeg,
        centerX: center.x,
        centerY: center.y,
      }],
    }
  }

  let path: string
  let fill: string | null = null
  const stroke = object.stroke
  if (object.type === 'line') {
    path = `M ${pathPoint({ x: 0, y: 0 })} L ${pathPoint({ x: width, y: height })}`
  } else if (object.type === 'rectangle') {
    path = `M ${pathPoint({ x: 0, y: 0 })} L ${pathPoint({ x: width, y: 0 })} L ${pathPoint({ x: width, y: height })} L ${pathPoint({ x: 0, y: height })} Z`
    fill = object.fill
  } else if (object.type === 'ellipse') {
    const radiusX = width / 2
    const radiusY = height / 2
    const curveX = radiusX * BEZIER_CIRCLE
    const curveY = radiusY * BEZIER_CIRCLE
    const point = (x: number, y: number) => pathPoint({ x, y })
    path = [
      `M ${point(width, height / 2)}`,
      `C ${point(width, height / 2 + curveY)} ${point(width / 2 + curveX, height)} ${point(width / 2, height)}`,
      `C ${point(width / 2 - curveX, height)} ${point(0, height / 2 + curveY)} ${point(0, height / 2)}`,
      `C ${point(0, height / 2 - curveY)} ${point(width / 2 - curveX, 0)} ${point(width / 2, 0)}`,
      `C ${point(width / 2 + curveX, 0)} ${point(width, height / 2 - curveY)} ${point(width, height / 2)} Z`,
    ].join(' ')
    fill = object.fill
  } else if (object.type === 'polygon') {
    const points = object.points.map((point) => ({
      x: point.xMm * object.scaleX * pixelsPerMm,
      y: point.yMm * object.scaleY * pixelsPerMm,
    }))
    path = `M ${points.map(pathPoint).join(' L ')} Z`
    fill = object.fill
  } else {
    return { vectors: [], text: [] }
  }

  return {
    vectors: [{ path, fill, stroke, strokeWidth }],
    text: [],
  }
}
