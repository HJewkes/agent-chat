/**
 * Alpha derivation for token values.
 *
 * These take a resolved token value and vary only its opacity, so the result
 * still traces back to a titan-design token rather than to a literal picked by
 * hand. Every caller lives in `tokens.ts`.
 */

/** Apply an opacity to a token's hex value, producing an `rgba()` string. */
export function alpha(hex: string, opacity: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r},${g},${b},${opacity})`
}

/** Generate a consistent opacity shade scale from a base hex color */
export function generateShades(hex: string): {
  base: string // the hex color
  dim50: string // rgba at 0.50 opacity
  dim25: string // rgba at 0.25
  dim15: string // rgba at 0.15
  dim12: string // rgba at 0.12
  dim08: string // rgba at 0.08
  dim05: string // rgba at 0.05
} {
  return {
    base: hex,
    dim50: alpha(hex, 0.5),
    dim25: alpha(hex, 0.25),
    dim15: alpha(hex, 0.15),
    dim12: alpha(hex, 0.12),
    dim08: alpha(hex, 0.08),
    dim05: alpha(hex, 0.05),
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
