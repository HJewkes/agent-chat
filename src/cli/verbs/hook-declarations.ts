import { format } from 'node:util'
import { z } from 'zod'
import { defineVerb, Report } from '../command.js'

/** Raw hook phases are interpreted by the existing effect, including unknown values. */
export const seatHookVerb = defineVerb({
  name: 'seat-hook',
  description: '',
  args: z.object({ phase: z.string() }),
  result: Report,
  cli: { positional: ['phase'] },
  async run({ phase }) {
    try {
      const { seatHook } = await import('./seat-hook.js')
      await seatHook(phase)
      return { ok: true, lines: [] }
    } catch (error) {
      return { ok: false, lines: [], errors: [error instanceof Error ? error.message : format(error)] }
    }
  },
})

export const leakPretoolVerb = defineVerb({
  name: 'leak-guard.pretool',
  description: 'deny a tool call that would bypass the leak scan or post a finding',
  args: z.object({}),
  result: Report,
  async run() {
    try {
      const { leakPretool } = await import('./leak-pretool.js')
      await leakPretool()
      return { ok: true, lines: [] }
    } catch (error) {
      return { ok: false, lines: [], errors: [error instanceof Error ? error.message : format(error)] }
    }
  },
})
