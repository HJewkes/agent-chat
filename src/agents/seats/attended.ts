import { charterSeats, isSeatName, parseSeat } from './charter.js'
import { isAttended } from './seat-of.js'

/**
 * CC-605: the charter never names an attended seat, so nothing says one should exist. The
 * watchdog pass remembers each one it has seen and warns while a remembered seat's file is
 * missing or no longer gates its spawns. Moving the file to `seats/retired/` ends the warning.
 */

export interface AttendedDeps {
  /** The seat files under the root; throws when they cannot be listed. */
  seatNames: () => string[]
  readSeatFile: (seat: string) => string | undefined
}

export interface AttendedCheck {
  /** The attended seats to remember for the next pass. */
  seats: string[]
  warning?: string
}

type Verdict = { kind: 'gated' } | { kind: 'forget' } | { kind: 'ungated'; why: string }

function judge(deps: AttendedDeps, name: string, remembered: boolean): Verdict {
  const text = deps.readSeatFile(name)
  if (text === undefined) {
    const retired = deps.readSeatFile(`retired/${name}`) !== undefined
    return !remembered || retired ? { kind: 'forget' } : { kind: 'ungated', why: 'is missing' }
  }
  if (!isAttended(text))
    return remembered ? { kind: 'ungated', why: 'no longer says role: attended' } : { kind: 'forget' }
  return parseSeat(name, text) === undefined
    ? { kind: 'ungated', why: 'has no prefix or pool' }
    : { kind: 'gated' }
}

function listed(deps: AttendedDeps): string[] | string {
  try {
    return deps.seatNames().filter(isSeatName)
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

export function checkAttended(
  deps: AttendedDeps,
  charter: string,
  remembered: readonly string[],
): AttendedCheck {
  const names = listed(deps)
  if (typeof names === 'string')
    return {
      seats: [...remembered],
      warning: `Watchdog: seat files cannot be listed (${names}), so attended seats are unchecked`,
    }
  const inCharter = charterSeats(charter)
  const candidates = [...new Set([...remembered, ...names])].filter(name => !inCharter.includes(name))
  const verdicts = candidates.map(name => ({ name, verdict: judge(deps, name, remembered.includes(name)) }))
  const ungated = verdicts.flatMap(({ name, verdict }) =>
    verdict.kind === 'ungated' ? [`seats/${name}.md ${verdict.why}`] : [],
  )
  return {
    seats: verdicts.filter(({ verdict }) => verdict.kind !== 'forget').map(({ name }) => name),
    ...(ungated.length === 0
      ? {}
      : { warning: `Watchdog: attended seat spawns are NOT gated: ${ungated.join('; ')}` }),
  }
}
