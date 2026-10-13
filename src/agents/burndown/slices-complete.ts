import type { Task } from './eligibility.js'
import type { Ledger } from './ledger.js'
import type { SeatEvent, SeatEvents } from './seat-events.js'

/**
 * CC-1049: a task whose slices all merged is no longer a seeding candidate. The tick tells the seat
 * that holds its claims once, in one batched event, instead of refusing it plan-blocked every tick.
 * It never closes the task: the tick has no way to tell a code-only `done_when` from one the slices
 * did not cover, and the owner is not asked for coordination work.
 */

/** True when the task has slice claims and every one is done; a released slice is `slicesReleasedComplete`. */
export function slicesMerged(ledger: Ledger, taskId: string): boolean {
  if (ledger.slicesReleased?.[taskId] !== undefined) return false
  const slices = ledger.claims.filter(c => c.taskId === taskId && c.slice !== undefined)
  return slices.length > 0 && slices.every(c => c.phase === 'done')
}

/**
 * CC-1227: no slice claim is held, every one that remains is done, and at least one slice was released.
 * Seeding adds every plan slice at once and a release drops its claim, so done claims plus released
 * slices are the whole plan.
 */
export function slicesReleasedComplete(ledger: Ledger, taskId: string): boolean {
  if ((ledger.slicesReleased?.[taskId] ?? []).length === 0) return false
  return ledger.claims.every(c => c.taskId !== taskId || c.slice === undefined || c.phase === 'done')
}

/** A parent the seeder must not reseed: all its slices merged, or the rest were released. */
export const slicesSettled = (ledger: Ledger, taskId: string): boolean =>
  slicesMerged(ledger, taskId) || slicesReleasedComplete(ledger, taskId)

export const mergedFlagKey = (initiative: string, taskId: string): string => `${initiative}/${taskId}`

/** Task ids one event names; the rest wait for the next tick, since a longer line would not fit the message. */
export const MERGED_PER_EVENT = 15

const isOpen = (task: Task): boolean => task.status === undefined || task.status === 'open'

const RELEASED_TAG = 'slices:released'
const releasedKey = (initiative: string, taskId: string): string =>
  `${mergedFlagKey(initiative, taskId)}:released`

/**
 * One `slices-merged` event per seat for its open tasks whose slices all merged or were released and that it has
 * not been told of. `closable` names a released parent the sweep closes, so it is not flagged (CC-1227).
 */
export function mergedEvents(
  ledger: Ledger,
  tasks: ReadonlyMap<string, readonly Task[]>,
  closable: (initiative: string, taskId: string) => boolean = () => false,
): SeatEvents {
  const told = new Set(ledger.slicesFlagged ?? [])
  const bySeat = new Map<string, { id: string; key: string }[]>()
  for (const [initiative, list] of tasks) {
    for (const t of list.filter(t => isOpen(t) && slicesSettled(ledger, t.id))) {
      if (!slicesMerged(ledger, t.id) && closable(initiative, t.id)) continue
      const key = slicesMerged(ledger, t.id) ? mergedFlagKey(initiative, t.id) : releasedKey(initiative, t.id)
      const seat = ledger.claims.find(c => c.taskId === t.id && c.initiative === initiative)?.seat
      if (seat === undefined || told.has(key)) continue
      const id = key.endsWith(':released') ? `${t.id} (${RELEASED_TAG})` : t.id
      bySeat.set(seat, [...(bySeat.get(seat) ?? []), { id, key }])
    }
  }
  return Object.fromEntries(
    [...bySeat].map(([seat, found]): [string, SeatEvent[]] => {
      const shown = found
        .sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true }))
        .slice(0, MERGED_PER_EVENT)
      return [
        seat,
        [{ kind: 'slices-merged', taskId: shown.map(s => s.id).join(', '), flagged: shown.map(s => s.key) }],
      ]
    }),
  )
}
