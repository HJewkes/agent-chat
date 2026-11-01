/**
 * CC-1692: a hold on named lanes, kept in the stop file (operator.hold) beside the machine-wide file
 * hold, so there is one store. A lane hold carries `lanes` and `until`; the broker refuses a spawn or
 * resume whose requester is a held lane or was spawned, through any chain, by one, until `until`
 * passes or `machine lift` removes it. Pure: callers pass the file text, the clock and the roster.
 */

export interface LaneHold {
  by: string
  /** ISO time the hold began. */
  since: string
  reason: string
  lanes: string[]
  /** ISO time the hold ends. */
  until: string
}

const LANE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i
const MAX_CHAIN = 32

export function parseLanes(text: string): string[] {
  const lanes = text
    .split(',')
    .map(lane => lane.trim())
    .filter(lane => lane !== '')
  const bad = lanes.find(lane => !LANE_NAME.test(lane))
  if (bad !== undefined) throw new Error(`"${bad}" is not a lane name`)
  if (lanes.length === 0) throw new Error('--lanes needs at least one lane')
  return [...new Set(lanes)]
}

/** The lane hold in a stop file's text, or undefined when it is absent, unreadable or not a lane hold. */
export function readLaneHold(text: string | undefined): LaneHold | undefined {
  if (text === undefined) return undefined
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return undefined
  }
  const { by, since, reason, lanes, until } = (doc ?? {}) as Record<string, unknown>
  const isLaneList = Array.isArray(lanes) && lanes.length > 0 && lanes.every(l => typeof l === 'string')
  if (!isLaneList || typeof until !== 'string' || !Number.isFinite(Date.parse(until))) return undefined
  if (typeof by !== 'string' || typeof since !== 'string' || typeof reason !== 'string') return undefined
  return { by, since, reason, lanes: lanes as string[], until }
}

/** True once `until` has passed; a lane hold past it holds nothing and is not reported. */
export const laneHoldExpired = (hold: LaneHold, nowMs: number): boolean => Date.parse(hold.until) <= nowMs

/** The lane of `requester`'s chain that is held, itself first, or undefined. `spawnerOf` reads the roster. */
export function heldLaneOf(
  hold: LaneHold,
  requester: string,
  spawnerOf: (name: string) => string | undefined,
): string | undefined {
  const seen = new Set<string>()
  let name: string | undefined = requester
  for (let hops = 0; name !== undefined && hops < MAX_CHAIN && !seen.has(name); hops++) {
    if (hold.lanes.includes(name)) return name
    seen.add(name)
    name = spawnerOf(name)
  }
  return undefined
}

/** The refusal for a spawn or resume by `requester`, or undefined when no live lane hold covers it. */
export function laneHoldRefusal(
  text: string | undefined,
  nowMs: number,
  requester: string,
  spawnerOf: (name: string) => string | undefined,
): string | undefined {
  const hold = readLaneHold(text)
  if (hold === undefined || laneHoldExpired(hold, nowMs)) return undefined
  const lane = heldLaneOf(hold, requester, spawnerOf)
  if (lane === undefined) return undefined
  const via = lane === requester ? '' : ` (${requester} was spawned from it)`
  return `lane ${lane} is on hold until ${hold.until} by ${hold.by}${via}: ${hold.reason}`
}
