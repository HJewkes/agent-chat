import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { home } from '../../paths.js'
import { run, type Runner } from './exec.js'
import type { ChangedFile } from './pr-adopt.js'
import { GIT_BIN } from './review-diff.js'

/**
 * CC-1157 c: a PR's changed files from local git instead of `pulls/{n}/files`, which cost one
 * REST read per PR per tick and was the read the secondary rate limit refused. `refs/pull/<n>/head`
 * also serves fork PRs, so no PR needs the API. A diff is cached by PR and head sha: the
 * three-dot diff's merge base moves only when the head does, so a cached list stays right until
 * a push, and a push changes the key.
 */

/** The part of a PR fact this needs: which PR, its head commit, and the branch it targets. */
export interface PrHead {
  number: number
  headSha: string
  base: string
}

/** Each open PR's files, or undefined when that PR's fetch or diff failed. */
export interface PrFiles {
  names: (pr: number) => string[] | undefined
  stats: (pr: number) => ChangedFile[] | undefined
}

export interface PrFilesDeps {
  exec?: Runner
  cacheFile: string
}

const CacheEntry = z.object({
  base: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      previousPath: z.string().exactOptional(),
      additions: z.number(),
      deletions: z.number(),
    }),
  ),
})
type CacheEntry = z.infer<typeof CacheEntry>
const CacheFile = z.object({ v: z.literal(1), entries: z.record(z.string(), CacheEntry) })

export const PR_REF_ROOT = 'refs/agent-chat/pr/'
const prRef = (pr: number): string => `${PR_REF_ROOT}${pr}`
const cacheKey = (pr: PrHead): string => `${pr.number}:${pr.headSha}`

/** `~/.agent-chat/pr-facts/<owner>__<repo>.files.json`, beside slice a's facts file. */
export function prFilesCacheFile(githubRepo: string, root: string = home()): string {
  return path.join(root, 'pr-facts', `${githubRepo.replace('/', '__')}.files.json`)
}

/** Fetches only uncached heads in one batch, diffs each against `origin/<base>`, and prunes closed PRs. */
export function prFiles(repo: string, prs: readonly PrHead[], deps: PrFilesDeps): PrFiles {
  const exec = deps.exec ?? run
  const cached = readCache(deps.cacheFile)
  const misses = prs.filter(pr => cached.get(cacheKey(pr))?.base !== pr.base)
  const fetched = fetchHeads(repo, misses, exec)
  const entries = new Map<string, CacheEntry>()
  const byNumber = new Map<number, CacheEntry | undefined>()
  for (const pr of prs) {
    const hit = !misses.includes(pr)
    const entry = hit
      ? cached.get(cacheKey(pr))
      : fetched.has(pr.number)
        ? diffEntry(repo, pr, exec)
        : undefined
    if (entry !== undefined) entries.set(cacheKey(pr), entry)
    byNumber.set(pr.number, entry)
  }
  pruneRefs(repo, new Set(prs.map(pr => pr.number)), exec)
  if (!sameKeys(cached, entries) || misses.length > 0) writeCache(deps.cacheFile, entries)
  return {
    names: pr => byNumber.get(pr)?.files.map(f => f.path),
    stats: pr => byNumber.get(pr)?.files,
  }
}

/** The PRs whose head now sits at `refs/agent-chat/pr/<n>`; a failed batch retries each PR alone, so one bad ref fails only itself. */
function fetchHeads(repo: string, misses: readonly PrHead[], exec: Runner): Set<number> {
  if (misses.length === 0) return new Set()
  if (fetch(repo, misses, exec)) return new Set(misses.map(pr => pr.number))
  if (misses.length === 1) return new Set()
  return new Set(misses.filter(pr => fetch(repo, [pr], exec)).map(pr => pr.number))
}

function fetch(repo: string, prs: readonly PrHead[], exec: Runner): boolean {
  const bases = [...new Set(prs.map(pr => pr.base))].map(
    base => `+refs/heads/${base}:refs/remotes/origin/${base}`,
  )
  const heads = prs.map(pr => `+refs/pull/${pr.number}/head:${prRef(pr.number)}`)
  return exec(GIT_BIN, ['fetch', '--quiet', '--no-tags', 'origin', ...heads, ...bases], repo).status === 0
}

function diffEntry(repo: string, pr: PrHead, exec: Runner): CacheEntry | undefined {
  const range = `origin/${pr.base}...${prRef(pr.number)}`
  const result = exec(GIT_BIN, ['diff', '--numstat', '-z', '-M', range, '--'], repo)
  if (result.status !== 0) return undefined
  const files = parseNumstat(result.stdout)
  return files === undefined ? undefined : { base: pr.base, files }
}

/**
 * `git diff --numstat -z`: `<add>\t<del>\t<path>\0`, or for a rename `<add>\t<del>\t\0<old>\0<new>\0`.
 * A binary file counts `-`, read as 0 as GitHub reports it. An unreadable record fails the whole
 * list: a partial list could hide a sensitive path.
 */
export function parseNumstat(stdout: string): ChangedFile[] | undefined {
  const tokens = stdout.split('\0')
  const files: ChangedFile[] = []
  for (let i = 0; i < tokens.length; i++) {
    const record = tokens[i] ?? ''
    if (record === '') continue
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(record)
    if (match === null) return undefined
    const [, added = '-', deleted = '-', inline = ''] = match
    const counts = { additions: count(added), deletions: count(deleted) }
    if (inline !== '') {
      files.push({ path: inline, ...counts })
      continue
    }
    const previousPath = tokens[i + 1]
    const newPath = tokens[i + 2]
    if (!previousPath || !newPath) return undefined
    files.push({ path: newPath, previousPath, ...counts })
    i += 2
  }
  return files
}

const count = (field: string): number => (field === '-' ? 0 : Number(field))

/** Deletes the head ref of every PR no longer open, the same sweep leak-check runs on its scan refs. */
function pruneRefs(repo: string, open: ReadonlySet<number>, exec: Runner): void {
  const listed = exec(GIT_BIN, ['for-each-ref', '--format=%(refname)', PR_REF_ROOT], repo)
  if (listed.status !== 0) return
  for (const ref of listed.stdout.split('\n').filter(r => r.startsWith(PR_REF_ROOT))) {
    if (!open.has(Number(ref.slice(PR_REF_ROOT.length)))) exec(GIT_BIN, ['update-ref', '-d', ref], repo)
  }
}

/** A missing or malformed file is an empty cache: every PR is read again. */
function readCache(file: string): Map<string, CacheEntry> {
  try {
    const parsed = CacheFile.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')))
    return parsed.success ? new Map(Object.entries(parsed.data.entries)) : new Map()
  } catch {
    return new Map()
  }
}

/** Write-then-rename in the same directory, so a reader never sees half a file. */
function writeCache(file: string, entries: ReadonlyMap<string, CacheEntry>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify({ v: 1, entries: Object.fromEntries(entries) })}\n`, {
    mode: 0o600,
  })
  fs.renameSync(tmp, file)
}

const sameKeys = (a: ReadonlyMap<string, unknown>, b: ReadonlyMap<string, unknown>): boolean =>
  a.size === b.size && [...a.keys()].every(key => b.has(key))
