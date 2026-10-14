import { describe, expect, it } from 'vitest'
import type { RunResult } from '../agents/burndown/exec.js'
import { readParkedWork } from '../agents/burndown/exited-adopt.js'

const CHECKOUT = '/repo'
const BRANCH = 'agent-chat/bd-cc-1'
const PR = 'https://github.com/o/r/pull/7'
const OK: RunResult = { status: 0, stdout: '' }

interface Fake {
  branchExists?: boolean
  gh?: (path: string) => RunResult
}

function runner({ branchExists = true, gh = () => ({ status: 0, stdout: `${PR}\n` }) }: Fake = {}) {
  return (bin: string, args: string[]): RunResult => {
    if (bin === 'gh') return gh(args[1] ?? '')
    const last = args.at(-1) ?? ''
    if (args.includes('--verify')) {
      if (last === `refs/heads/${BRANCH}`) return { status: branchExists ? 0 : 1, stdout: '' }
      return { status: last === 'origin/HEAD^{commit}' ? 0 : 1, stdout: '' }
    }
    if (args[0] === 'rev-list')
      return { status: 0, stdout: last === `origin/HEAD..${BRANCH}` ? '3\n' : '0\n' }
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'main\n' }
    if (args.includes('get-url')) return { status: 0, stdout: 'git@github.com:o/r.git\n' }
    return OK
  }
}

describe('readParkedWork', () => {
  it("counts the commits on the parked branch, not the checkout's HEAD", () => {
    expect(readParkedWork(CHECKOUT, BRANCH, runner())?.ahead).toBe(3)
  })

  it('asks GitHub for open PRs on owner:agent-chat/<name>', () => {
    const gh = (path: string): RunResult =>
      path.includes('head=o%3Aagent-chat%2Fbd-cc-1&')
        ? { status: 0, stdout: `${PR}\n` }
        : { status: 0, stdout: '\n' }

    expect(readParkedWork(CHECKOUT, BRANCH, runner({ gh }))).toEqual({ openPr: PR, ahead: 3 })
  })

  it('reads a branch that no longer exists as unreadable, never as no work', () => {
    expect(readParkedWork(CHECKOUT, BRANCH, runner({ branchExists: false }))).toBeUndefined()
  })

  it('gives undefined when GitHub cannot be read', () => {
    expect(
      readParkedWork(CHECKOUT, BRANCH, runner({ gh: () => ({ status: 1, stdout: '' }) })),
    ).toBeUndefined()
  })
})
