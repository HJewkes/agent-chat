import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FORKS_FILES } from './forks-files.js'

const TESTS_DIR = import.meta.dirname
const ROOT = path.resolve(TESTS_DIR, '..', '..')

// A call that writes a file with an executable mode, or chmods one to it.
const WRITES_EXECUTABLE = /\b(?:writeFileSync|writeFile|chmodSync|chmod)\((?:[^()]|\([^()]*\))*?0o7[0-7]{2}/
const EXECS = /\b(?:spawnSync|execFileSync|execSync|execFile|spawn)\(/

/** Threads-pool files that write an executable mode and spawn, each with why no written script is exec'd. */
const SAFE_ON_THREADS: Record<string, string> = {
  'src/__tests__/burndown-tick.test.ts':
    'the stub claude binary is only resolved; its one spawn is the system git',
  'src/__tests__/surface-consume.test.ts':
    'runs the written script as an argument to /bin/sh, which reads it and never execs it',
  'src/__tests__/seat-watchdog-run.test.ts':
    'its 0o755 chmod restores a directory; the spawns run process.execPath',
}

const relative = (file: string): string => path.relative(ROOT, path.join(TESTS_DIR, file))

function writesThenExecs(file: string): boolean {
  const source = fs.readFileSync(path.join(TESTS_DIR, file), 'utf8')
  return WRITES_EXECUTABLE.test(source) && EXECS.test(source)
}

describe('vitest pool assignment for tests that exec a script they wrote', () => {
  const candidates = fs
    .readdirSync(TESTS_DIR)
    .filter(file => file.endsWith('.test.ts') && file !== 'vitest-pool-forks.test.ts')
    .map(relative)
    .filter(file => !FORKS_FILES.includes(file) && writesThenExecs(path.basename(file)))

  it('lists no threads-pool file that writes an executable and spawns, unless it is justified', () => {
    const unjustified = candidates.filter(file => !(file in SAFE_ON_THREADS))

    expect(unjustified, 'add these to FORKS_FILES in vitest.config.ts (ETXTBSY, CC-462)').toEqual([])
  })

  it('keeps no stale entry in the threads-safe list', () => {
    const stale = Object.keys(SAFE_ON_THREADS).filter(file => !candidates.includes(file))

    expect(stale).toEqual([])
  })

  it('names only forks files that exist', () => {
    const missing = FORKS_FILES.filter(file => !fs.existsSync(path.join(ROOT, file)))

    expect(missing).toEqual([])
  })
})
