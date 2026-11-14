import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withBroker } from '../cli/client.js'
import { gateLoop, heartbeatGateVerb, parseGitSpec, readFingerprint } from '../cli/verbs/heartbeat-gate.js'

const ctx = { warnings: [], format: 'human' as const, withBroker }
let dir: string
let repo: string
let stateFile: string

function git(...args: string[]): void {
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
    stdio: 'ignore',
  })
}

const once = (args: { git?: string[]; path?: string[] }) =>
  heartbeatGateVerb.run({ ...args, once: true, state: stateFile }, ctx)

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-gate-'))
  repo = path.join(dir, 'model-repo')
  stateFile = path.join(dir, 'state', 'gate.json')
  fs.mkdirSync(repo)
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  git('commit', '-q', '--allow-empty', '-m', 'first')
})

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('heartbeat gate --once', () => {
  it('prints nothing on the seeding run and nothing again until HEAD moves', async () => {
    const watch = { git: [`${repo}:main`] }

    const seed = await once(watch)
    const idle = await once(watch)
    git('commit', '-q', '--allow-empty', '-m', 'second')
    const moved = await once(watch)

    expect(seed.lines).toEqual([])
    expect(idle.lines).toEqual([])
    expect(moved.lines).toHaveLength(1)
    expect(moved.lines[0]).toMatch(new RegExp(`^changed: ${repo}@main [0-9a-f]{40} -> [0-9a-f]{40}$`))
  })

  it('names the new file when a report lands in a watched directory', async () => {
    const reports = path.join(dir, 'reports')
    fs.mkdirSync(reports)

    await once({ path: [reports] })
    fs.writeFileSync(path.join(reports, 'worker-a.md'), 'Status: DONE\n')
    const landed = await once({ path: [reports] })

    expect(landed.lines).toEqual([expect.stringContaining(`${path.join(reports, 'worker-a.md')} absent -> `)])
  })

  it('reads a missing path as absent instead of skipping it', () => {
    const missing = path.join(dir, 'run-state.json')

    expect(readFingerprint({ git: [], paths: [missing] })).toEqual({ [missing]: 'absent' })
  })

  it('refuses a run with nothing to watch', async () => {
    const report = await once({})

    expect(report.ok).toBe(false)
  })
})

describe('heartbeat gate loop', () => {
  it('prints only on change and after max-quiet across many silent polls', async () => {
    const fps = [...Array(5).fill({ k: 'a' }), ...Array(8).fill({ k: 'b' })]
    const printed: string[] = []
    let nowMs = 0
    let polls = 0
    const stop = new Error('stop')

    const loop = gateLoop(
      {
        read: () => fps[polls],
        now: () => nowMs,
        print: line => printed.push(line),
        sleep: async ms => {
          polls += 1
          nowMs += ms
          if (polls === fps.length) throw stop
        },
      },
      { everyMs: 20 * 60_000, maxQuietMs: 120 * 60_000 },
    )

    await expect(loop).rejects.toBe(stop)
    expect(printed).toEqual(['changed: k a -> b', 'quiet: nothing changed in 120 min'])
  })
})

describe('parseGitSpec', () => {
  it('defaults the ref to HEAD and splits on the last colon', () => {
    expect(parseGitSpec('/src/model')).toEqual({ repo: '/src/model', ref: 'HEAD' })
    expect(parseGitSpec('/src/model:main')).toEqual({ repo: '/src/model', ref: 'main' })
  })
})
