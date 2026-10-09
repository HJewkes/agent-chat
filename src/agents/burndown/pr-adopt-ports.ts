import os from 'node:os'
import { appendSeatLog, readSeatJournal } from '../seats/io.js'
import { expandHome } from './seat-dispatch.js'
import type { LoadedSeat } from './seat-tick.js'
import type { Runner } from './exec.js'
import type { AdoptPorts, AdoptSeat, OpenPull } from './pr-adopt.js'
import { holdWithShepherd, registerWithShepherd, shepherdRows } from './shepherd.js'
import { parseTask, readTaskText } from './source.js'

/** CC-861: the tick's real ports for `adoptSeatPrs`: gh reads over REST, Shepherd through its CLI, the seat's daily log. */

const GITHUB_REMOTE = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/

const PULL_JQ = '.[] | {number, title, branch: .head.ref, updatedAt: .updated_at}'

interface Deps {
  exec: Runner
  root: string
  autonomyRoot: string
  now: Date
  log: AdoptPorts['log']
}

export function diskAdoptPorts({ exec, root, autonomyRoot, now, log }: Deps): AdoptPorts {
  return {
    repoOf: checkout => originRepo(checkout, exec),
    pulls: repo => openPulls(repo, exec),
    diffSize: target => {
      const result = exec('gh', [
        'api',
        `repos/${target.repo}/pulls/${target.pr}`,
        '--jq',
        '[.additions, .deletions]',
      ])
      const parsed = result.status === 0 ? parseJson(result.stdout) : undefined
      const [additions, deletions] = Array.isArray(parsed) ? parsed : []
      return typeof additions === 'number' && typeof deletions === 'number'
        ? { additions, deletions }
        : undefined
    },
    task: (initiatives, id) => findTask(root, initiatives, id),
    shepherdRows: () => shepherdRows(exec, log),
    register: reg => registerWithShepherd(reg, exec),
    hold: (target, reason) => holdWithShepherd(target, reason, exec),
    logged: (seat, key) => readSeatJournal(autonomyRoot, seat, now)?.includes(key) ?? false,
    append: (seat, text) => void appendSeatLog(autonomyRoot, seat, now, text),
    log,
  }
}

/** The seat's git checkouts, each with the initiatives it serves, and its stale threshold. */
export function adoptSeatOf(loaded: LoadedSeat, home = os.homedir()): AdoptSeat {
  const { charter, seat } = loaded.policy
  const staleDays = seat.stale_pr_days ?? charter.defaults.stale_pr_days
  return {
    seat: loaded.dispatch.seat,
    prefix: loaded.dispatch.prefix,
    repos: seat.repos
      .filter(r => r.git !== false)
      .map(r => ({ checkout: expandHome(r.path, home), initiatives: r.initiatives })),
    ...(staleDays === undefined ? {} : { staleDays }),
  }
}

export function originRepo(checkout: string, exec: Runner): string | undefined {
  const result = exec('git', ['-C', checkout, 'remote', 'get-url', 'origin'])
  return result.status === 0 ? GITHUB_REMOTE.exec(result.stdout.trim())?.[1] : undefined
}

// REST, never GraphQL: the owner's account hits GraphQL rate limits.
export function openPulls(repo: string, exec: Runner): OpenPull[] | undefined {
  const result = exec('gh', [
    'api',
    '--paginate',
    `repos/${repo}/pulls?state=open&per_page=100`,
    '--jq',
    PULL_JQ,
  ])
  if (result.status !== 0) return undefined
  return result.stdout
    .split('\n')
    .filter(line => line.trim() !== '')
    .flatMap(line => {
      const p = parseJson(line) as Partial<OpenPull> | undefined
      return typeof p?.number === 'number' && typeof p.branch === 'string'
        ? [{ number: p.number, title: p.title ?? '', branch: p.branch, updatedAt: p.updatedAt ?? '' }]
        : []
    })
}

function findTask(root: string, initiatives: readonly string[], id: string): ReturnType<AdoptPorts['task']> {
  for (const initiative of initiatives) {
    const text = readTaskText(root, initiative, id)
    if (text !== undefined) return { initiative, task: parseTask(text, id) }
  }
  return undefined
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
