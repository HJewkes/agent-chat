import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { describeExecFailure } from '../exec.js'
import { shepherdRowsAsync } from '../shepherd-client.js'
import { readActiveRuns, shepherdSkip, type ShepherdSkipPort } from '../agents/isolation/shepherd-skip.js'
import type { AgentIdentity } from '../protocol.js'

// CC-1096: a failed Shepherd read said only "Command failed: titan-factory shepherd status --json".

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shepherd-read-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function script(name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

const failing = (): string => script('fail', 'echo "boom: zod release" >&2\necho "second line" >&2\nexit 3')

const agent = { name: 'tc-x-a' } as AgentIdentity

describe('Shepherd status read failures', () => {
  it('names the exit code, cwd and first stderr line, and park keeps its reason prefix', async () => {
    const bin = failing()

    const err = (await readActiveRuns({ bin }).catch((e: unknown) => e)) as Error
    const port: ShepherdSkipPort = { activeRuns: () => readActiveRuns({ bin }), hasOpenPr: async () => false }
    const reason = await shepherdSkip(port, agent, undefined)

    expect(err.message).not.toContain('\n')
    expect(err.message).toMatch(/^exit 3 after \d+ ms/)
    expect(err.message).toContain(`cwd ${homedir()}: boom: zod release`)
    expect(err.message).not.toContain('second line')
    expect(reason).toMatch(/^Shepherd could not be read \(exit 3 .*boom: zod release\)/)
  })

  it('reports a timeout kill as the signal plus (timeout), with the elapsed ms', async () => {
    const bin = script('slow', 'exec sleep 5')

    const err = (await readActiveRuns({ bin, timeoutMs: 200 }).catch((e: unknown) => e)) as Error

    const match = /^killed by SIGTERM after (\d+) ms \(timeout\), cwd /.exec(err.message)
    expect(match).not.toBeNull()
    expect(Number(match?.[1])).toBeGreaterThanOrEqual(200)
  })

  it('runs in the home directory and reads an unfinished run', async () => {
    const out = join(dir, 'pwd')
    const bin = script('ok', `pwd > ${out}\necho '[{"phase":"open","branch":"b","implementer":"i"}]'`)

    const runs = await readActiveRuns({ bin })

    expect(runs).toEqual([{ branch: 'b', names: ['i'], implementer: 'i', phase: 'open' }])
    expect(readFileSync(out, 'utf8').trim()).toBe(homedir())
  })

  it('logs one shepherd_status_failed row for the async read and answers undefined', async () => {
    const rows: Array<[string, Record<string, unknown>]> = []

    const result = await shepherdRowsAsync((event, detail) => rows.push([event, detail]), 5_000, failing())

    expect(result).toBeUndefined()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.[0]).toBe('shepherd_status_failed')
    expect(String(rows[0]?.[1].error)).toMatch(/^exit 3 after \d+ ms, cwd .*: boom: zod release$/)
  })
})

describe('describeExecFailure', () => {
  it('keeps only the first non-empty stderr line, capped at 200 chars', () => {
    const err = Object.assign(new Error('Command failed: x\nnoise'), {
      code: 2,
      stderr: `\n  ${'e'.repeat(300)}\nmore\n`,
    })

    const line = describeExecFailure(err, { cwd: '/w', elapsedMs: 12.4 })

    expect(line).toBe(`exit 2 after 12 ms, cwd /w: ${'e'.repeat(200)}`)
  })

  it('names a spawn error code such as a missing binary', () => {
    const err = Object.assign(new Error('spawn nope ENOENT'), { code: 'ENOENT' })

    expect(describeExecFailure(err, { cwd: '/w', elapsedMs: 3 })).toBe('ENOENT after 3 ms, cwd /w')
  })
})
