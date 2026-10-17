import fs from 'node:fs'
import { z } from 'zod'
import { logPath } from '../../paths.js'
import { defineVerb, Report } from '../command.js'

/** Last `n` lines of `text`, ignoring a trailing newline. */
export function tailLines(text: string, n: number): string[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.slice(Math.max(0, lines.length - n))
}

// Legacy parseInt accepts prefixes and NaN: NaN means all lines in tailLines.
// A pipe preserves raw CLI strings until this declared product policy runs.
const Lines = z
  .preprocess(
    value => (typeof value === 'number' ? value : Number.parseInt(String(value), 10)),
    z.custom<number>(value => typeof value === 'number'),
  )
  .default(50)

export const serviceLogsVerb = defineVerb({
  name: 'service.logs',
  description: 'tail the broker log; no --follow, by design',
  args: z.object({ lines: Lines }),
  result: Report,
  cli: {
    options: { lines: { short: '-n', long: '--lines', valueName: 'n', description: 'how many lines' } },
  },
  async run({ lines }) {
    let raw: string
    try {
      raw = fs.readFileSync(logPath(), 'utf8')
    } catch {
      return { ok: true, lines: [`No log at ${logPath()} yet.`] }
    }
    return { ok: true, lines: tailLines(raw, lines) }
  },
})
