import { useId } from 'react'

type SliderProps = {
  label: string
  value: number
  min: number
  max: number
  step: number
  /** Value restored when the label is double-clicked. */
  defaultValue?: number
  onChange: (value: number) => void
  onInteractionStart?: () => void
}

const NAVIGATION_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']

export function SliderControl({
  label,
  value,
  min,
  max,
  step,
  defaultValue,
  onChange,
  onInteractionStart,
}: SliderProps) {
  const id = useId()
  const display = value.toFixed(step < 1 ? 2 : 0)

  const handleReset = () => {
    if (defaultValue === undefined || defaultValue === value) return
    onInteractionStart?.()
    onChange(defaultValue)
  }

  return (
    <div className="slider-row">
      <div className="slider-label-row">
        <label htmlFor={id} onDoubleClick={handleReset} title={defaultValue !== undefined ? 'Double-click to reset' : undefined}>
          {label}
        </label>
        <span>{display}</span>
      </div>
      <input
        id={id}
        title={`Adjust ${label}`}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={`${label} ${display}`}
        onPointerDown={onInteractionStart}
        onKeyDown={(event) => {
          // Only the first keydown of a held key records history, so undo isn't flooded.
          if (!event.repeat && NAVIGATION_KEYS.includes(event.key)) onInteractionStart?.()
        }}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  )
}
