import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

/**
 * The burndown claim ledger: which task each tick-spawned agent holds.
 *
 * A claim holds its task, and a lane, until its phase is `done`. A claim past
 * its phase timeout is reported stalled and still holds both: the design files
 * it to the backlog rather than respawning it. Moves onto the lifecycle ledger
 * once that is read from (CC-118, CC-102).
 */

export const PHASES = ['planning', 'implementing', 'reviewing', 'awaiting-merge', 'done'] as const
export type Phase = (typeof PHASES)[number]

const Claim = z.object({
  taskId: z.string(),
  initiative: z.string(),
  agentId: z.string(),
  spawnedAt: z.string(),
  phase: z.enum(PHASES),
  /** When the claim entered its current phase; the timeout runs from here. */
  phaseAt: z.string(),
})
export type Claim = z.infer<typeof Claim>

const Ledger = z.object({
  version: z.literal(1),
  lastTickAt: z.string().optional(),
  claims: z.array(Claim),
})
export type Ledger = z.infer<typeof Ledger>

export const EMPTY_LEDGER: Ledger = { version: 1, claims: [] }

const HOUR_MS = 3_600_000
export const PHASE_TIMEOUT_MS: Partial<Record<Phase, number>> = {
  planning: 2 * HOUR_MS,
  implementing: 4 * HOUR_MS,
}

/** A missing file is an empty ledger; a malformed one throws, because guessing would double-dispatch. */
export function readLedger(file: string): Ledger {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return EMPTY_LEDGER
  }
  let parsed: ReturnType<typeof Ledger.safeParse> | undefined
  try {
    parsed = Ledger.safeParse(JSON.parse(raw))
  } catch {
    parsed = undefined
  }
  if (parsed?.success !== true) throw new Error(`burndown ledger ${file} is malformed`)
  return parsed.data
}

/** Write-then-rename in the same directory, so a reader never sees half a ledger. */
export function writeLedger(file: string, ledger: Ledger): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export const heldClaims = (ledger: Ledger): Claim[] => ledger.claims.filter(c => c.phase !== 'done')

export function isStalled(claim: Claim, now: Date): boolean {
  const timeout = PHASE_TIMEOUT_MS[claim.phase]
  return timeout !== undefined && now.getTime() - Date.parse(claim.phaseAt) > timeout
}

/** A second claim on a held task is refused rather than merged. */
export function addClaim(ledger: Ledger, claim: Claim): Ledger {
  if (heldClaims(ledger).some(c => c.taskId === claim.taskId))
    throw new Error(`task ${claim.taskId} is already claimed`)
  return { ...ledger, claims: [...ledger.claims, claim] }
}
