import fs from 'node:fs'
import path from 'node:path'
import { home } from '../../paths.js'
import { run, type Runner } from './exec.js'

/**
 * CC-1157: the tick's one GitHub read per repo. Every caller in a tick shares one conditional
 * `pulls?state=open` read, sent with the last ETag so an unchanged list costs a 304. The list is kept on
 * disk, so a failed read (the REST secondary limit of 2026-10-12) answers with the last-known list and
 * its age instead of refusing every task; with nothing stored it is undefined, which fails closed.
 *
 * `gh api -i` on a 304 (pinned live 2026-10-12, gh 2.x): exit 1, stdout `HTTP/2.0 304 Not Modified`
 * then headers and no body, stderr `gh: HTTP 304`.
 */

export interface PrFact {
  number: number
  title: string
  branch: string
  body: string
  headSha: string
  base: string
  draft: boolean
  updatedAt: string
}

export interface PrFacts {
  prs: PrFact[]
  /** When GitHub last confirmed this list (a 200 or a 304). */
  at: string
  /** True when this tick's read failed and `prs` is the last-known list. */
  stale: boolean
  ageMs: number
  /** False when the page was full, so a PR missing from it may still be open. */
  complete: boolean
}

interface Stored {
  v: 1
  etag: string
  at: string
  prs: PrFact[]
}

export interface PrFactsDeps {
  exec?: Runner
  /** Defaults to `~/.agent-chat/pr-facts`. */
  dir?: string
  now?: () => number
}

const PAGE = 100
const REPO = /^[\w.-]+\/[\w.-]+$/

export const prFactsDir = (): string => path.join(home(), 'pr-facts')

export function prFactsFile(repo: string, dir: string = prFactsDir()): string | undefined {
  const valid = REPO.test(repo) && !repo.split('/').some(part => /^\.+$/.test(part))
  return valid ? path.join(dir, `${repo.replace('/', '__')}.json`) : undefined
}

/** One conditional read of `repo`'s open PRs; on failure the stored list, marked stale with its age. */
export function readPrFacts(repo: string, deps: PrFactsDeps = {}): PrFacts | undefined {
  const file = prFactsFile(repo, deps.dir)
  if (file === undefined) return undefined
  const now = deps.now ?? Date.now
  const stored = loadStored(file)
  const response = fetchPulls(repo, stored?.etag, deps.exec ?? run)
  const fresh = refreshed(response, stored, new Date(now()).toISOString())
  if (fresh !== undefined) {
    writeStored(file, fresh)
    return toFacts(fresh, false, 0)
  }
  return stored === undefined ? undefined : toFacts(stored, true, now() - Date.parse(stored.at))
}

/** The tick's reader: each repo read at most once, however many callers ask. */
export function prFactsReader(deps: PrFactsDeps = {}): (repo: string) => PrFacts | undefined {
  const reads = new Map<string, PrFacts | undefined>()
  return repo => {
    if (!reads.has(repo)) reads.set(repo, readPrFacts(repo, deps))
    return reads.get(repo)
  }
}

interface Response {
  status: number
  etag: string | undefined
  body: string
}

// REST, never GraphQL: the owner's account hits GraphQL rate limits.
function fetchPulls(repo: string, etag: string | undefined, exec: Runner): Response | undefined {
  const conditional = etag === undefined || etag === '' ? [] : ['-H', `If-None-Match: ${etag}`]
  const result = exec('gh', ['api', '-i', ...conditional, `repos/${repo}/pulls?state=open&per_page=${PAGE}`])
  return parseResponse(result.stdout)
}

export function parseResponse(stdout: string): Response | undefined {
  const split = /\r?\n\r?\n/.exec(stdout)
  const head = split === null ? stdout : stdout.slice(0, split.index)
  const [statusLine = '', ...headers] = head.split(/\r?\n/)
  const status = /^HTTP\/[\d.]+ (\d{3})/.exec(statusLine)?.[1]
  if (status === undefined) return undefined
  const etag = headers.find(line => /^etag:/i.test(line))?.replace(/^etag:\s*/i, '')
  return {
    status: Number(status),
    etag,
    body: split === null ? '' : stdout.slice(split.index + split[0].length),
  }
}

/** The list GitHub just confirmed, or undefined when the read told us nothing. */
function refreshed(
  response: Response | undefined,
  stored: Stored | undefined,
  at: string,
): Stored | undefined {
  if (response === undefined) return undefined
  if (response.status === 304 && stored !== undefined)
    return { ...stored, etag: response.etag ?? stored.etag, at }
  if (response.status !== 200) return undefined
  const prs = parsePulls(response.body)
  return prs === undefined ? undefined : { v: 1, etag: response.etag ?? '', at, prs }
}

function parsePulls(body: string): PrFact[] | undefined {
  try {
    const pulls = JSON.parse(body) as unknown
    if (!Array.isArray(pulls)) return undefined
    const prs = pulls.map(toFact)
    return prs.every((pr): pr is PrFact => pr !== undefined) ? prs : undefined
  } catch {
    return undefined
  }
}

interface RawPull {
  number?: unknown
  title?: unknown
  body?: unknown
  draft?: unknown
  updated_at?: unknown
  head?: { ref?: unknown; sha?: unknown }
  base?: { ref?: unknown }
}

function toFact(raw: RawPull): PrFact | undefined {
  const { number, title, head, base } = raw
  if (typeof number !== 'number' || typeof head?.ref !== 'string' || typeof head.sha !== 'string')
    return undefined
  return {
    number,
    title: typeof title === 'string' ? title : '',
    branch: head.ref,
    body: typeof raw.body === 'string' ? raw.body : '',
    headSha: head.sha,
    base: typeof base?.ref === 'string' ? base.ref : '',
    draft: raw.draft === true,
    updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : '',
  }
}

const toFacts = (stored: Stored, stale: boolean, ageMs: number): PrFacts => ({
  prs: stored.prs,
  at: stored.at,
  stale,
  ageMs,
  complete: stored.prs.length < PAGE,
})

function loadStored(file: string): Stored | undefined {
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Stored>
    const valid =
      stored.v === 1 &&
      typeof stored.etag === 'string' &&
      typeof stored.at === 'string' &&
      Number.isFinite(Date.parse(stored.at)) &&
      Array.isArray(stored.prs)
    return valid ? (stored as Stored) : undefined
  } catch {
    return undefined
  }
}

/**
 * Write-then-rename in the same directory, so a concurrent tick never reads half a file. A failed write
 * costs only the next tick's 304, so it never fails this tick's read.
 */
function writeStored(file: string, stored: Stored): void {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, `${JSON.stringify(stored)}\n`, { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch {
    fs.rmSync(tmp, { force: true })
  }
}
