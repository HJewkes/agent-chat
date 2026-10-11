import fs from 'node:fs'
import path from 'node:path'

type PoolFields = Record<string, string | number | boolean>

/** CC-801: a charter holding only `pools:`, which is all `burndown status` and the tick read from it. */
export function writePoolCharter(autonomyRoot: string, pools: Record<string, PoolFields>): void {
  const entries = Object.entries(pools).map(([name, fields]) => {
    const pairs = Object.entries(fields).map(([key, value]) => `${key}: ${value}`)
    return `  ${name}: {${pairs.join(', ')}}`
  })
  fs.mkdirSync(autonomyRoot, { recursive: true })
  fs.writeFileSync(path.join(autonomyRoot, 'charter.md'), `---\npools:\n${entries.join('\n')}\n---\n`)
}
