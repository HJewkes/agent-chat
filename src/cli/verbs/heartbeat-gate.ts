import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { gateStep, type Fingerprint, type GateState } from '../../agents/seats/wake-gate.js'
import { resolveHeartbeatGate } from '../../config.js'
import { run, type Runner } from '../../exec.js'
import { home } from '../../paths.js'
import { defineVerb, Report } from '../command.js'

export interface GateWatch {
  git: string[]
  paths: string[]
}

/** `repo[:ref]`; the ref is after the last colon, and defaults to HEAD. */
export function parseGitSpec(spec: string): { repo: string; ref: string } {
  const colon = spec.lastIndexOf(':')
  if (colon <= 0) return { repo: spec, ref: 'HEAD' }
  return { repo: spec.slice(0, colon), ref: spec.slice(colon + 1) || 'HEAD' }
}

function readGit(runner: Runner, spec: string): [string, string] {
  const { repo, ref } = parseGitSpec(spec)
  const result = runner('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  const sha = result.stdout.trim()
  return [`${repo}@${ref}`, result.status === 0 && sha !== '' ? sha : 'unresolved']
}

const statValue = (stat: fs.Stats): string => `${Math.trunc(stat.mtimeMs)}:${stat.size}`

/** A file is `mtime:size`; a directory is `dir` plus one such key per entry, so a new report names itself. */
function readPath(target: string): Fingerprint {
  const stat = fs.statSync(target, { throwIfNoEntry: false })
  if (stat === undefined) return { [target]: 'absent' }
  if (!stat.isDirectory()) return { [target]: statValue(stat) }
  const entries = fs.readdirSync(target).map(name => {
    const entry = fs.statSync(path.join(target, name), { throwIfNoEntry: false })
    return [path.join(target, name), entry === undefined ? 'absent' : statValue(entry)]
  })
  return { [target]: 'dir', ...Object.fromEntries(entries) }
}

export function readFingerprint(watch: GateWatch, runner: Runner = run): Fingerprint {
  return Object.assign(
    Object.fromEntries(watch.git.map(spec => readGit(runner, spec))),
    ...watch.paths.map(readPath),
  ) as Fingerprint
}

const StateFile = z.object({ fp: z.record(z.string(), z.string()), lastEmitAtMs: z.number() })

/** A missing or unreadable state file reads as no state, so the next step seeds. */
export function loadState(file: string): GateState | undefined {
  try {
    const parsed = StateFile.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

function saveState(file: string, state: GateState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(state)}\n`)
}

/** One state file per watch set, so two `--once` callers watching different things never share one. */
export function defaultStatePath(watch: GateWatch): string {
  const key = JSON.stringify([[...watch.git].sort(), [...watch.paths].sort()])
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 16)
  return path.join(home(), 'heartbeat-gate', `${digest}.json`)
}

export interface GateLoopPorts {
  read(): Fingerprint
  now(): number
  sleep(ms: number): Promise<void>
  print(line: string): void
  save?: ((state: GateState) => void) | undefined
}

/** Polls until the process ends; prints only what `gateStep` emits. */
export async function gateLoop(
  ports: GateLoopPorts,
  opts: { everyMs: number; maxQuietMs: number; initial?: GateState | undefined },
): Promise<never> {
  let state = opts.initial
  for (;;) {
    const step = gateStep({ prev: state, fp: ports.read(), nowMs: ports.now(), maxQuietMs: opts.maxQuietMs })
    if (step.emit !== undefined) ports.print(step.emit)
    state = step.state
    ports.save?.(state)
    await ports.sleep(opts.everyMs)
  }
}

const minutes = z.coerce.number().positive().optional()

export const heartbeatGateVerb = defineVerb({
  name: 'heartbeat.gate',
  description:
    'a model-free heartbeat for a Monitor: poll git refs and paths every --every minutes and print one ' +
    'line only when one changed, or a quiet line after --max-quiet minutes of no change. The first poll ' +
    'prints nothing. Defaults come from heartbeatGate in config.json',
  args: z.object({
    git: z.array(z.string()).optional(),
    path: z.array(z.string()).optional(),
    every: minutes,
    maxQuiet: minutes,
    once: z.boolean().optional(),
    state: z.string().optional(),
  }),
  result: Report,
  cli: {
    options: {
      git: { long: '--git <repo[:ref]>', description: 'a git ref to watch, HEAD by default (repeatable)' },
      path: { long: '--path <path>', description: 'a file or directory to watch (repeatable)' },
      every: { long: '--every <minutes>', description: 'poll interval' },
      maxQuiet: { long: '--max-quiet <minutes>', description: 'print a quiet line after this long silent' },
      once: { long: '--once', description: 'one poll against the state file, then exit' },
      state: {
        long: '--state <file>',
        description: 'where the last fingerprint is kept (default with --once: under $AGENT_CHAT_HOME)',
      },
    },
  },
  async run(args) {
    const watch: GateWatch = { git: args.git ?? [], paths: args.path ?? [] }
    if (watch.git.length + watch.paths.length === 0)
      return { ok: false, lines: [], errors: ['heartbeat gate needs at least one --git or --path'] }
    const config = resolveHeartbeatGate()
    const maxQuietMs = (args.maxQuiet ?? config.maxQuietMinutes) * 60_000
    const stateFile = args.state ?? (args.once === true ? defaultStatePath(watch) : undefined)
    const initial = stateFile === undefined ? undefined : loadState(stateFile)
    const save = stateFile === undefined ? undefined : (state: GateState) => saveState(stateFile, state)
    if (args.once === true) {
      const step = gateStep({ prev: initial, fp: readFingerprint(watch), nowMs: Date.now(), maxQuietMs })
      save?.(step.state)
      return { ok: true, lines: step.emit === undefined ? [] : [step.emit] }
    }
    return gateLoop(
      {
        read: () => readFingerprint(watch),
        now: Date.now,
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
        print: line => console.log(line),
        save,
      },
      { everyMs: (args.every ?? config.everyMinutes) * 60_000, maxQuietMs, initial },
    )
  },
})
