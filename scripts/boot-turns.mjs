#!/usr/bin/env node
// CC-318: boot turns in the first 10 turns of each seat generation that started on a day (UTC).
// Usage: node scripts/boot-turns.mjs --day 2026-10-09 [--day ...] [--root ~/.claude-profiles] [--json]
// Reads transcripts at <root>/*/projects/*/*.jsonl; writes nothing. Needs `npm run build` (in a worktree).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist/agents/seats/boot-turns.js')
const HEAD_BYTES = 64 * 1024

function parseArgs(argv) {
  const args = { days: [], root: path.join(os.homedir(), '.claude-profiles'), json: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--day') args.days.push(argv[++i])
    else if (argv[i] === '--root') args.root = argv[++i]
    else if (argv[i] === '--json') args.json = true
    else throw new Error(`unknown argument ${argv[i]}`)
  }
  if (args.days.length === 0 || args.days.some(day => !/^\d{4}-\d{2}-\d{2}$/.test(day ?? ''))) {
    throw new Error('need at least one --day YYYY-MM-DD')
  }
  return args
}

function transcripts(root) {
  const out = []
  for (const profile of readdir(root)) {
    const projects = path.join(root, profile, 'projects')
    for (const project of readdir(projects)) {
      const dir = path.join(projects, project)
      for (const name of readdir(dir)) if (name.endsWith('.jsonl')) out.push(path.join(dir, name))
    }
  }
  return out
}

function readdir(dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/** The first record timestamp, from the file's head when it is there, else from the whole file. */
function firstTimestamp(file) {
  const fd = fs.openSync(file, 'r')
  const head = Buffer.alloc(HEAD_BYTES)
  const read = fs.readSync(fd, head, 0, HEAD_BYTES, 0)
  fs.closeSync(fd)
  const found = /"timestamp":"([^"]+)"/.exec(head.subarray(0, read).toString('utf8'))
  if (found !== null || read < HEAD_BYTES) return found?.[1]
  return /"timestamp":"([^"]+)"/.exec(fs.readFileSync(file, 'utf8'))?.[1]
}

/** A file last written before the day cannot have started on it, so most files are never opened. */
function generationsOn(files, day, bootTurns) {
  const dayStart = Date.parse(`${day}T00:00:00Z`)
  const gens = []
  for (const file of files) {
    if (fs.statSync(file).mtimeMs < dayStart || !firstTimestamp(file)?.startsWith(day)) continue
    const gen = bootTurns(fs.readFileSync(file, 'utf8').split('\n'))
    if (gen.seat !== undefined) gens.push({ ...gen, session: path.basename(file, '.jsonl') })
  }
  return gens
}

const cell = value => (value === null ? '-' : String(value))

function printDay(day, summary) {
  console.log(`== ${day}`)
  console.log('seat\tgenerations\tshort\tmean_boot_turns\tmean_usd\tseats_boot_share\tunmentioned')
  const rows = [...Object.entries(summary.seats), ['TOTAL', summary.total]]
  for (const [seat, row] of rows) {
    const fields = [row.generations, row.short, row.meanBootTurns, row.meanUsd, row.seatsBootShare]
    console.log([seat, ...fields.map(cell), row.unmentioned.join(',') || '-'].join('\t'))
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!fs.existsSync(DIST)) {
    console.error(`boot-turns: ${DIST} is missing; run npm run build in a worktree first`)
    process.exit(2)
  }
  const { bootTurns, summarise } = await import(pathToFileURL(DIST).href)
  const files = transcripts(args.root)
  const days = args.days.map(day => {
    const generations = generationsOn(files, day, bootTurns)
    return { day, summary: summarise(generations), generations }
  })
  if (args.json) console.log(JSON.stringify(days, null, 2))
  else for (const { day, summary } of days) printDay(day, summary)
}

main().catch(error => {
  console.error(`boot-turns: ${error.message}`)
  process.exit(1)
})
