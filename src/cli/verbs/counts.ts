import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { readLedger } from '../../agents/burndown/ledger.js'
import { defaultAutonomyRoot, loadPolicy, parseCharter } from '../../agents/burndown/policy.js'
import { expandHome } from '../../agents/burndown/seat-dispatch.js'
import { TICK_INTERVAL_SECONDS } from '../../agents/burndown/tick-status.js'
import { deriveCounts } from '../../agents/counts/derive.js'
import {
  parseParkKept,
  parsePrSnapshot,
  parseProcesses,
  parseShepherdStatus,
  prKeys,
  readLive,
  type LiveReaders,
} from '../../agents/counts/read-live.js'
import { countsExit, renderCounts } from '../../agents/counts/render.js'
import type { LiveSnapshot, PrRow } from '../../agents/counts/types.js'
import { parseWorktreeList } from '../../agents/seats/trees.js'
import { readTail } from '../../agents/transcript-usage.js'
import type { BrokerClient } from '../../client/broker-client.js'
import { childEnv } from '../../exec.js'
import { gitChildEnv } from '../../git.js'
import { burndownLedgerPath, burndownTicksPath, logPath } from '../../paths.js'
import type { ServerMessage } from '../../protocol.js'
import { SHEPHERD_BIN, SHEPHERD_STATUS_ARGS } from '../../shepherd-client.js'
import { defineVerb, Report, type VerbContext } from '../command.js'
import { tickRoster } from '../port-reads.js'

/**
 * CC-1282 (K2): `agent-chat counts`, every count derived once from live state by K1, beside what each surface
 * shows. Read-only: queries the broker, ps, git, Shepherd and (only when Shepherd's PR snapshot is stale) gh.
 */

export interface CountsArgs {
  check?: boolean
  json?: boolean
  seat?: string
}

export async function countsReport(readers: LiveReaders, args: CountsArgs): Promise<Report> {
  const snapshot = await readLive(readers)
  const counts = deriveCounts(snapshot).filter(
    c => args.seat === undefined || c.seat === undefined || c.seat === args.seat,
  )
  const exit = countsExit(counts)
  const lines = args.json === true ? [JSON.stringify({ exit, counts })] : renderCounts(counts, snapshot.now)
  return args.check === true && exit !== 0 ? { ok: false, lines, exit } : { ok: true, lines }
}

type Reply<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>
type Broker = VerbContext['withBroker']

const execFileAsync = promisify(execFile)
const BIG_OUTPUT = 64 * 1024 * 1024
const TICK_TAIL_BYTES = 256 * 1024
const LOG_TAIL_BYTES = 8 * 1024 * 1024

const quiet = <T>(broker: Broker, fn: (client: BrokerClient) => Promise<T>): Promise<T> =>
  broker(fn, { autoStart: false })

export function systemReaders(broker: Broker, root: string): LiveReaders {
  return {
    now: () => new Date(),
    tickMs: TICK_INTERVAL_SECONDS * 1000,
    sweepMs: TICK_INTERVAL_SECONDS * 1000,
    roster: () => quiet(broker, readRoster),
    list: () => quiet(broker, readList),
    processes: async () =>
      parseProcesses(
        (await execFileAsync('ps', ['-ww', '-eo', 'pid,args'], { maxBuffer: BIG_OUTPUT })).stdout,
      ),
    seatRepos: async () => seatRepos(root),
    worktrees: async repo => parseWorktreeList(await gitWorktrees(repo)),
    shepherdPrs: async () => parsePrSnapshot(await shepherd(['shepherd', 'prs', '--json'])),
    ghPrs: ghOpenPrs,
    shepherd: async () => parseShepherdStatus(await shepherd(SHEPHERD_STATUS_ARGS)),
    ledger: async () => readLedger(burndownLedgerPath()),
    lastTick: async () => lastTickRow(),
    parkKept: async () =>
      fs.existsSync(logPath()) ? parseParkKept(readTail(logPath(), LOG_TAIL_BYTES)) : [],
  }
}

async function readRoster(client: BrokerClient): ReturnType<LiveReaders['roster']> {
  const roster = await tickRoster(client)
  const rows = roster.agents.map(a => ({
    agentId: a.agentId,
    name: a.name,
    profile: a.profile,
    state: a.state,
    cwd: a.cwd,
  }))
  return {
    roster: roster.partial === undefined ? { rows } : { rows, partial: roster.partial },
    ...(roster.slots === undefined ? {} : { semaphore: roster.slots }),
  }
}

async function readList(client: BrokerClient): ReturnType<LiveReaders['list']> {
  const list = (await client.request({ t: 'list' }, 'list_result')) as Reply<'list_result'>
  const fileClaims = (list.claims ?? [])
    .filter(c => c.kind === 'files')
    .map(c => ({ owner: c.owner, repo: c.repoPath ?? c.worktreePath ?? '', patterns: c.patterns ?? [] }))
  return { sessions: list.sessions.map(s => s.name), fileClaims }
}

function seatRepos(root: string): string[] {
  const charter = parseCharter(fs.readFileSync(path.join(root, 'charter.md'), 'utf8'))
  const [first] = charter.seats
  if (first === undefined) return []
  const seats = Object.values(loadPolicy(root, first).seats)
  const repos = seats.flatMap(s =>
    s.repos.filter(r => r.git !== false).map(r => expandHome(r.path, os.homedir())),
  )
  return [...new Set(repos)]
}

async function gitWorktrees(repo: string): Promise<string> {
  const args = ['-C', repo, 'worktree', 'list', '--porcelain']
  return (await execFileAsync('git', args, { timeout: 5000, encoding: 'utf8', env: gitChildEnv() })).stdout
}

async function shepherd(args: string[]): Promise<string> {
  const options = {
    cwd: os.homedir(),
    env: childEnv(),
    encoding: 'utf8' as const,
    timeout: 15_000,
    maxBuffer: BIG_OUTPUT,
  }
  return (await execFileAsync(SHEPHERD_BIN, args, options)).stdout
}

// REST, never GraphQL (see collision.ts); `{owner}/{repo}` resolves from `cwd`. One call per repo per run (R10).
const GH_OPEN_PRS = [
  'api',
  '--paginate',
  'repos/{owner}/{repo}/pulls?state=open&per_page=100',
  '--jq',
  '.[] | {number, repo: .base.repo.full_name}',
]

async function ghOpenPrs(repo: string): Promise<PrRow[]> {
  const options = {
    cwd: repo,
    env: childEnv(),
    encoding: 'utf8' as const,
    timeout: 30_000,
    maxBuffer: BIG_OUTPUT,
  }
  const { stdout } = await execFileAsync('gh', GH_OPEN_PRS, options)
  return stdout
    .split('\n')
    .filter(line => line.trim() !== '')
    .flatMap(line => {
      const pr = JSON.parse(line) as { number: number; repo: string }
      return prKeys(pr.repo, pr.number).map(key => ({ pr: key, state: 'open' as const }))
    })
}

function lastTickRow(): LiveSnapshot['lastTick'] {
  if (!fs.existsSync(burndownTicksPath())) return undefined
  const last = readTail(burndownTicksPath(), TICK_TAIL_BYTES).trimEnd().split('\n').at(-1)
  if (last === undefined || last === '') return undefined
  const row = JSON.parse(last) as { seats?: unknown }
  if (typeof row.seats !== 'object' || row.seats === null) throw new Error('last tick row has no seats')
  return { seats: row.seats as NonNullable<LiveSnapshot['lastTick']>['seats'] }
}

export const countsVerb = defineVerb({
  name: 'counts',
  description:
    'every count derived from live state, beside what each surface shows, with a verdict per difference',
  args: z.object({
    check: z.boolean().optional(),
    json: z.boolean().optional(),
    seat: z.string().optional(),
    root: z.string().optional(),
  }),
  result: Report,
  cli: {
    options: {
      check: {
        long: '--check',
        description: 'exit 1 on an unexplained difference, 2 when a live reader failed',
      },
      json: { long: '--json', description: 'one JSON object: the exit status and K1 counts' },
      seat: { long: '--seat', description: "only this seat's counts, plus the machine-wide ones" },
      root: { long: '--root', description: 'autonomy directory holding charter.md and seats/' },
    },
  },
  async run({ check, json, seat, root }, ctx) {
    const readers = systemReaders(ctx.withBroker, root ?? defaultAutonomyRoot())
    return countsReport(readers, {
      ...(check === undefined ? {} : { check }),
      ...(json === undefined ? {} : { json }),
      ...(seat === undefined ? {} : { seat }),
    })
  },
})
