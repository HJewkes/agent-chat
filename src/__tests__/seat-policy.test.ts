import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const logged = vi.fn()
vi.mock('../broker/log.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../broker/log.js')>()),
  logEvent: logged,
}))

const { loadSeatPolicy, readSeatPolicy, seatPolicyPath } = await import('../agents/seat-policy.js')
const { checkSeatPolicy } = await import('../broker/doctor.js')

const SEAT = { root: true, launchProfiles: ['opus-coordinator'], ceiling: ['bd-implementer', 'decider'] }
const VALID = { version: 1, seats: { 'seat-a': SEAT } }

let dir: string

const writePolicy = (content: unknown, mode = 0o644): void => {
  fs.writeFileSync(seatPolicyPath(), typeof content === 'string' ? content : JSON.stringify(content))
  fs.chmodSync(seatPolicyPath(), mode)
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-policy-'))
  process.env.AGENT_CHAT_HOME = dir
  logged.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.AGENT_CHAT_HOME
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('loading the seat policy', () => {
  it('grants the seats of a valid owner-only file', () => {
    writePolicy(VALID)

    expect(loadSeatPolicy()).toEqual({ seats: { 'seat-a': SEAT } })
    expect(logged).not.toHaveBeenCalled()
  })

  it('grants nothing when the file is missing, and logs nothing', () => {
    expect(loadSeatPolicy()).toEqual({ seats: {} })
    expect(logged).not.toHaveBeenCalled()
  })

  it('grants nothing for malformed JSON and logs it once across reads', () => {
    writePolicy('{ "version": 1, ')

    expect(loadSeatPolicy()).toEqual({ seats: {} })
    expect(loadSeatPolicy()).toEqual({ seats: {} })
    expect(logged).toHaveBeenCalledTimes(1)
    expect(logged).toHaveBeenCalledWith(
      'seat_policy_invalid',
      expect.objectContaining({ path: seatPolicyPath() }),
    )
  })

  it('grants nothing through a symlink, even to a valid owner-only file', () => {
    const real = path.join(dir, 'elsewhere.json')
    fs.writeFileSync(real, JSON.stringify(VALID), { mode: 0o644 })
    fs.symlinkSync(real, seatPolicyPath())

    expect(loadSeatPolicy()).toEqual({ seats: {} })
    expect(readSeatPolicy()).toEqual({ status: 'invalid', reason: 'is a symlink' })
  })

  it.each([0o666, 0o646, 0o664, 0o624])('grants nothing when mode %o lets others write it', mode => {
    writePolicy(VALID, mode)

    expect(loadSeatPolicy()).toEqual({ seats: {} })
  })

  it('still grants with an owner-only mode stricter than 0644', () => {
    writePolicy(VALID, 0o600)

    expect(Object.keys(loadSeatPolicy().seats)).toEqual(['seat-a'])
  })

  it('grants nothing when another uid owns the file', () => {
    writePolicy(VALID)
    const uid = process.getuid!()
    vi.spyOn(process, 'getuid').mockReturnValue(uid + 1)

    expect(loadSeatPolicy()).toEqual({ seats: {} })
    expect(readSeatPolicy()).toMatchObject({
      status: 'invalid',
      reason: expect.stringContaining('owned by uid'),
    })
  })

  it('does not make a seat root without root: true', () => {
    writePolicy({
      version: 1,
      seats: { 'seat-a': { ...SEAT, root: false }, 'seat-b': { ...SEAT, root: 'yes' } },
    })

    expect(loadSeatPolicy()).toEqual({ seats: {} })
  })

  it.each([
    ['a missing version', { seats: VALID.seats }],
    ['version 2', { version: 2, seats: VALID.seats }],
    ['seats as a list', { version: 1, seats: [] }],
    [
      'a root seat with no ceiling',
      { version: 1, seats: { 'seat-a': { root: true, launchProfiles: ['x'] } } },
    ],
    ['a ceiling holding a number', { version: 1, seats: { 'seat-a': { ...SEAT, ceiling: ['x', 3] } } }],
  ])('grants nothing for %s', (_case, content) => {
    writePolicy(content)

    expect(loadSeatPolicy()).toEqual({ seats: {} })
    expect(readSeatPolicy().status).toBe('invalid')
  })

  it('logs and ignores unknown keys but keeps the seat', () => {
    writePolicy({ version: 1, note: 'x', seats: { 'seat-a': { ...SEAT, accounts: ['a'] } } })

    expect(loadSeatPolicy()).toEqual({ seats: { 'seat-a': SEAT } })
    expect(logged).toHaveBeenCalledWith('seat_policy_ignored', expect.objectContaining({ key: 'note' }))
    expect(logged).toHaveBeenCalledWith(
      'seat_policy_ignored',
      expect.objectContaining({ key: 'seats.seat-a.accounts' }),
    )
  })

  it('rereads the file after a write, so a revoke takes effect without a restart', () => {
    writePolicy(VALID)
    expect(Object.keys(loadSeatPolicy().seats)).toEqual(['seat-a'])

    writePolicy({ version: 1, seats: {} })
    const later = new Date(Date.now() + 5_000)
    fs.utimesSync(seatPolicyPath(), later, later)

    expect(loadSeatPolicy()).toEqual({ seats: {} })
  })

  it('rereads after a chmod makes the same content unsafe', () => {
    writePolicy(VALID)
    expect(Object.keys(loadSeatPolicy().seats)).toEqual(['seat-a'])

    fs.chmodSync(seatPolicyPath(), 0o666)

    expect(loadSeatPolicy()).toEqual({ seats: {} })
  })
})

describe('the seat-policy doctor check', () => {
  it('is ok and names the root seats of a valid file', () => {
    writePolicy(VALID)

    expect(checkSeatPolicy()).toEqual({ name: 'seat-policy', status: 'ok', detail: '1 root seat: seat-a' })
  })

  it('is ok when the file is absent', () => {
    expect(checkSeatPolicy()).toMatchObject({
      status: 'ok',
      detail: expect.stringContaining('no root seats'),
    })
  })

  it('warns when a valid file grants no root seat', () => {
    writePolicy({ version: 1, seats: { 'seat-a': { root: false } } })

    expect(checkSeatPolicy()).toMatchObject({ status: 'warn', detail: '0 root seats' })
  })

  it('warns about ignored keys', () => {
    writePolicy({ ...VALID, extra: true })

    expect(checkSeatPolicy()).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('ignored keys: extra'),
    })
  })

  it('fails with the reason when the file is unsafe', () => {
    writePolicy(VALID, 0o666)

    expect(checkSeatPolicy()).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('group- or world-writable'),
    })
  })
})
