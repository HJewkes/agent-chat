import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loggingRunner, type Runner, type RunResult } from '../agents/burndown/exec.js'
import type { GhCallLine } from '../gh-calls/log.js'

/** TP-1172 c: the burndown tick's runner logs one gh-calls line per gh call and none for git. */

const SECONDARY = 'gh: You have exceeded a secondary rate limit. Please wait. (HTTP 403) secret-pr-title'

const answers: Record<string, RunResult> = {
  'gh api repos/acme/widgets/pulls/7 --jq .head.sha': { status: 0, stdout: 'abc\n', stderr: '' },
  'gh pr view 7 --json state': { status: 0, stdout: '{"state":"OPEN"}', stderr: '' },
  'gh api repos/acme/widgets/pulls?state=open': { status: 1, stdout: '', stderr: SECONDARY },
  'git status --porcelain': { status: 0, stdout: '', stderr: '' },
  'git rev-parse HEAD': { status: 0, stdout: 'abc\n', stderr: '' },
}

const fakeRunner: Runner = (bin, args) =>
  answers[[bin, ...args].join(' ')] ?? { status: 9, stdout: '', stderr: 'no answer' }

function tickWithFakeRunner(): { lines: GhCallLine[]; results: RunResult[] } {
  const lines: GhCallLine[] = []
  let now = 1_000
  const exec = loggingRunner(
    fakeRunner,
    line => lines.push(line),
    () => (now += 25),
  )
  const results = Object.keys(answers).map(key => {
    const [bin = '', ...args] = key.split(' ')
    return exec(bin, args)
  })
  return { lines, results }
}

describe('burndown tick gh-calls log', () => {
  const dirs: string[] = []
  const savedState = process.env.XDG_STATE_HOME
  afterEach(() => {
    if (savedState === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = savedState
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('writes one burndown-tick line per gh call and none for git', () => {
    const { lines, results } = tickWithFakeRunner()

    expect(lines).toHaveLength(3)
    expect(lines.every(line => line.caller === 'burndown-tick' && line.v === 1)).toBe(true)
    expect(lines.map(line => `${line.method} ${line.route} ${line.status}`)).toEqual([
      'GET repos/{o}/{r}/pulls/{n} ok',
      'CLI pr view ok',
      'GET repos/{o}/{r}/pulls 403',
    ])
    expect(lines[0]?.ms).toBe(25)
    expect(results.map(result => result.stdout)).toEqual(Object.values(answers).map(answer => answer.stdout))
  })

  it('classifies a secondary-limit refusal without storing its stderr', () => {
    const refused = tickWithFakeRunner().lines[2]

    expect(refused?.limit).toBe('secondary')
    expect(JSON.stringify(refused)).not.toContain('secret-pr-title')
    expect(JSON.stringify(refused)).not.toContain('exceeded')
  })

  it('appends to the day file under XDG_STATE_HOME by default', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-burndown-gh-log-'))
    dirs.push(dir)
    process.env.XDG_STATE_HOME = dir
    const exec = loggingRunner(fakeRunner)

    exec('gh', ['pr', 'view', '7', '--json', 'state'])

    const logDir = path.join(dir, 'gh-calls')
    const [file = ''] = fs.readdirSync(logDir)
    const line = JSON.parse(fs.readFileSync(path.join(logDir, file), 'utf8')) as GhCallLine
    expect(line).toMatchObject({ caller: 'burndown-tick', method: 'CLI', route: 'pr view', status: 'ok' })
  })
})
