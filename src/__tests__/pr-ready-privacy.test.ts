import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Run, RunResult } from '../cli/verbs/pr-ready.js'
import { hasPrivacyTest, PRIVACY_TEST, privacyStep } from '../cli/verbs/pr-ready-privacy.js'

// Synthetic names only: fixtures-privacy scans this file too.
const COMMAND = 'npx --no-install vitest run src/__tests__/fixtures-privacy.test.ts'
const LEAK_OUTPUT = [
  ' FAIL  src/__tests__/fixtures-privacy.test.ts > fixture privacy guard',
  'AssertionError: privacy leak: planted.test.ts: seat-zz-leak (use synthetic names such as seat-a; see' +
    " fixtures-privacy.test.ts for the banned list): expected [ 'planted.test.ts: seat-zz-leak' ] to deeply equal []",
  ' Test Files  1 failed (1)',
].join('\n')
const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function answering(result: RunResult) {
  const calls: string[] = []
  const run: Run = async (cmd, args) => (calls.push([cmd, ...args].join(' ')), result)
  return { run, calls }
}

async function runStep(result: RunResult) {
  const { run, calls } = answering(result)
  const errLines: string[] = []
  const outcome = await privacyStep(run, '/nowhere', line => errLines.push(line))
  return { outcome, calls, errLines }
}

describe('pr-ready privacy step', () => {
  it('fails with the leak line, naming the file and the name', async () => {
    const { outcome, calls, errLines } = await runStep({ code: 1, output: LEAK_OUTPUT })

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe(
      'privacy leak: planted.test.ts: seat-zz-leak (use synthetic names such as seat-a; see' +
        ' fixtures-privacy.test.ts for the banned list)',
    )
    expect(calls).toEqual([COMMAND])
    expect(errLines).toEqual([LEAK_OUTPUT])
  })

  it('falls back to naming the command when the output has no leak line', async () => {
    const { outcome } = await runStep({ code: 1, output: 'vitest: config failed to load\n' })

    expect(outcome).toEqual({ ok: false, reason: `failed: ${COMMAND}` })
  })

  it('passes when the privacy test exits 0', async () => {
    const { outcome, errLines } = await runStep({ code: 0, output: ' Test Files  1 passed (1)\n' })

    expect(outcome).toEqual({ ok: true })
    expect(errLines).toEqual([])
  })
})

describe('hasPrivacyTest', () => {
  const scratch = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-ready-privacy-'))
    tmpDirs.push(dir)
    return dir
  }

  it('is false for a checkout with a test directory but no privacy test', () => {
    const dir = scratch()
    fs.mkdirSync(path.join(dir, 'src', '__tests__'), { recursive: true })

    expect(hasPrivacyTest(dir)).toBe(false)
  })

  it('is true for a checkout with the privacy test', () => {
    const dir = scratch()
    fs.mkdirSync(path.join(dir, path.dirname(PRIVACY_TEST)), { recursive: true })
    fs.writeFileSync(path.join(dir, PRIVACY_TEST), '')

    expect(hasPrivacyTest(dir)).toBe(true)
  })
})
