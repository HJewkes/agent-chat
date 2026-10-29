#!/usr/bin/env node
// CC-1661: join seat-watch shadow rows to coordinator turns and print the confusion matrix, recall on
// state-changing wakes, and the wakes and $ the gate would have avoided.
// Usage: node scripts/seat-watch-join.mjs --turns <turns.jsonl> [--dir <seat-watch dir>] [--trigger <t> ...] [--json]
// Turns are the workflows-2026-10-29 turns.jsonl shape (seat, ts, trig, outcome, usd, state_change).
// Reads only; writes nothing. Needs `npm run build` (in a worktree).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DIST = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../dist/agents/seats/seat-watch-join.js',
)

function parseArgs(argv) {
  const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state')
  const args = { dir: path.join(state, 'agent-chat', 'seat-watch'), triggers: [], json: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--turns') args.turns = argv[++i]
    else if (argv[i] === '--dir') args.dir = argv[++i]
    else if (argv[i] === '--trigger') args.triggers.push(argv[++i])
    else if (argv[i] === '--json') args.json = true
    else throw new Error(`unknown argument ${argv[i]}`)
  }
  if (args.turns === undefined) throw new Error('need --turns <turns.jsonl>')
  return args
}

function jsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .flatMap(line => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
}

const shadowRows = dir =>
  fs
    .readdirSync(dir)
    .filter(name => name.endsWith('.jsonl'))
    .flatMap(name => jsonl(path.join(dir, name)))

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const { joinShadow, renderJoin } = await import(pathToFileURL(DIST).href)
  const opts = args.triggers.length === 0 ? {} : { triggers: args.triggers }
  const report = joinShadow(shadowRows(args.dir), jsonl(args.turns), opts)
  console.log(args.json ? JSON.stringify(report, null, 2) : renderJoin(report).join('\n'))
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
