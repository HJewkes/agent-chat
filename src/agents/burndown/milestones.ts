import { parseDocument } from 'yaml'
import { z } from 'zod'

/** CC-626: the weekly milestone file (`milestones/<week>.yml`), loaded and validated purely. The caller reads the file. */

/** CC-720: a check may also name `tasks:` and `epics:` (ids); an open `ms-role:criterion` task must be named by one, directly or through its `epic:`. */
const DoneWhenCheck = z.looseObject({
  kind: z.string().min(1),
  tasks: z.array(z.string().min(1)).optional(),
  epics: z.array(z.string().min(1)).optional(),
})

/** Strict, so a misspelt key such as `gate_by:` is a schema error, not a silently ungated milestone. */
const MilestoneShape = z.strictObject({
  id: z.string().min(1),
  rank: z.number().int(),
  seat: z.string().min(1),
  epics: z.array(z.string().min(1)).default([]),
  done_when: z.array(DoneWhenCheck).default([]),
  gated_by: z.string().min(1).optional(),
})

const FileShape = z.strictObject({
  week: z.string().regex(/^\d{4}-W\d{2}$/),
  appetite_days: z.number().positive(),
  milestones: z.array(MilestoneShape),
})

type RawMilestone = z.infer<typeof MilestoneShape>
export type DoneWhenCheck = z.infer<typeof DoneWhenCheck>

/** `open` means the gating milestone is not done, so this one yields nothing; an unknown gate stays open. */
export interface Gate {
  by: string
  state: 'open' | 'closed'
}

export interface Milestone {
  id: string
  rank: number
  seat: string
  epics: string[]
  doneWhen: DoneWhenCheck[]
  gate?: Gate
}

export interface MilestoneFile {
  week: string
  appetiteDays: number
  /** By rank ascending. */
  milestones: Milestone[]
}

export type MilestoneErrorCode =
  | 'yaml'
  | 'schema'
  | 'duplicate-milestone'
  | 'duplicate-rank'
  | 'unknown-epic'
  | 'unknown-gate'
  | 'gate-cycle'

export interface MilestoneError {
  code: MilestoneErrorCode
  milestone?: string
  /** The offending epic or gate id, the shared rank, or the schema path. */
  id?: string
  message?: string
}

/** `file` is undefined only on a `yaml` or `schema` error; semantic errors still return it, so check `errors` first. */
export interface MilestoneResult {
  file?: MilestoneFile
  errors: MilestoneError[]
}

function duplicateIds(milestones: RawMilestone[]): MilestoneError[] {
  const seen = new Set<string>()
  return milestones.flatMap(({ id }) => {
    if (seen.has(id)) return [{ code: 'duplicate-milestone' as const, milestone: id }]
    seen.add(id)
    return []
  })
}

/** A rank already held by an earlier milestone; ties would order by file position, silently. */
function duplicateRanks(milestones: RawMilestone[]): MilestoneError[] {
  const holder = new Map<number, string>()
  return milestones.flatMap(({ id, rank }) => {
    const first = holder.get(rank)
    if (first !== undefined)
      return [{ code: 'duplicate-rank' as const, milestone: id, id: String(rank), message: `also ${first}` }]
    holder.set(rank, id)
    return []
  })
}

function unknownEpics(milestones: RawMilestone[], taskIds: ReadonlySet<string>): MilestoneError[] {
  return milestones.flatMap(m =>
    m.epics
      .filter(epic => !taskIds.has(epic))
      .map(epic => ({ code: 'unknown-epic' as const, milestone: m.id, id: epic })),
  )
}

function inGateCycle(start: RawMilestone, byId: Map<string, RawMilestone>): boolean {
  let gate = start.gated_by
  for (let step = 0; gate !== undefined && step < byId.size; step++) {
    if (gate === start.id) return true
    gate = byId.get(gate)?.gated_by
  }
  return false
}

function gateErrors(milestones: RawMilestone[]): MilestoneError[] {
  const byId = new Map(milestones.map(m => [m.id, m]))
  return milestones.flatMap((m): MilestoneError[] => {
    if (m.gated_by === undefined) return []
    if (!byId.has(m.gated_by)) return [{ code: 'unknown-gate', milestone: m.id, id: m.gated_by }]
    return inGateCycle(m, byId) ? [{ code: 'gate-cycle', milestone: m.id, id: m.gated_by }] : []
  })
}

function toMilestone(m: RawMilestone, done: ReadonlySet<string>): Milestone {
  const base = { id: m.id, rank: m.rank, seat: m.seat, epics: m.epics, doneWhen: m.done_when }
  if (m.gated_by === undefined) return base
  return { ...base, gate: { by: m.gated_by, state: done.has(m.gated_by) ? 'closed' : 'open' } }
}

/**
 * Validates a parsed milestone file against the known task ids. An epic must be a task id.
 * `doneMilestones` names the milestones whose done_when holds, which closes the gates they hold.
 */
export function validateMilestones(
  raw: unknown,
  taskIds: Iterable<string>,
  doneMilestones: Iterable<string> = [],
): MilestoneResult {
  const parsed = FileShape.safeParse(raw)
  if (!parsed.success) {
    const errors = parsed.error.issues.map(issue => ({
      code: 'schema' as const,
      id: issue.path.join('.'),
      message: issue.message,
    }))
    return { errors }
  }
  const { week, appetite_days, milestones } = parsed.data
  const errors = [
    ...duplicateIds(milestones),
    ...duplicateRanks(milestones),
    ...unknownEpics(milestones, new Set(taskIds)),
    ...gateErrors(milestones),
  ]
  const done = new Set(doneMilestones)
  const ranked = [...milestones].sort((a, b) => a.rank - b.rank).map(m => toMilestone(m, done))
  return { file: { week, appetiteDays: appetite_days, milestones: ranked }, errors }
}

function readYaml(text: string): { value: unknown } | { error: string } {
  const doc = parseDocument(text)
  const first = doc.errors[0]
  if (first) return { error: first.message }
  try {
    return { value: doc.toJS() }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** The milestone file's YAML text, parsed and validated; never throws. */
export function parseMilestoneFile(
  yamlText: string,
  taskIds: Iterable<string>,
  doneMilestones: Iterable<string> = [],
): MilestoneResult {
  const read = readYaml(yamlText)
  if ('error' in read) return { errors: [{ code: 'yaml', message: read.error }] }
  return validateMilestones(read.value, taskIds, doneMilestones)
}
