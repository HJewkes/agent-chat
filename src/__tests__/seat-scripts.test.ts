import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/** CC-746: the seat scripts' own bash suites, run as CI tests so a red suite turns the check red. */

const SEAT_DIR = path.resolve(import.meta.dirname, '../../scripts/seat')
const HERMETIC_SUITES = [
  'test-ci-wait.sh',
  'test-log.sh',
  'test-merge-check.sh',
  'test-merge.sh',
  'test-pace.sh',
  'test-premerge.sh',
  'test-queue.sh',
  'test-scorecard.sh',
]
// Drives the real active-work CLI, which is not shown to write only under ACTIVE_ROOT.
const LOCAL_ONLY_SUITE = 'test-task-note.sh'
const SUMMARY = /^(?:\w+: )?(\d+) passed, (\d+) failed$|^pass (\d+) fail (\d+)$/m
const SUITE_TIMEOUT_MS = 180_000

interface SuiteRun {
  code: number | null
  output: string
}

function runSuite(name: string, tmpdir: string): Promise<SuiteRun> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [path.join(SEAT_DIR, name)], {
      cwd: SEAT_DIR,
      env: { ...process.env, TMPDIR: tmpdir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.on('error', reject)
    child.on('close', code => resolve({ code, output }))
  })
}

function summaryCounts(output: string): { passed: number; failed: number } | undefined {
  const m = SUMMARY.exec(output)
  if (!m) return undefined
  return { passed: Number(m[1] ?? m[3]), failed: Number(m[2] ?? m[4]) }
}

function onPath(command: string): boolean {
  return spawnSync('bash', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0
}

async function expectSuiteGreen(name: string): Promise<void> {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-scripts-'))
  const run = await runSuite(name, tmpdir).finally(() => fs.rmSync(tmpdir, { recursive: true, force: true }))
  const counts = summaryCounts(run.output)
  expect({ code: run.code, counts }, run.output).toEqual({
    code: 0,
    counts: { passed: expect.any(Number), failed: 0 },
  })
  expect(counts?.passed, run.output).toBeGreaterThan(0)
}

describe('seat script suites', () => {
  it.concurrent.each(HERMETIC_SUITES)(
    '%s exits 0 with no failed case',
    async name => {
      await expectSuiteGreen(name)
    },
    SUITE_TIMEOUT_MS,
  )

  it.skipIf(!onPath('active-work'))(
    `${LOCAL_ONLY_SUITE} exits 0 where active-work is installed`,
    async () => {
      await expectSuiteGreen(LOCAL_ONLY_SUITE)
    },
    SUITE_TIMEOUT_MS,
  )
})
