import { describe, expect, it } from 'vitest'
import { lsofCwdsWith, type LsofRunner } from '../agents/isolation/park.js'

const failing =
  (code: unknown, stdout?: string): LsofRunner =>
  () =>
    Promise.reject(Object.assign(new Error('lsof failed'), { code, stdout }))

describe('listing process working directories with lsof (CC-282)', () => {
  it('parses a clean run', async () => {
    const list = lsofCwdsWith(async () => ({ stdout: 'p12\nn/a/b\np34\nn/c\n' }))

    expect(await list()).toEqual([
      { pid: 12, cwd: '/a/b' },
      { pid: 34, cwd: '/c' },
    ])
  })

  it('reads an empty exit 1 as no processes', async () => {
    expect(await lsofCwdsWith(failing(1, ''))()).toEqual([])
  })

  it('uses the output of an exit 1 that carries partial results', async () => {
    const list = lsofCwdsWith(failing(1, 'p12\nn/a/b\nWARNING: no such file\n'))

    expect(await list()).toEqual([{ pid: 12, cwd: '/a/b' }])
  })

  it.each([
    ['a missing lsof', failing('ENOENT')],
    ['another exit code', failing(2, 'p12\nn/a/b\n')],
    ['unparseable output on exit 1', failing(1, 'lsof: WARNING: something odd\n')],
  ])('still throws for %s', async (_name, run) => {
    await expect(lsofCwdsWith(run)()).rejects.toThrow()
  })
})
