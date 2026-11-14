import fs from 'node:fs'
import path from 'node:path'
import { home } from '../paths.js'
import { emptyGuardState, type GuardState } from './account-guard.js'

/** CC-894: the guard's memory across ticks: each seat's last move, blocked accounts and noticed episode. */

export const guardStatePath = (): string => path.join(home(), 'account-guard.json')

/** A missing or unreadable file starts empty: the worst case is one extra notice or an early move back. */
export function readGuardState(file: string = guardStatePath()): GuardState {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<GuardState>
    return typeof parsed.seats === 'object' && parsed.seats !== null
      ? { seats: parsed.seats }
      : emptyGuardState()
  } catch {
    return emptyGuardState()
  }
}

export function saveGuardState(state: GuardState, file: string = guardStatePath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  fs.renameSync(tmp, file)
}
