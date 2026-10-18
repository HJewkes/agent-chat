import { format } from 'node:util'
import { z } from 'zod'
import { defineVerb, Report } from '../command.js'

/** Controllers retain raw output, process codes and their own cleanup/lifetime policy. */
export const ghWriteVerb = defineVerb({
  name: 'gh-write',
  description: 'one gh write after --, spaced machine-wide and retried on the secondary rate limit',
  args: z.object({ 'gh-args': z.array(z.string()) }),
  result: Report,
  cli: { positional: ['gh-args'] },
  async run({ 'gh-args': args }) {
    try {
      const { ghWriteCommand } = await import('../gh-write.js')
      await ghWriteCommand(args)
      return { ok: true, lines: [] }
    } catch (error) {
      return { ok: false, lines: [], errors: [error instanceof Error ? error.message : format(error)] }
    }
  },
})

export const suiteSlotVerb = defineVerb({
  name: 'suite-slot',
  description: 'run a full test suite after --, holding one of the machine-wide full-suite slots',
  args: z.object({ command: z.array(z.string()) }),
  result: Report,
  cli: { positional: ['command'] },
  async run({ command }) {
    try {
      const { suiteSlotCommand } = await import('../suite-slot.js')
      await suiteSlotCommand(command)
      return { ok: true, lines: [] }
    } catch (error) {
      return { ok: false, lines: [], errors: [error instanceof Error ? error.message : format(error)] }
    }
  },
})
