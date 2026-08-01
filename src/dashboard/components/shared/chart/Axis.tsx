import React from 'react'
import { semantic } from '../../../tokens.js'
import type { ChartConfig } from './types.js'
import { xPos } from './types.js'

export interface AxisProps {
  cfg: ChartConfig
  /** Tick labels along the bottom, evenly spaced. Empty strings are skipped. */
  xLabels?: string[]
  /** Upper bound of the value scale; y ticks are interpolated up to it. */
  yMax: number
  /** Number of y tick labels, including 0 and yMax. */
  yTicks?: number
  formatY?: (value: number) => string
}

const AXIS_LINE_COLOR = semantic.border
const LABEL_COLOR = semantic.text.tertiary
const LABEL_SIZE = 9

/**
 * Bottom and left axes with tick labels, sized from the same `ChartConfig` the
 * series use — so labels and data always agree on where the plot area is.
 */
export function Axis({ cfg, xLabels = [], yMax, yTicks = 3, formatY = String }: AxisProps) {
  const left = cfg.padding.left
  const right = cfg.width - cfg.padding.right
  const top = cfg.padding.top
  const bottom = cfg.height - cfg.padding.bottom

  const yTickNodes = Array.from({ length: yTicks }, (_, i) => {
    const fraction = yTicks > 1 ? i / (yTicks - 1) : 0
    const y = bottom - fraction * (bottom - top)
    return (
      <text key={`y${i}`} x={left - 5} y={y + 3} fontSize={LABEL_SIZE} fill={LABEL_COLOR} textAnchor="end">
        {formatY(yMax * fraction)}
      </text>
    )
  })

  const xTickNodes = xLabels.map((label, i) =>
    label === '' ? null : (
      <text
        key={`x${i}`}
        x={xPos(i, xLabels.length, cfg)}
        y={bottom + 14}
        fontSize={LABEL_SIZE}
        fill={LABEL_COLOR}
        textAnchor="middle"
      >
        {label}
      </text>
    ),
  )

  return (
    <>
      <line x1={left} y1={bottom} x2={right} y2={bottom} stroke={AXIS_LINE_COLOR} strokeWidth="1" />
      <line x1={left} y1={top} x2={left} y2={bottom} stroke={AXIS_LINE_COLOR} strokeWidth="1" />
      {yTickNodes}
      {xTickNodes}
    </>
  )
}
