/** `--since` as a duration back from now: `90m`, `24h`, `3d`. */

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 }

export function parseSince(value: string): number {
  const match = /^(\d+)([mhd])$/.exec(value.trim())
  const amount = match === null ? 0 : Number(match[1])
  const unit = match?.[2] === undefined ? undefined : UNIT_MS[match[2]]
  if (unit === undefined || amount <= 0)
    throw new Error(`bad --since: ${value} (a duration like 90m, 24h or 3d)`)
  return amount * unit
}
