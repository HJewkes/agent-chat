/**
 * CC-1097: the lever that stopped a dispatch, as numbers rather than reason text.
 *
 * A capacity gate names its lever by the `limits` path the levers audit uses (`spend.per_run_points`,
 * `pools.<p>.ceiling_five_hour`, ...), the cap it holds, what the gate read, and the room left. A binary
 * gate (a stop line, a stale reading, a collision) has no figure, so its numbers are null.
 */
export interface GateReading {
  lever: string
  value: number | null
  reading: number | null
  /** value - reading; negative when the reading is past the cap. */
  headroom: number | null
  /** Where the lever's value is set. */
  source: string
}

/** The refusal kinds a capacity lever produces; every other kind is an eligibility or collision stop. */
export const CAP_KINDS: ReadonlySet<string> = new Set(['role-cap', 'worktrees', 'slots', 'budget'])

const round2 = (n: number): number => Math.round(n * 100) / 100

export const capGate = (lever: string, value: number, reading: number, source: string): GateReading => ({
  lever,
  value,
  reading,
  headroom: round2(value - reading),
  source,
})

export const binaryGate = (lever: string, source: string): GateReading => ({
  lever,
  value: null,
  reading: null,
  headroom: null,
  source,
})

export type Binding = GateReading & { kind: string; initiative: string; task?: string }

interface GatedRefusal {
  kind: string
  initiative: string
  task?: string | undefined
  gate?: GateReading | undefined
}

/** The gate of the first refusal, in rank order, that a capacity lever made; null when none did. */
export function bindingOf(refusals: readonly GatedRefusal[]): Binding | null {
  const hit = refusals.find(r => CAP_KINDS.has(r.kind) && r.gate !== undefined)
  if (hit?.gate === undefined) return null
  const { kind, initiative, task } = hit
  return { kind, initiative, ...(task === undefined ? {} : { task }), ...hit.gate }
}
