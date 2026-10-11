/**
 * CC-931: Shepherd's `shepherd hold` reason check, mirrored from the factory's `hold-reason.ts`
 * (`checkHoldReason`), which refuses with exit 65 any reason whose text before the first ":" is not a
 * charter §8 class. The tick checks a reason here before it registers the run it would hold, so a
 * reason Shepherd would refuse never leaves a run registered and unheld. Keep the classes in step
 * with the factory's `HOLD_CLASSES`.
 */
export const HOLD_CLASSES = [
  'serve-down',
  'stalled',
  'no-reviewer',
  'run-failed',
  'visual-gate2',
  'g10-review',
  'g10-adversary',
] as const

export type HoldClass = (typeof HOLD_CLASSES)[number]

/** Gate classes cite no task; every other class must name the open task for its factory defect. */
const TASKLESS_CLASSES: ReadonlySet<string> = new Set(['visual-gate2', 'g10-review', 'g10-adversary'])

const TASK_ID = /\b[A-Z]{2,5}-\d+\b/

/** Why Shepherd would refuse `reason`, or undefined when it would accept it. */
export function holdReasonRefusal(reason: string): string | undefined {
  const colon = reason.indexOf(':')
  const holdClass = colon === -1 ? undefined : reason.slice(0, colon)
  if (holdClass === undefined || !(HOLD_CLASSES as readonly string[]).includes(holdClass))
    return `"${holdClass ?? reason}" is not a hold class`
  if (!TASKLESS_CLASSES.has(holdClass) && !TASK_ID.test(reason)) return `a ${holdClass} hold names no task ID`
  return undefined
}
