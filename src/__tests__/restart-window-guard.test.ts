import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = path.resolve(import.meta.dirname, '../../scripts/restart-window.sh')

// The shape that blocked the 2026-10-04 restart: a handoff prompt naming the merge scripts by path.
const CLAUDE_PROMPT =
  'to land a PR run /y/autonomy/bin/merge o/r 1 abc or /x/.local/bin/seat-merge seat o/r 1 abc, ' +
  'never /opt/homebrew/bin/gh pr merge 5 or /opt/homebrew/bin/git push origin main'
const CLAUDE_ARGVS = [
  `/x/.local/bin/claude --model opus --append-system-prompt ${CLAUDE_PROMPT}`,
  `node /x/.local/bin/claude --name coord --append-system-prompt ${CLAUDE_PROMPT}`,
  `/x/.local/bin/claude Fix the bin/merge script`,
  `/bin/zsh -c source /x/snapshot.sh 2>/dev/null || true && echo bin/merge `,
]

let dir: string
let procs: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-window-guard-'))
  procs = path.join(dir, 'procs')
  // An agent-chat outside any git checkout makes every run refuse before it touches anything.
  fs.mkdirSync(path.join(dir, 'bin'))
  fs.writeFileSync(path.join(dir, 'bin', 'agent-chat'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 })
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const run = (lines: string[], env: Record<string, string>) => {
  fs.writeFileSync(procs, lines.map(l => `${l}\n`).join(''))
  return spawnSync('bash', [SCRIPT], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
      HOME: dir,
      RESTART_WINDOW_PROCS: procs,
      ...env,
    },
  })
}

const guard = (lines: string[]): string[] => {
  const result = run(lines, { RESTART_WINDOW_TEST: '1' })
  expect(result.status).toBe(1)
  return result.stderr.split('\n').filter(l => / is running /.test(l))
}

describe('restart-window fake process list', () => {
  it('refuses to run when RESTART_WINDOW_PROCS is set without the test flag', () => {
    const result = run([], {})

    expect(result.status).toBe(1)
    expect(result.stderr).toBe(
      'restart-window: refusing: RESTART_WINDOW_PROCS is set outside a test (RESTART_WINDOW_TEST=1); unset it\n',
    )
  })

  it('reads the fake list only under the test flag', () => {
    const result = run(['7 seat-merge seat o/r 1 abc /x/clone'], { RESTART_WINDOW_TEST: '1' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('a merge is running (pid 7)')
    expect(result.stderr).not.toContain('outside a test')
  })
})

describe('restart-window push and merge guards', () => {
  it('sees only the real seat-merge when a claude prompt names the merge scripts by path', () => {
    const blockers = guard([
      `101 ${CLAUDE_ARGVS[0]}`,
      '202 /bin/bash /x/.local/bin/seat-merge seat o/r 1 abc /x/clone',
    ])

    expect(blockers).toEqual(['restart-window: refusing: a merge is running (pid 202)'])
  })

  it('never blocks on processes that only mention merges and pushes in their arguments', () => {
    const blockers = guard(CLAUDE_ARGVS.map((argv, i) => `${300 + i} ${argv}`))

    expect(blockers).toEqual([])
  })

  it('refuses on every real merge form', () => {
    const blockers = guard([
      '11 /bin/bash /x/Library/Shared Tools/autonomy/bin/merge o/r 1 abc /x/clone',
      '12 /opt/homebrew/bin/gh pr merge 5 --squash',
      '13 node /x/agent-chat/dist/cli.js gh-write -- pr merge 5',
      '14 /x/.local/bin/agent-chat gh-write -- api -X PUT repos/o/r/pulls/5/merge',
      '15 seat-merge seat o/r 1 abc /x/clone',
      '16 /bin/sh /x/.agent-chat/gh-shim/abc123/gh pr merge 5 --squash',
      '17 gh -R o/r pr merge 5',
      '18 /opt/homebrew/bin/gh pr view 5',
      '19 gh -R o/r pr view 5',
    ])

    expect(blockers).toEqual(['restart-window: refusing: a merge is running (pid 11,12,13,14,15,16,17)'])
  })

  it('refuses on a real git push and not on git commands that mention push', () => {
    const blockers = guard([
      '21 /opt/homebrew/bin/git -C /x/tree push origin HEAD',
      '22 /usr/lib/git-core/git-remote-https origin https://example.invalid/r.git',
      '23 /bin/sh -p /x/.agent-chat/git-bin/git push origin HEAD',
      '24 /opt/homebrew/bin/git -C /x/my tree push origin HEAD',
      '25 git log --grep push',
      '26 /x/.local/bin/claude --append-system-prompt run /opt/homebrew/bin/git push origin main',
    ])

    expect(blockers).toEqual(['restart-window: refusing: a git push is running (pid 21,22,23,24)'])
  })
})
