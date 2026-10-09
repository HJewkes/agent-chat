import os from 'node:os'
import { appendSeatLog, readSeatJournal } from '../seats/io.js'
import { expandHome } from './seat-dispatch.js'
import type { LoadedSeat } from './seat-tick.js'
import type { Runner } from './exec.js'
import type { AdoptPorts, AdoptSeat, ChangedFile, OpenPull } from './pr-adopt.js'
import { holdWithShepherd, shepherdListed, shepherdRegister, type ShepherdTarget } from './shepherd.js'
import { parseTask, readTaskText } from './source.js'

/** CC-861: the tick's real ports for `adoptSeatPrs`: gh reads over REST, Shepherd through its CLI, the seat's daily log. */

const GITHUB_REMOTE = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/

const PULL_JQ =
  '.[] | {number, title, branch: .head.ref, headRepo: (.head.repo.full_name // ""), updatedAt: .updated_at}'

const FILES_JQ = '.[] | {path: .filename, additions, deletions}'

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
    files: target => changedFiles(target, exec),
    task: (initiatives, id) => findTask(root, initiatives, id),
    listed: () => shepherdListed(exec),
    register: reg => shepherdRegister(reg, exec),
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
  return jsonLines(result.stdout).flatMap(line => {
    const p = line as Partial<OpenPull> | undefined
    return typeof p?.number === 'number' && typeof p.branch === 'string'
      ? [
          {
            number: p.number,
            title: p.title ?? '',
            branch: p.branch,
            headRepo: p.headRepo ?? '',
            updatedAt: p.updatedAt ?? '',
          },
        ]
      : []
  })
}

/** Every changed file, or undefined when any line is unreadable: a partial list could hide a sensitive path. */
export function changedFiles(target: ShepherdTarget, exec: Runner): ChangedFile[] | undefined {
  const result = exec('gh', [
    'api',
    '--paginate',
    `repos/${target.repo}/pulls/${target.pr}/files?per_page=100`,
    '--jq',
    FILES_JQ,
  ])
  if (result.status !== 0) return undefined
  const files: ChangedFile[] = []
  for (const line of jsonLines(result.stdout)) {
    const f = line as Partial<ChangedFile> | undefined
    if (typeof f?.path !== 'string' || typeof f.additions !== 'number' || typeof f.deletions !== 'number')
      return undefined
    files.push({ path: f.path, additions: f.additions, deletions: f.deletions })
  }
  return files
}

const jsonLines = (stdout: string): unknown[] =>
  stdout
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(parseJson)

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
