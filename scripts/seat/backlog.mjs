#!/usr/bin/env node
// CC-765: seat plan questions as one YAML record each in <autonomy>/backlog/<seat>/<id>.yml, outside
// the queue cap (CC-760 plan section 2). Verbs: add, lint, list, due, resolve, close.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DUE_AFTER_MS = 12 * 60 * 60 * 1000
const ID = /^[a-z]{1,3}-\d+(\.\d+)?$/
const TASK = /^[A-Z][A-Z0-9]*-\d+$/
const STATUSES = ['open', 'deferred', 'decided', 'escalated', 'answered', 'closed']
const DOORS = ['two-way', 'one-way']
const USAGE = `usage: backlog add <seat> <file>
       backlog lint <file...>
       backlog list [<seat>] [--status <status>]
       backlog due
       backlog resolve <id> --by decider --answer <key> --cite <cite> --confidence <0..1>
       backlog resolve <id> --escalate --answer <key> --rationale <text>
       backlog close <id>
Root: AUTONOMY_ROOT, else $ACTIVE_ROOT/claude-channels/sources/autonomy. Clock: BACKLOG_NOW, else now.
due reopens deferred records past deferred_until, then prints open two-way records 12 h old.`

class UsageError extends Error {}
class Failure extends Error {}

function root() {
  if (process.env.AUTONOMY_ROOT) return process.env.AUTONOMY_ROOT
  if (process.env.ACTIVE_ROOT) return path.join(process.env.ACTIVE_ROOT, 'claude-channels/sources/autonomy')
  throw new UsageError('AUTONOMY_ROOT and ACTIVE_ROOT unset: export one')
}

function now() {
  const at = process.env.BACKLOG_NOW ? new Date(process.env.BACKLOG_NOW) : new Date()
  if (Number.isNaN(at.getTime()))
    throw new UsageError(`BACKLOG_NOW is not a time: ${process.env.BACKLOG_NOW}`)
  return at
}

function text(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function isTime(value) {
  return text(value) && !Number.isNaN(new Date(value).getTime())
}

function lintOption(option, i) {
  if (!option || typeof option !== 'object') return [`options[${i}] is not a {key, proposed} map`]
  const errors = []
  if (!text(option.key)) errors.push(`options[${i}].key is missing`)
  const proposed = typeof option.proposed === 'string' ? option.proposed.trim() : ''
  if (proposed.split(/\s+/).filter(Boolean).length < 4 || proposed.endsWith(':')) {
    errors.push(`options[${i}].proposed is a bare heading, not the proposal text`)
  }
  return errors
}

function lintOptions(options) {
  if (!Array.isArray(options) || options.length < 2) return ['options needs at least two entries']
  const errors = options.flatMap(lintOption)
  const keys = options.map(option => option?.key)
  if (new Set(keys).size !== keys.length) errors.push('options keys repeat')
  return errors
}

function lintRequired(record) {
  const errors = []
  if (!ID.test(String(record.id ?? ''))) errors.push(`id '${record.id}' is not like tc-131 or tc-130.2`)
  for (const field of ['seat', 'initiative', 'decision', 'now', 'trade_off']) {
    if (!text(record[field])) errors.push(`${field} is missing`)
  }
  if (!TASK.test(String(record.task ?? ''))) errors.push(`task '${record.task}' is not a task id like CC-760`)
  if (!DOORS.includes(record.door)) errors.push(`door must be two-way or one-way`)
  if (record.door === 'one-way' && !text(record.why_owner)) errors.push('a one-way door needs why_owner')
  return errors
}

function lintRecommended(record) {
  const recommended = record.recommended
  if (!recommended || typeof recommended !== 'object') return ['recommended {option, reason} is missing']
  const errors = []
  const keys = Array.isArray(record.options) ? record.options.map(option => option?.key) : []
  if (!keys.includes(recommended.option))
    errors.push(`recommended.option '${recommended.option}' is not an option key`)
  if (!text(recommended.reason)) errors.push('recommended.reason is missing')
  return errors
}

// A capture path is copied on both sides of add, so it may hold no '..', '.', empty or absolute segment.
function captureFileOk(id, file) {
  if (typeof file !== 'string' || /[\\\0]/.test(file)) return false
  const segments = file.split('/')
  if (segments.some(segment => ['', '.', '..'].includes(segment))) return false
  return segments.length > 2 && segments[0] === id && segments[1] === 'img'
}

function lintVisual(record) {
  if (record.visual == null) return []
  const captures = record.visual.captures
  if (!Array.isArray(captures) || captures.length === 0) return ['visual is set with no captures']
  return captures.flatMap((capture, i) => {
    if (!text(capture?.key) || !text(capture?.label)) return [`visual.captures[${i}] needs key and label`]
    if (!captureFileOk(record.id, capture.file)) {
      return [`visual.captures[${i}].file must be a plain relative path under ${record.id}/img/`]
    }
    return []
  })
}

function lintState(record) {
  const errors = []
  if (record.pr != null && !['url', 'summary', 'gate_reason'].every(field => text(record.pr[field]))) {
    errors.push('pr needs url, summary and gate_reason')
  }
  if (record.status != null && !STATUSES.includes(record.status))
    errors.push(`status '${record.status}' is unknown`)
  if (record.opened_at != null && !isTime(record.opened_at)) errors.push('opened_at is not an ISO time')
  if (record.status === 'deferred' && !isTime(record.deferred_until))
    errors.push('deferred needs deferred_until')
  for (const field of ['links', 'blocks']) {
    if (record[field] != null && !Array.isArray(record[field])) errors.push(`${field} must be a list`)
  }
  return errors
}

function lintRecord(record) {
  if (!record || typeof record !== 'object') return ['not a YAML map']
  return [
    ...lintRequired(record),
    ...lintOptions(record.options),
    ...lintRecommended(record),
    ...lintVisual(record),
    ...lintState(record),
  ]
}

function readRecord(file) {
  try {
    return YAML.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Failure(`${file}: ${err.message}`)
  }
}

function writeRecord(file, record) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, YAML.stringify(record))
  fs.renameSync(tmp, file)
}

function assertValid(file, record) {
  const errors = lintRecord(record)
  if (errors.length > 0) throw new Failure(errors.map(error => `${file}: ${error}`).join('\n'))
}

function seatDirs() {
  const dir = path.join(root(), 'backlog')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(dir, entry.name))
}

function storedFiles(seat) {
  const dirs = seat ? [path.join(root(), 'backlog', seat)] : seatDirs()
  return dirs
    .filter(dir => fs.existsSync(dir))
    .flatMap(dir =>
      fs
        .readdirSync(dir)
        .filter(name => name.endsWith('.yml'))
        .map(name => path.join(dir, name)),
    )
    .sort()
}

function findRecord(id) {
  if (!ID.test(id)) throw new UsageError(`'${id}' is not a backlog id like tc-131`)
  const matches = storedFiles().filter(file => path.basename(file) === `${id}.yml`)
  if (matches.length === 0) throw new Failure(`no open record ${id} under ${path.join(root(), 'backlog')}`)
  if (matches.length > 1) throw new Failure(`${id} is in more than one seat: ${matches.join(', ')}`)
  return { file: matches[0], record: readRecord(matches[0]) }
}

// Lint already holds the path to <id>/img/; this also refuses a symlink anywhere on either side.
function confined(base, id, file) {
  const target = path.join(base, file)
  const imgDir = path.join(fs.realpathSync(base), id, 'img')
  const parent = fs.realpathSync(path.dirname(target))
  if (parent !== imgDir && !parent.startsWith(imgDir + path.sep)) {
    throw new Failure(`capture ${file} resolves outside ${id}/img/ through a symlink`)
  }
  const stat = fs.lstatSync(target, { throwIfNoEntry: false })
  if (stat?.isSymbolicLink()) throw new Failure(`capture ${file} is a symlink`)
  return { target, stat }
}

function copyCaptures(record, fromDir, toDir) {
  for (const capture of record.visual?.captures ?? []) {
    if (!captureFileOk(record.id, capture.file))
      throw new Failure(`capture ${capture.file} is outside ${record.id}/img/`)
    if (!fs.existsSync(path.join(fromDir, capture.file))) {
      throw new Failure(`capture ${capture.file} not found beside the record`)
    }
    const source = confined(fromDir, record.id, capture.file)
    if (!source.stat.isFile()) throw new Failure(`capture ${capture.file} is not a file`)
    for (const dir of [record.id, `${record.id}/img`]) {
      if (fs.lstatSync(path.join(toDir, dir), { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new Failure(`${dir} in the store is a symlink`)
      }
    }
    fs.mkdirSync(path.dirname(path.join(toDir, capture.file)), { recursive: true })
    const dest = confined(toDir, record.id, capture.file)
    fs.copyFileSync(source.target, dest.target)
  }
}

function add(args) {
  if (args.length !== 2) throw new UsageError(USAGE)
  const [seat, source] = args
  if (!/^[A-Za-z0-9._-]+$/.test(seat)) throw new UsageError(`bad seat name '${seat}'`)
  const record = { ...readRecord(source), status: 'open' }
  record.opened_at ??= now().toISOString()
  if (record.seat !== seat) throw new Failure(`${source}: seat '${record.seat}' is not '${seat}'`)
  assertValid(source, record)
  const dir = path.join(root(), 'backlog', seat)
  const target = path.join(dir, `${record.id}.yml`)
  if (fs.existsSync(target)) throw new Failure(`${target} exists`)
  fs.mkdirSync(dir, { recursive: true })
  copyCaptures(record, path.dirname(source), dir)
  writeRecord(target, record)
  console.log(target)
}

function lint(args) {
  if (args.length === 0) throw new UsageError(USAGE)
  let failed = 0
  for (const file of args) {
    const errors = lintRecord(readRecord(file))
    for (const error of errors) console.error(`${file}: ${error}`)
    if (errors.length === 0) console.log(`ok ${file}`)
    else failed++
  }
  if (failed > 0) throw new Failure(`${failed} of ${args.length} records fail lint`)
}

function list(args) {
  const at = args.indexOf('--status')
  const status = at >= 0 ? args[at + 1] : undefined
  const seats = at >= 0 ? [...args.slice(0, at), ...args.slice(at + 2)] : args
  if (seats.length > 1 || (at >= 0 && !STATUSES.includes(status))) throw new UsageError(USAGE)
  for (const file of storedFiles(seats[0])) {
    const record = readRecord(file)
    if (status && record.status !== status) continue
    console.log(
      [record.id, record.seat, record.status, record.door, record.opened_at, record.decision].join('\t'),
    )
  }
}

function reopenExpired(file, record, at) {
  if (record.status !== 'deferred' || new Date(record.deferred_until) > at) return record
  const reopened = { ...record, status: 'open', opened_at: at.toISOString() }
  delete reopened.deferred_until
  writeRecord(file, reopened)
  console.error(`reopened ${record.id}: defer ended ${record.deferred_until}`)
  return reopened
}

function due(args) {
  if (args.length !== 0) throw new UsageError(USAGE)
  const at = now()
  for (const file of storedFiles()) {
    const record = reopenExpired(file, readRecord(file), at)
    const age = at.getTime() - new Date(record.opened_at).getTime()
    if (record.status === 'open' && record.door === 'two-way' && age >= DUE_AFTER_MS) console.log(file)
  }
}

function flags(args, names) {
  const out = {}
  for (let i = 0; i < args.length; i++) {
    const name = args[i].replace(/^--/, '')
    if (!names.includes(name)) throw new UsageError(`unknown argument ${args[i]}\n${USAGE}`)
    out[name] = name === 'escalate' ? true : args[++i]
    if (out[name] === undefined) throw new UsageError(`${args[i - 1]} needs a value`)
  }
  return out
}

function resolution(record, opts, at) {
  const keys = record.options.map(option => option.key)
  if (!keys.includes(opts.answer))
    throw new Failure(`--answer '${opts.answer}' is not one of ${keys.join(', ')}`)
  if (opts.escalate) {
    if (!text(opts.rationale)) throw new UsageError('--escalate needs --rationale')
    return { by: 'decider', answer: opts.answer, comment: opts.rationale, at }
  }
  if (opts.by !== 'decider') throw new UsageError('resolve needs --by decider or --escalate')
  if (!text(opts.cite))
    throw new Failure('resolve --by decider needs --cite; with no precedent, use --escalate')
  const confidence = Number(opts.confidence)
  if (!(confidence >= 0 && confidence <= 1)) throw new UsageError('--confidence must be a number from 0 to 1')
  return { by: 'decider', answer: opts.answer, cite: opts.cite, confidence, at }
}

function resolve(args) {
  if (args.length < 1) throw new UsageError(USAGE)
  const { file, record } = findRecord(args[0])
  const opts = flags(args.slice(1), ['by', 'answer', 'cite', 'confidence', 'escalate', 'rationale'])
  if (record.status !== 'open') throw new Failure(`${record.id} is ${record.status}, not open`)
  const entry = resolution(record, opts, now().toISOString())
  writeRecord(file, { ...record, status: opts.escalate ? 'escalated' : 'decided', resolution: entry })
  const note = opts.escalate
    ? `[${record.id}] decider escalated, leaning ${entry.answer}: ${entry.comment}`
    : `[${record.id}] decider: ${entry.answer} (cite ${entry.cite}, confidence ${entry.confidence})`
  run(process.env.BACKLOG_TASK_NOTE || path.join(HERE, 'task-note'), [record.initiative, record.task, note])
  console.log(`${record.id} ${opts.escalate ? 'escalated' : 'decided'}`)
}

function close(args) {
  if (args.length !== 1) throw new UsageError(USAGE)
  const { file, record } = findRecord(args[0])
  const closedDir = path.join(path.dirname(file), 'closed')
  fs.mkdirSync(closedDir, { recursive: true })
  const target = path.join(closedDir, path.basename(file))
  writeRecord(target, { ...record, status: 'closed' })
  fs.rmSync(file)
  run(process.env.BACKLOG_QUEUE || path.join(HERE, 'queue'), [record.seat, 'done', record.id])
  console.log(target)
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) throw new Failure(`${command}: ${result.error.message}`)
  if (result.status !== 0)
    throw new Failure(`${path.basename(command)} exited ${result.status}; the record is written`)
}

const VERBS = { add, lint, list, due, resolve, close }

function main(argv) {
  const verb = VERBS[argv[0]]
  if (!verb) throw new UsageError(USAGE)
  verb(argv.slice(1))
}

try {
  main(process.argv.slice(2))
} catch (err) {
  if (!(err instanceof UsageError || err instanceof Failure)) throw err
  console.error(`backlog: ${err.message}`)
  process.exit(err instanceof UsageError ? 2 : 1)
}
