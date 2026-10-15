import { BLOCK_PAGE_TO } from './block-page.js'
import { charterSeats, isSeatName } from './charter.js'

/** CC-1348: the seats whose non-MERGE verdict blocks a seat merge: the charter's seats plus the operator. */
export const coordinatorSeats = (charter: string): string[] => {
  const seats = charterSeats(charter).filter(isSeatName)
  return seats.length === 0 ? [] : [...new Set([...seats, BLOCK_PAGE_TO])]
}
