import { describe, expect, it } from 'vitest'
import { checkAttended } from '../agents/seats/attended.js'

const CHARTER = '---\nseats: [seat-a]\n---\n'
const LISTED = '---\nprefix: sa\npool: alpha\n---\n'
const ATTENDED = '---\nprefix: dk\nrole: attended\npool: alpha\n---\n'

const check = (files: Record<string, string>, remembered: string[] = []) =>
  checkAttended(
    {
      seatNames: () => Object.keys(files).filter(name => !name.includes('/')),
      readSeatFile: name => files[name],
    },
    CHARTER,
    remembered,
  )

describe('the attended seats a watchdog pass checks', () => {
  it('remembers an attended seat with a usable file, and says nothing', () => {
    expect(check({ 'seat-a': LISTED, desk: ATTENDED })).toEqual({ seats: ['desk'] })
  })

  it('ignores a seat file the charter does not list that is not attended', () => {
    expect(check({ 'seat-a': LISTED, old: LISTED })).toEqual({ seats: [] })
  })

  it('warns for an attended seat file with no prefix or pool, seen before or not', () => {
    const broken = '---\nrole: attended\npool: alpha\n---\n'

    expect(check({ desk: broken })).toEqual({
      seats: ['desk'],
      warning: 'Watchdog: attended seat spawns are NOT gated: seats/desk.md has no prefix or pool',
    })
  })

  it('warns in one line for every remembered seat whose file is missing or lost its role', () => {
    const found = check({ lab: LISTED }, ['desk', 'lab'])

    expect(found).toEqual({
      seats: ['desk', 'lab'],
      warning:
        'Watchdog: attended seat spawns are NOT gated: seats/desk.md is missing; ' +
        'seats/lab.md no longer says role: attended',
    })
  })

  it('forgets a remembered seat moved to seats/retired, and one the charter now lists', () => {
    expect(check({ 'retired/desk': ATTENDED, 'seat-a': LISTED }, ['desk', 'seat-a'])).toEqual({ seats: [] })
  })

  it('keeps what it remembers and warns when the seat files cannot be listed', () => {
    const deps = {
      seatNames: () => {
        throw new Error('EACCES')
      },
      readSeatFile: () => undefined,
    }

    expect(checkAttended(deps, CHARTER, ['desk'])).toEqual({
      seats: ['desk'],
      warning: 'Watchdog: seat files cannot be listed (EACCES), so attended seats are unchecked',
    })
  })
})
