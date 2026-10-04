import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = path.resolve(import.meta.dirname, '../../scripts/restart-window.sh')

const CLAUDE_PROMPT =
  'to land a PR run bin/merge or seat-merge seat o/r 1 abc, never gh pr merge 5 or git push origin main'
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

const guard = (lines: string[]): string[] => {
  fs.writeFileSync(procs, lines.map(l => `${l}\n`).join(''))
  const result = spawnSync('bash', [SCRIPT], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, HOME: dir, RESTART_WINDOW_PROCS: procs },
  })
  expect(result.status).toBe(1)
  return result.stderr.split('\n').filter(l => / is running /.test(l))
}

describe('restart-window push and merge guards', () => {
  it('sees only the real seat-merge when a claude prompt mentions bin/merge', () => {
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
      '13 node /x/agent-chat/dist/cli/index.js gh-write -- pr merge 5',
      '14 /x/.local/bin/agent-chat gh-write -- api -X PUT repos/o/r/pulls/5/merge',
      '15 seat-merge seat o/r 1 abc /x/clone',
      '16 /opt/homebrew/bin/gh pr view 5',
    ])

    expect(blockers).toEqual(['restart-window: refusing: a merge is running (pid 11,12,13,14,15)'])
  })

  it('refuses on a real git push and not on git commands that mention push', () => {
    const blockers = guard([
      '21 /opt/homebrew/bin/git -C /x/tree push origin HEAD',
      '22 /usr/lib/git-core/git-remote-https origin https://example.invalid/r.git',
      '23 git log --grep push',
      '24 /x/.local/bin/claude --append-system-prompt run git push origin main',
    ])

    expect(blockers).toEqual(['restart-window: refusing: a git push is running (pid 21,22)'])
  })
})
