import React from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { colors, sp } from '../../../tokens.js'
import { ChartContainer } from './ChartContainer.js'
import { GridLines } from './GridLines.js'
import { Axis } from './Axis.js'
import { DEFAULT_PADDING, xPos, yPos } from './types.js'
import type { ChartConfig } from './types.js'

export interface ChartSeries {
  name: string
  color: string
  values: number[]
}

export interface LineChartProps {
  series: ChartSeries[]
  /** One label per x position; pass '' to leave a position unlabelled. */
  xLabels: string[]
  height?: number
  formatValue?: (value: number) => string
  emptyText?: string
}

/** Nominal viewBox width — ChartContainer scales it to the available space. */
const VIEWBOX_WIDTH = 640

function polylinePoints(values: number[], maxY: number, cfg: ChartConfig): string {
  return values.map((v, i) => `${xPos(i, values.length, cfg)},${yPos(v, maxY, cfg)}`).join(' ')
}

/** Multi-series line chart built from the shared chart container primitives. */
export function LineChart({
  series,
  xLabels,
  height = 160,
  formatValue = String,
  emptyText = 'No data',
}: LineChartProps) {
  const allValues = series.flatMap(s => s.values)
  if (allValues.length === 0) return <Text style={styles.empty}>{emptyText}</Text>

  const cfg: ChartConfig = { width: VIEWBOX_WIDTH, height, padding: DEFAULT_PADDING }
  const maxY = Math.max(...allValues, 1)

  return (
    <View style={styles.wrap}>
      <ChartContainer width={cfg.width} height={cfg.height}>
        <GridLines horizontal={3} width={cfg.width} height={cfg.height} padding={cfg.padding} />
        <Axis cfg={cfg} xLabels={xLabels} yMax={maxY} formatY={formatValue} />
        {series.map(s => (
          <polyline
            key={s.name}
            points={polylinePoints(s.values, maxY, cfg)}
            fill="none"
            stroke={s.color}
            strokeWidth="2"
            strokeLinejoin="round"
          />
        ))}
      </ChartContainer>
      <View style={styles.legend}>
        {series.map(s => (
          <View key={s.name} style={styles.legendItem}>
            <View style={[styles.legendSwatch, { backgroundColor: s.color }]} />
            <Text style={styles.legendLabel}>{s.name}</Text>
          </View>
        ))}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: sp[4] },
  empty: { fontSize: 13, color: colors.textTertiary },
  legend: { flexDirection: 'row', gap: sp[8] },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: sp[3] },
  legendSwatch: { width: 8, height: 8, borderRadius: 2 },
  legendLabel: { fontSize: 11, color: colors.textTertiary },
})
