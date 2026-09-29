import fs from 'node:fs'
import { holdPath } from '../paths.js'

/** The longest hold accepted, so a hold is always a pause and never a permanent disable. */
export const MAX_HOLD_SECONDS = 3600

/** Returns the expiry it wrote, in epoch ms. */
export function writeHold(seconds: number, now: number = Date.now()): number {
  const until = now + Math.min(seconds, MAX_HOLD_SECONDS) * 1000
  fs.writeFileSync(holdPath(), String(until), { mode: 0o600 })
  return until
}

/** The live hold's expiry, or undefined; a hand-edited expiry beyond the cap counts as no hold. */
export function activeHold(now: number = Date.now()): number | undefined {
  let until: number
  try {
    until = Number(fs.readFileSync(holdPath(), 'utf8').trim())
  } catch {
    return undefined
  }
  const live = Number.isFinite(until) && until > now && until <= now + MAX_HOLD_SECONDS * 1000
  return live ? until : undefined
}

export function clearHold(): void {
  fs.rmSync(holdPath(), { force: true })
}
