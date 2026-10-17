import { format } from 'node:util'
import { z } from 'zod'
import { defineVerb, Report } from '../command.js'

export const prReadyVerb = defineVerb({
  name: 'pr-ready',
  description:
    'before gh pr create: clean tree, rebase, checks, changeset, leak scan; exit 0 only when all pass',
  args: z.object({
    title: z.string().optional(),
    bodyFile: z.string().optional(),
    noRebase: z.boolean().optional(),
    strict: z.boolean().optional(),
  }),
  result: Report,
  cli: {
    options: {
      title: { long: '--title', valueName: 't', description: "PR title, scanned with gh-write's leak scan" },
      bodyFile: {
        long: '--body-file',
        valueName: 'path',
        description: "PR body file, scanned with gh-write's leak scan",
      },
      noRebase: {
        long: '--no-rebase',
        description: 'check and report only; do not rebase onto the default branch',
      },
      strict: {
        long: '--strict',
        description: 'fail, not just note, a pushed branch that is behind the default branch',
      },
    },
  },
  async run(options) {
    try {
      const { prReady } = await import('./pr-ready.js')
      const code = await prReady({
        rebase: options.noRebase !== true,
        ...(options.title === undefined ? {} : { title: options.title }),
        ...(options.bodyFile === undefined ? {} : { bodyFile: options.bodyFile }),
        ...(options.strict === undefined ? {} : { strict: options.strict }),
      })
      return { ok: code === 0, lines: [], exit: code }
    } catch (error) {
      // Keep the original immediate exit1 and Console rendering for rejected helpers.
      throw new Error(error instanceof Error ? error.message : format(error))
    }
  },
})
