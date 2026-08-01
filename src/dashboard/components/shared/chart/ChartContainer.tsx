import React from 'react';
import { View } from 'react-native';
import type { ChartPadding } from './types.js';
import { DEFAULT_PADDING } from './types.js';

export interface ChartContainerProps {
  width: number;
  height: number;
  padding?: ChartPadding;
  children: React.ReactNode;
}

/**
 * SVG wrapper with consistent viewBox and display settings.
 * Renders at full width of the container, fixed height.
 */
export function ChartContainer({ width, height, padding = DEFAULT_PADDING, children }: ChartContainerProps) {
  // padding is available for consumers who compute positions externally
  void padding;
  return (
    <View style={{ width: '100%' }}>
      {/* Brain suppressed a type error here; under this repo's react-native
          shim an intrinsic <svg> checks cleanly, so the suppression is gone. */}
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block' }}>
        {children}
      </svg>
    </View>
  );
}
