import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { gitChildEnv } from '../git.js'

const execFileAsync = promisify(execFile)

/** `unknown` refuses on findings exactly as `public` does; only `private` downgrades to a warning. */
export type Visibility = 'public' | 'private' | 'unknown'

export type VisibilityReader = (remoteUrl: string) => Promise<Visibility>

export const VISIBILITY_TTL_MS = 24 * 60 * 60 * 1000

const GITHUB_URL =
  /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/

/** `owner/repo` for a GitHub remote URL, else undefined. */
export function gitHubRepo(url: string): string | undefined {
  const m = GITHUB_URL.exec(url.trim())
  return m ? `${m[1]}/${m[2]}` : undefined
}

/** The cache key: `owner/repo` for GitHub, the URL itself for anything else. */
export const remoteKey = (url: string): string => gitHubRepo(url) ?? url.trim()

export type Lookup = (repo: string) => Promise<string>

/** REST, never GraphQL: GraphQL shares a quota that is often exhausted. */
export const ghLookup: Lookup = async repo =>
  (
    await execFileAsync('gh', ['api', `repos/${repo}`, '--jq', '.visibility'], {
      env: gitChildEnv(),
      timeout: 10_000,
      encoding: 'utf8',
    })
  ).stdout.trim()

// `internal` is visible to an enterprise's members only, which is private for this guard's purpose.
function classify(raw: string): Visibility {
  if (raw === 'public') return 'public'
  return raw === 'private' || raw === 'internal' ? 'private' : 'unknown'
}

interface CacheEntry {
  visibility: 'public' | 'private'
  checkedAt: number
}

function readCache(file: string): Record<string, CacheEntry> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, CacheEntry>) : {}
  } catch {
    return {}
  }
}

function writeCache(file: string, cache: Record<string, CacheEntry>): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch {
    // A cache that cannot be written only costs a lookup next time.
  }
}

const fresh = (entry: CacheEntry | undefined, now: number): entry is CacheEntry =>
  entry !== undefined &&
  (entry.visibility === 'public' || entry.visibility === 'private') &&
  typeof entry.checkedAt === 'number' &&
  now - entry.checkedAt < VISIBILITY_TTL_MS

/**
 * A known answer is cached for a day. A failed lookup is `unknown` and is not cached, so the next
 * push asks again. A non-GitHub remote is never looked up and is `unknown` unless the cache says otherwise.
 */
export function cachedVisibility(
  cacheFile: string,
  lookup: Lookup = ghLookup,
  now: () => number = Date.now,
): VisibilityReader {
  return async url => {
    const key = remoteKey(url)
    const cache = readCache(cacheFile)
    const hit = cache[key]
    if (fresh(hit, now())) return hit.visibility
    const repo = gitHubRepo(url)
    if (repo === undefined) return 'unknown'
    const visibility = classify(await lookup(repo).catch(() => ''))
    if (visibility !== 'unknown') writeCache(cacheFile, { ...cache, [key]: { visibility, checkedAt: now() } })
    return visibility
  }
}
