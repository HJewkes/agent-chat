import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Check } from './doctor.js'

/**
 * Is anything still publishing the per-session budget the context hint reads? (CC-128)
 *
 * The writer is one guarded line in a status-line script this repo does not
 * own. On 2026-09-15 `chezmoi apply` removed it, every hint went silent, and
 * nothing said so until 2026-09-20: a missing reading is a normal state to the
 * reader, so only a check that expects readings can notice them stop.
 */

export const STATUSLINE_STALE_MINUTES = 30

const WRITER = 'session-budget-write.sh'

export interface StatuslineCacheProbe {
  cacheDir: string
  now: number
  /** Sessions the broker holds, or undefined when no broker answered. */
  registeredSessions: number | undefined
  maxAgeMinutes?: number
}

/** Fails when sessions are registered but no reading is newer than the cutoff. */
export function checkStatuslineCache(probe: StatuslineCacheProbe): Check {
  const name = 'status-line budget'
  const maxAge = probe.maxAgeMinutes ?? STATUSLINE_STALE_MINUTES
  if (!probe.registeredSessions) {
    return { name, status: 'ok', detail: 'no registered sessions, so no reading is expected' }
  }
  const newest = newestReadingMs(probe.cacheDir)
  if (newest === undefined) {
    return {
      name,
      status: 'fail',
      detail: `${probe.registeredSessions} sessions registered but ${probe.cacheDir} has no readings — ${fix}`,
    }
  }
  const ageMinutes = Math.floor((probe.now - newest) / 60_000)
  return ageMinutes > maxAge
    ? {
        name,
        status: 'fail',
        detail: `newest reading is ${ageMinutes}m old with ${probe.registeredSessions} sessions registered — ${fix}`,
      }
    : { name, status: 'ok', detail: `newest reading ${ageMinutes}m old in ${probe.cacheDir}` }
}

const fix = `the status line has stopped calling ${WRITER}; context hints are silent until it is restored`

function newestReadingMs(dir: string): number | undefined {
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('.'))
  } catch {
    return undefined
  }
  const times = files.map(f => fs.statSync(path.join(dir, f)).mtimeMs)
  return times.length === 0 ? undefined : Math.max(...times)
}

/** Warns when the configured status-line command never reaches the writer. */
export function checkStatuslineHook(settingsFile: string): Check {
  const name = 'status-line hook'
  const command = statusLineCommand(settingsFile)
  if (command === undefined) {
    return {
      name,
      status: 'warn',
      detail: `no statusLine command in ${settingsFile}, so no budget is published`,
    }
  }
  if (command.includes(WRITER))
    return { name, status: 'ok', detail: 'statusLine command calls the writer directly' }
  const script = scriptIn(command)
  if (script !== undefined && readOrEmpty(script).includes(WRITER)) {
    return { name, status: 'ok', detail: `${script} calls ${WRITER}` }
  }
  return {
    name,
    status: 'warn',
    detail: `${script ?? command} does not reference ${WRITER}; reinstall the hook (docs/context-budget-research.md)`,
  }
}

function statusLineCommand(settingsFile: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as { statusLine?: { command?: unknown } }
    const command = parsed.statusLine?.command
    return typeof command === 'string' && command !== '' ? command : undefined
  } catch {
    return undefined
  }
}

/** The first word of the command that names an existing file, after `~` and `$HOME` expansion. */
function scriptIn(command: string): string | undefined {
  return command
    .split(/\s+/)
    .map(word => word.replace(/^~(?=\/)/, os.homedir()).replace(/^\$HOME(?=\/)/, os.homedir()))
    .find(word => word.includes('/') && fs.existsSync(word))
}

function readOrEmpty(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}
