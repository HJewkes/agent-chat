import { describe, expect, it } from 'vitest'
import type { Runner } from '../agents/burndown/exec.js'
import { registerWithShepherd } from '../agents/burndown/shepherd.js'

const reg = {
  target: { repo: 'Acme/Widgets', pr: 7 },
  task: 'init/T-1',
  implementer: 'worker-a',
  headSha: 'aaa111',
}

const row = { repo: 'acme/widgets', pr: 7, runId: 'r1', phase: 'ci', headSha: 'aaa111', stalled: null }

function shepherd(rows: unknown[] | undefined): { exec: Runner; calls: string[][] } {
  const calls: string[][] = []
  const exec: Runner = (_bin, args) => {
    calls.push(args)
    if (args[1] === 'status')
      return rows === undefined ? { status: 1, stdout: '' } : { status: 0, stdout: JSON.stringify(rows) }
    return { status: 0, stdout: '' }
  }
  return { exec, calls }
}

describe('burndown registering a PR with Shepherd (TP-468)', () => {
  it('skips a PR Shepherd already lists, so the worker’s --kind survives', () => {
    const { exec, calls } = shepherd([row])

    expect(registerWithShepherd(reg, exec)).toEqual({ ok: true })
    expect(calls.some(a => a[1] === 'register')).toBe(false)
  })

  it('registers again when the listed row is at an older head', () => {
    const { exec, calls } = shepherd([{ ...row, headSha: 'old000' }])

    registerWithShepherd(reg, exec)

    expect(calls.some(a => a[1] === 'register')).toBe(true)
  })

  it.each(['done', 'failed', 'cancelled'])('registers again when the listed row is in phase %s', phase => {
    const { exec, calls } = shepherd([{ ...row, phase }])

    registerWithShepherd(reg, exec)

    expect(calls.some(a => a[1] === 'register')).toBe(true)
  })

  it('registers a PR Shepherd does not list', () => {
    const { exec, calls } = shepherd([])

    expect(registerWithShepherd(reg, exec)).toEqual({ ok: true })
    expect(calls.some(a => a[1] === 'register')).toBe(true)
  })

  it('still registers when Shepherd status is unreadable', () => {
    const { exec, calls } = shepherd(undefined)

    registerWithShepherd(reg, exec)

    expect(calls.some(a => a[1] === 'register')).toBe(true)
  })
})
