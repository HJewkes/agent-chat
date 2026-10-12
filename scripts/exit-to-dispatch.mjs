#!/usr/bin/env node
// CC-1111: median wait from a burndown implementer's exit to the next tick that dispatched, over the last hours.
// Usage: node scripts/exit-to-dispatch.mjs [--hours 6] [--profile implementer] [--max-wait-min 30] [--json]
// Reads <home>/events.db and <home>/burndown-ticks.jsonl (home is AGENT_CHAT_HOME or ~/.agent-chat); writes
// nothing. --profile matches the spawn row's profile as a substring. Needs `npm run build` (in a worktree).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DIST = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../dist/agents/burndown/exit-latency.js',
)

const EXITS = `
  SELECT e.ref AS agentId, e.ts AS atMs FROM events e
  JOIN events s ON s.kind = 'agent_spawned' AND s.msg_id = e.ref
  WHERE e.kind IN ('agent_exited', 'agent_retired') AND e.ts >= ?
    AND json_extract(s.meta, '$.spawned_as') = 'burndown'
    AND instr(json_extract(s.meta, '$.profile'), ?) > 0`

function parseArgs(argv) {
  const args = { hours: 6, profile: 'implementer', maxWaitMin: 30, json: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--hours') args.hours = Number(argv[++i])
    else if (argv[i] === '--profile') args.profile = argv[++i] ?? ''
    else if (argv[i] === '--max-wait-min') args.maxWaitMin = Number(argv[++i])
    else if (argv[i] === '--json') args.json = true
    else throw new Error(`unknown argument ${argv[i]}`)
  }
  if (!(args.hours > 0) || !(args.maxWaitMin > 0))
    throw new Error('--hours and --max-wait-min must be positive')
  return args
}

function readExits(dbPath, sinceMs, profile) {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return db.prepare(EXITS).all(sinceMs, profile)
  } finally {
    db.close()
  }
}

const args = parseArgs(process.argv.slice(2))
const home = process.env.AGENT_CHAT_HOME ?? path.join(os.homedir(), '.agent-chat')
const sinceMs = Date.now() - args.hours * 3_600_000
const { dispatchTicks, exitToDispatch } = await import(pathToFileURL(DIST).href)
const ticksFile = path.join(home, 'burndown-ticks.jsonl')
const ticks = dispatchTicks(fs.existsSync(ticksFile) ? fs.readFileSync(ticksFile, 'utf8') : '')
const exits = readExits(path.join(home, 'events.db'), sinceMs, args.profile)
const result = exitToDispatch(exits, ticks, args.maxWaitMin * 60_000)
if (args.json) console.log(JSON.stringify({ hours: args.hours, ...result }))
else {
  const median = result.medianMs === undefined ? 'n/a' : `${(result.medianMs / 60_000).toFixed(1)} min`
  console.log(`last ${args.hours} h: median exit-to-dispatch ${median} over ${result.samples} exits`)
  console.log(
    `${result.unmatched} exits had no dispatch within ${args.maxWaitMin} min (idle for want of work)`,
  )
}
