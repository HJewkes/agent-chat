import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

/**
 * CC-931: a hold the tick owes on a run it registered and then failed to hold. Shepherd
 * lists that run from then on, so no adopt pass reaches it again; this record is what
 * brings each later tick back to it.
 */
export const OwedHold = z.object({
  seat: z.string(),
  repo: z.string(),
  pr: z.number().int(),
  reason: z.string(),
})

export type OwedHold = z.infer<typeof OwedHold>

/** A missing file owes nothing; a malformed entry is dropped, the rest kept. */
export function readOwedHolds(file: string): OwedHold[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap(raw => {
    const hold = OwedHold.safeParse(raw)
    return hold.success ? [hold.data] : []
  })
}

/** Write-then-rename in the same directory, so a reader never sees half a file. */
export function writeOwedHolds(file: string, holds: readonly OwedHold[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(holds, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file)
}
