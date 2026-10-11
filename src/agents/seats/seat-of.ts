import fs from 'node:fs'
import path from 'node:path'
import { frontmatterField } from '../active-work.js'
import { charterSeats, isSeatName, parseSeat, type Seat } from './charter.js'
import { readText } from './io.js'

/** CC-330: which seat an agent belongs to, shared by the seat journal and the dispatch log so they cannot disagree. */

export interface SeatFile {
  seat: Seat
  /** The seat file verbatim, for fields `parseSeat` does not carry. */
  text: string
}

export type SeatMatch =
  { kind: 'seat'; seat: SeatFile } | { kind: 'ambiguous'; prefix: string; seats: string[] } | { kind: 'none' }

/** Every seat file under `root` that parses; read fresh, so a new seat needs no restart. Throws when `seats/` is unreadable. */
function seatFiles(root: string, onUnreadable?: (seat: string) => void): SeatFile[] {
  const dir = path.join(root, 'seats')
  return fs
    .readdirSync(dir)
    .filter(file => file.endsWith('.md'))
    .map(file => file.slice(0, -'.md'.length))
    .filter(isSeatName)
    .flatMap(name => {
      const text = readText(path.join(dir, `${name}.md`))
      if (text === undefined) {
        onUnreadable?.(name)
        return []
      }
      const seat = parseSeat(name, text)
      return seat === undefined ? [] : [{ seat, text }]
    })
}

/**
 * The seat whose prefix is the longest one `agent` is named with. Two seats declaring that prefix are settled by
 * the one named `spawner`; otherwise neither owns it, since either log could be the wrong one.
 * A seat file that cannot be read is skipped and passed to `onUnreadable`.
 */
export function seatOf(
  root: string,
  agent: string,
  spawner?: string,
  onUnreadable?: (seat: string) => void,
): SeatMatch {
  const matching = seatFiles(root, onUnreadable).filter(({ seat }) => agent.startsWith(`${seat.prefix}-`))
  const longest = Math.max(0, ...matching.map(({ seat }) => seat.prefix.length))
  const owners = matching.filter(({ seat }) => seat.prefix.length === longest)
  const [first] = owners
  if (first === undefined) return { kind: 'none' }
  if (owners.length === 1) return { kind: 'seat', seat: first }
  const named = owners.find(({ seat }) => seat.name === spawner)
  if (named !== undefined) return { kind: 'seat', seat: named }
  const seats = owners.map(({ seat }) => seat.name).sort((a, b) => a.localeCompare(b))
  return { kind: 'ambiguous', prefix: first.seat.prefix, seats }
}

/** The owner runs an attended seat, so the charter's watchdog list never names it. */
export const isAttended = (seatFile: string): boolean => frontmatterField(seatFile, 'role') === 'attended'

/** A seat whose spawns the broker gates and routes: one the charter lists, or an attended seat. */
export const ownsSpawns = (charter: string, { seat, text }: SeatFile): boolean =>
  charterSeats(charter).includes(seat.name) || isAttended(text)
