import { Command } from 'commander'
import { z } from 'zod'
import { afterEach, expect, it, vi } from 'vitest'
import { addVerb, defineVerb, Report } from '../cli/command.js'

class Exit extends Error {}
afterEach(() => vi.restoreAllMocks())
it.each([0, 1, 2])(
  'preserves successful inherited code and assigns failed completed code %i naturally',
  async code => {
    const prior = process.exitCode
    process.exitCode = 7
    const exit = vi.spyOn(process, 'exit').mockImplementation((): never => {
      throw new Exit()
    })
    const out = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const verb = defineVerb({
      name: 'fixture',
      description: 'synthetic report lifetime fixture',
      args: z.object({}),
      result: Report,
      run: async () => ({ ok: code === 0, lines: ['out'], errors: ['err'], exit: code }),
    })
    const program = new Command()
    const mount = { reportExit: 'set-failure-code' as const, usageExit: 2 }
    addVerb(program, verb, mount)
    let forced = false
    try {
      try {
        await program.parseAsync(['node', 'fixture', 'fixture'])
      } catch (error) {
        if (!(error instanceof Exit)) throw error
        forced = true
      }
      expect(forced).toBe(false)
      expect(exit).not.toHaveBeenCalled()
      expect(process.exitCode).toBe(code === 0 ? 7 : code)
      expect(out).toHaveBeenCalledExactlyOnceWith('out')
      expect(err).toHaveBeenCalledExactlyOnceWith('err')
    } finally {
      process.exitCode = prior
    }
  },
)
it('keeps invocation failures immediate even under completed-report code assignment', async () => {
  const exit = vi.spyOn(process, 'exit').mockImplementation((): never => {
    throw new Exit()
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const program = new Command()
  const mount = { reportExit: 'set-failure-code' as const, usageExit: 2 }
  addVerb(
    program,
    defineVerb({
      name: 'fixture',
      description: 'synthetic rejected invocation',
      args: z.object({}),
      result: Report,
      run: async () => {
        throw Object.assign(new Error('synthetic'), { code: 69 })
      },
    }),
    mount,
  )
  await expect(program.parseAsync(['node', 'fixture', 'fixture'])).rejects.toBeInstanceOf(Exit)
  expect(exit).toHaveBeenCalledExactlyOnceWith(69)
})
