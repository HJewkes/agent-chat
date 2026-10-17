import { format } from 'node:util'
import { z } from 'zod'
import { defineVerb, Report } from '../command.js'

export const leakScanVerb = defineVerb({
  name: 'leak-scan',
  description: 'scan added lines for private data; exit 0 clean, 1 findings, 2 cannot pass',
  args: z.object({
    range: z.string().optional(),
    textFile: z.string().optional(),
    json: z.boolean().optional(),
  }),
  result: Report,
  cli: {
    options: {
      range: {
        long: '--range',
        valueName: 'from..to',
        description: 'scan added lines, added file names and commit messages in this range',
      },
      textFile: {
        long: '--text-file',
        valueName: 'file',
        description: 'scan every line of a file, such as a PR body',
      },
      json: { long: '--json', description: 'print one JSON object with the findings' },
    },
  },
  async run(options) {
    try {
      const { leakScan } = await import('./leak-scan.js')
      const code = await leakScan({
        ...(options.range === undefined ? {} : { range: options.range }),
        ...(options.textFile === undefined ? {} : { textFile: options.textFile }),
        ...(options.json === undefined ? {} : { json: options.json }),
      })
      return { ok: code === 0, lines: [], exit: code }
    } catch (error) {
      // An unexpected exception used to reach cli.ts's immediate exit1 boundary.
      // Preserve its Console text and avoid inheriting a foreign numeric error code.
      throw new Error(error instanceof Error ? error.message : format(error))
    }
  },
})
