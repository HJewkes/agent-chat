import { z } from 'zod'
import { clampLimit, positiveLimit } from '../../args.js'
import { parseSince } from '../../digest/window.js'
import { readCalls, renderSummary, summarize } from '../../gh-calls/summary.js'
import { defineVerb, Report } from '../command.js'

const DEFAULT_TOP = 5
const MAX_TOP = 100

export const ghCallsVerb = defineVerb({
  name: 'gh-calls',
  description: 'read the GitHub call log: top callers and routes, and 403s split by limit',
  args: z.object({
    since: z.string().optional(),
    top: positiveLimit('top').optional(),
    json: z.boolean().optional(),
  }),
  result: Report,
  cli: {
    options: {
      since: { long: '--since', description: 'window to read, like 90m, 24h or 3d (default 24h)' },
      top: { long: '--top <n>', description: `how many callers and routes to list (default ${DEFAULT_TOP})` },
      json: { long: '--json', description: 'print the summary as one JSON object' },
    },
  },
  async run({ since, top, json }) {
    let windowMs: number
    try {
      windowMs = parseSince(since ?? '24h')
    } catch (err) {
      return { ok: false, lines: [], errors: [err instanceof Error ? err.message : String(err)] }
    }
    const from = new Date(Date.now() - windowMs)
    const summary = summarize(readCalls(from), from, clampLimit(top, DEFAULT_TOP, MAX_TOP))
    return { ok: true, lines: json === true ? [JSON.stringify(summary)] : renderSummary(summary) }
  },
})
