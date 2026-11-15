import fs from 'node:fs'
import { z } from 'zod'

/** Dedupe state for a notice pass: item key to the epoch ms it was last noticed. */
export type Notified = Record<string, number>

/** A missing or unreadable file is empty state, so a bad write costs one repeat notice, never the pass. */
export function loadNotified(file: string): Notified {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return z.record(z.string(), z.number()).parse(parsed)
  } catch {
    return {}
  }
}

export function saveNotified(file: string, notified: Notified): void {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(notified, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file)
}
