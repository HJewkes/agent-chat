import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXEC_SCRIPT_FILES, FORKS_FILES } from './forks-files.js'

const TESTS_DIR = import.meta.dirname
const ROOT = path.resolve(TESTS_DIR, '..', '..')

// Any executable-mode literal, so a nested call or a mode asserted on a script production code wrote still counts.
const EXECUTABLE_MODE = /0o7[0-7]{2}/
const EXECS = /\b(?:spawnSync|execFileSync|execSync|execFile|spawn)\(/

/** Threads-pool files that write an executable mode and spawn, each with why no written script is exec'd. */
const SAFE_ON_THREADS: Record<string, string> = {
  'src/__tests__/burndown-tick.test.ts':
    'the stub claude binary is only resolved; its one spawn is the system git',
  'src/__tests__/burndown-liveness-tick.test.ts':
    'the stub claude binary is only resolved; its one spawn is the system git',
  'src/__tests__/burndown-ladder-tick.test.ts':
    'the stub claude binary is only resolved; its one spawn is the system git',
  'src/__tests__/burndown-stop-line-tick.test.ts':
    'the stub claude binary is only resolved; its one spawn is the system git',
  'src/__tests__/burndown-no-dispatch-tick.test.ts':
    'the stub claude binary is only resolved; its one spawn is the system git',
  'src/__tests__/burndown-scope-exhausted-tick.test.ts':
    'the stub claude binary is only resolved; its one spawn is the system git',
  'src/__tests__/burndown-tick-summary-tick.test.ts':
    'the stub claude binary is only resolved; its one spawn is the system git',
  'src/__tests__/surface-consume.test.ts':
    'runs the written script as an argument to /bin/sh, which reads it and never execs it',
  'src/__tests__/seat-watchdog-run.test.ts':
    'its 0o755 chmod restores a directory; the spawns run process.execPath',
}

const relative = (file: string): string => path.relative(ROOT, path.join(TESTS_DIR, file))

function writesThenExecs(file: string): boolean {
  const source = fs.readFileSync(path.join(TESTS_DIR, file), 'utf8')
  return EXECUTABLE_MODE.test(source) && EXECS.test(source)
}

describe('vitest pool assignment for tests that exec a script they wrote', () => {
  const candidates = fs
    .readdirSync(TESTS_DIR)
    .filter(file => file.endsWith('.test.ts') && file !== 'vitest-pool-forks.test.ts')
    .map(relative)
    .filter(file => !FORKS_FILES.includes(file) && writesThenExecs(path.basename(file)))

  it('lists no threads-pool file that writes an executable and spawns, unless it is justified', () => {
    const unjustified = candidates.filter(file => !(file in SAFE_ON_THREADS))

    expect(
      unjustified,
      'add these to EXEC_SCRIPT_FILES in src/__tests__/forks-files.ts (ETXTBSY, CC-462)',
    ).toEqual([])
  })

  it('keeps no stale entry in the threads-safe list', () => {
    const stale = Object.keys(SAFE_ON_THREADS).filter(file => !candidates.includes(file))

    expect(stale).toEqual([])
  })

  it('detects every listed exec-script file', () => {
    const missed = EXEC_SCRIPT_FILES.filter(file => !writesThenExecs(path.basename(file)))

    expect(missed, 'the detector no longer recognizes these files').toEqual([])
  })

  it('names only forks files that exist', () => {
    const missing = FORKS_FILES.filter(file => !fs.existsSync(path.join(ROOT, file)))

    expect(missing).toEqual([])
  })
})
