import { describe, expect, it } from 'vitest'
import { MERGE_RE, PUSH_RE, inflight, listProcs } from '../cli/inflight-procs.js'

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

describe('push and merge patterns', () => {
  it('matches the absolute-path git push the agent shim runs', () => {
    expect(PUSH_RE.test('/opt/homebrew/bin/git push --dry-run origin main')).toBe(true)
    expect(PUSH_RE.test('git push origin main')).toBe(true)
    expect(PUSH_RE.test('/opt/homebrew/bin/git -C /x/work/tree push origin HEAD')).toBe(true)
    expect(PUSH_RE.test('/usr/lib/git-core/git-remote-https origin https://example.invalid/r.git')).toBe(true)
  })

  it('matches a git push behind -c and long global options', () => {
    expect(PUSH_RE.test('git -c core.askPass=x push origin main')).toBe(true)
    expect(PUSH_RE.test('/usr/bin/git --no-pager push')).toBe(true)
    expect(PUSH_RE.test('git -C /x -c a=b --no-pager push origin HEAD')).toBe(true)
  })

  it('does not match other git commands that mention push', () => {
    expect(PUSH_RE.test('git log --grep push')).toBe(false)
    expect(PUSH_RE.test('/opt/homebrew/bin/git log --grep "git push"')).toBe(false)
  })

  it('matches the merge tools and not a plain gh pr view', () => {
    expect(MERGE_RE.test('/bin/bash /x/bin/seat-merge seat o/r 1 abc')).toBe(true)
    expect(MERGE_RE.test('/opt/homebrew/bin/gh pr merge 5 --squash')).toBe(true)
    expect(MERGE_RE.test('node /x/dist/cli/index.js gh-write -- pr merge 5')).toBe(true)
    expect(MERGE_RE.test('gh pr view 5')).toBe(false)
  })
})

describe('in-flight process scan', () => {
  it('sees only the real seat-merge when a claude prompt names the merge scripts by path', () => {
    const found = inflight([
      `101 ${CLAUDE_ARGVS[0]}`,
      '202 /bin/bash /x/.local/bin/seat-merge seat o/r 1 abc /x/clone',
    ])

    expect(found).toEqual({ pushes: [], merges: [202] })
  })

  it('never counts processes that only mention merges and pushes in their arguments', () => {
    const found = inflight(CLAUDE_ARGVS.map((argv, i) => `${300 + i} ${argv}`))

    expect(found).toEqual({ pushes: [], merges: [] })
  })

  it('counts every real merge form', () => {
    const found = inflight([
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

    expect(found).toEqual({ pushes: [], merges: [11, 12, 13, 14, 15, 16, 17] })
  })

  it('counts a real git push and not git commands that mention push', () => {
    const found = inflight([
      '21 /opt/homebrew/bin/git -C /x/tree push origin HEAD',
      '22 /usr/lib/git-core/git-remote-https origin https://example.invalid/r.git',
      '23 /bin/sh -p /x/.agent-chat/git-bin/git push origin HEAD',
      '24 /opt/homebrew/bin/git -C /x/my tree push origin HEAD',
      '25 git log --grep push',
      '26 /x/.local/bin/claude --append-system-prompt run /opt/homebrew/bin/git push origin main',
    ])

    expect(found).toEqual({ pushes: [21, 22, 23, 24], merges: [] })
  })

  it('reads the right-aligned pids ps prints and skips rows without one', () => {
    const found = inflight([
      '   7 git push origin main',
      '  8 [kthreadd]',
      'garbage',
      '  7 git push origin main',
    ])

    expect(found).toEqual({ pushes: [7], merges: [] })
  })
})

describe('live process table', () => {
  it('lists this test process with its full argv', async () => {
    const rows = await listProcs()

    const own = rows.find(row => row.trim().startsWith(`${process.pid} `))
    expect(own).toBeDefined()
    expect(own).toContain('node')
  })
})
