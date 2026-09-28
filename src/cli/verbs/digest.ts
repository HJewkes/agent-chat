import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { collectDigest } from '../../digest/collect.js'
import { renderDigest } from '../../digest/render.js'
import { parseSince } from '../../digest/window.js'
import { defineVerb, Report } from '../command.js'

export const digestVerb = defineVerb({
  name: 'digest',
  description: 'morning digest: asks, decisions, done, stalled, spend and next picks',
  args: z.object({
    since: z.string().optional(),
    markdown: z.string().optional(),
    prs: z.boolean().optional(),
  }),
  result: Report,
  cli: {
    options: {
      since: { long: '--since', description: 'window to report on, like 90m, 24h or 3d (default 24h)' },
      markdown: { long: '--markdown', description: 'write the digest as markdown to this file instead' },
      prs: { long: '--prs', description: 'also ask GitHub for approved and merged PRs (time-boxed)' },
    },
  },
  async run({ since, markdown, prs }) {
    let windowMs: number
    try {
      windowMs = parseSince(since ?? '24h')
    } catch (err) {
      return { ok: false, lines: [], errors: [err instanceof Error ? err.message : String(err)] }
    }
    const now = Date.now()
    const digest = collectDigest({ now, sinceMs: now - windowMs, prs: prs === true })
    if (markdown === undefined) return { ok: true, lines: renderDigest(digest, 'text') }
    const file = path.resolve(markdown)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${renderDigest(digest, 'markdown').join('\n')}\n`)
    return { ok: true, lines: [`wrote ${file}`] }
  },
})
