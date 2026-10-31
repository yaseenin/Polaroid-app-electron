import { defaultSettings, type AdjustmentSettings } from '../engine/polaroidEngine'
import type { CropAspect } from '../types'
import { HISTOGRAM_BUCKETS } from './canvasUtils'

/** Explicit neutral values: no adjustment at all. New photos start here, and "Reset" returns here.
 *  Use this (not `defaultSettings`) anywhere a "no adjustment" fallback is needed: `defaultSettings`
 *  carries brightness 1.3 / contrast 1.1 / saturation 1.15 and would silently brighten the photo. */
export const NEUTRAL_SETTINGS: AdjustmentSettings = {
  ...defaultSettings,
  exposure: 1,
  brightness: 1,
  contrast: 1,
  levelsBlack: 0,
  levelsMid: 1,
  levelsWhite: 1,
  highlights: 1,
  shadows: 0,
  temperature: 0,
  vibrance: 1,
  saturation: 1,
  hue: 0,
  sharpen: 0,
  noiseReduction: 0,
  vignette: 0,
  fillBlur: false,
}

export type SliderKey =
  | 'exposure'
  | 'brightness'
  | 'contrast'
  | 'levelsBlack'
  | 'levelsMid'
  | 'levelsWhite'
  | 'highlights'
  | 'shadows'
  | 'temperature'
  | 'vibrance'
  | 'saturation'
  | 'hue'
  | 'sharpen'
  | 'noiseReduction'
  | 'vignette'

export const SLIDERS: Array<{ key: SliderKey; label: string; min: number; max: number }> = [
  { key: 'exposure', label: 'Exposure', min: 0.5, max: 2 },
  { key: 'brightness', label: 'Brightness', min: 0.5, max: 2 },
  { key: 'contrast', label: 'Contrast', min: 0.5, max: 2 },
  { key: 'levelsBlack', label: 'Levels Black', min: 0, max: 1 },
  { key: 'levelsMid', label: 'Levels Mid', min: 0.2, max: 3 },
  { key: 'levelsWhite', label: 'Levels White', min: 0, max: 2 },
  { key: 'highlights', label: 'Highlights', min: 0, max: 2 },
  { key: 'shadows', label: 'Shadows', min: -1, max: 1 },
  { key: 'temperature', label: 'Temperature', min: -1, max: 1 },
  { key: 'vibrance', label: 'Vibrance', min: 0, max: 2 },
  { key: 'saturation', label: 'Saturation', min: 0, max: 2 },
  { key: 'hue', label: 'Hue', min: -1, max: 1 },
  { key: 'sharpen', label: 'Sharpness', min: 0, max: 2.5 },
  { key: 'noiseReduction', label: 'Noise Reduction', min: 0, max: 1 },
  { key: 'vignette', label: 'Vignette', min: 0, max: 1 },
]

export const CROP_ASPECTS: CropAspect[] = ['Free', 'Square', 'Mini', 'Wide']

/** Longest side of the preview proxy. Higher = sharper preview but slower slider response on big photos. */
export const MAX_PREVIEW_DIM = 2000

/** Largest size of the on-screen preview bitmap. CSS shrinks it to fit the panel. */
export const MAX_PREVIEW_CANVAS = 1600

export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 3

export const EMPTY_HISTOGRAM: number[] = new Array(HISTOGRAM_BUCKETS).fill(0)

export const AUTOSAVE_INTERVAL_MS = 5 * 60 * 1000
/** Written into the folder the photos were imported from. */
export const AUTOSAVE_FILE_NAME = 'polaroid-autosave.json'
