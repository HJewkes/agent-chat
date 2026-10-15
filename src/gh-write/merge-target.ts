/**
 * The PR a gh argument list would merge (CC-1319 a). gh-write and the agent gh shim read the PR's
 * Shepherd owner hold before a merge starts, so they need its exact `<owner>/<repo>#<n>`. Both see
 * raw argv, so this parser is deliberately narrow: a call it can tell is a merge but cannot name
 * exactly is `unresolved`, which its callers refuse. Anything that is not a merge is `none`.
 */

export type MergeTarget =
  { kind: 'none' } | { kind: 'merge'; repo?: string; pr: number } | { kind: 'unresolved'; why: string }

type Env = Readonly<Record<string, string | undefined>>

const NONE: MergeTarget = { kind: 'none' }
const unresolved = (why: string): MergeTarget => ({ kind: 'unresolved', why })

const NAME = /^[A-Za-z0-9_.-]+$/
const PR_NUMBER = /^\d+$/
const REPO_FLAGS = new Set(['-R', '--repo'])

/** A flag table: long flags and short letters that take a value, and those that do not. */
interface Flags {
  valueLong: ReadonlySet<string>
  valueShort: string
  boolLong: ReadonlySet<string>
  boolShort: string
}

const API_FLAGS: Flags = {
  valueLong: new Set(
    '--raw-field --field --header --input --jq --template --method --hostname --cache --preview'.split(' '),
  ),
  valueShort: 'fFHqtXp',
  boolLong: new Set(),
  boolShort: '',
}

const MERGE_FLAGS: Flags = {
  valueLong: new Set('--body --body-file --subject --author-email --match-head-commit --repo'.split(' ')),
  valueShort: 'bFtAR',
  boolLong: new Set('--admin --auto --delete-branch --merge --rebase --squash --disable-auto'.split(' ')),
  boolShort: 'dmrs',
}

interface Parsed {
  positionals: string[]
  flags: { name: string; value?: string | undefined }[]
  unknown: string[]
}

/** How many following words a short cluster such as `-sd` or `-Xput` consumes, or `undefined` if unknown. */
function shortArity(word: string, table: Flags): number | undefined {
  for (let i = 1; i < word.length; i++) {
    const letter = word[i] ?? ''
    if (table.valueShort.includes(letter)) return i === word.length - 1 ? 1 : 0
    if (!table.boolShort.includes(letter)) return undefined
  }
  return 0
}

function shortFlags(word: string, next: string | undefined, table: Flags): Parsed['flags'] {
  const out: Parsed['flags'] = []
  for (let i = 1; i < word.length; i++) {
    const name = `-${word[i]}`
    if (!table.valueShort.includes(word[i] ?? '')) {
      out.push({ name })
      continue
    }
    out.push({ name, value: i === word.length - 1 ? next : word.slice(i + 1).replace(/^=/, '') })
    break
  }
  return out
}

/** Splits words into positionals and flags by `table`; a flag it does not know lands in `unknown`. */
function parseWords(words: readonly string[], table: Flags): Parsed {
  const parsed: Parsed = { positionals: [], flags: [], unknown: [] }
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? ''
    if (word === '--') {
      parsed.positionals.push(...words.slice(i + 1))
      break
    }
    if (!word.startsWith('-') || word === '-') parsed.positionals.push(word)
    else
      i += word.startsWith('--')
        ? longFlag(word, words[i + 1], table, parsed)
        : shortFlag(word, words[i + 1], table, parsed)
  }
  return parsed
}

function longFlag(word: string, next: string | undefined, table: Flags, parsed: Parsed): number {
  const eq = word.indexOf('=')
  const name = eq === -1 ? word : word.slice(0, eq)
  if (table.valueLong.has(name)) {
    parsed.flags.push({ name, value: eq === -1 ? next : word.slice(eq + 1) })
    return eq === -1 ? 1 : 0
  }
  if (table.boolLong.has(name)) parsed.flags.push({ name, value: eq === -1 ? undefined : word.slice(eq + 1) })
  else parsed.unknown.push(word)
  return 0
}

function shortFlag(word: string, next: string | undefined, table: Flags, parsed: Parsed): number {
  const arity = shortArity(word, table)
  if (arity === undefined) {
    parsed.unknown.push(word)
    return 0
  }
  parsed.flags.push(...shortFlags(word, next, table))
  return arity
}

/**
 * The group word's index, past leading `-R` pairs. gh's root takes no other flag, so any other
 * leading flag makes the command unreadable; a call that might then be a merge is unresolved.
 */
function groupIndex(args: readonly string[]): number | undefined {
  let i = 0
  for (let word = args[0]; word?.startsWith('-'); word = args[i]) {
    if (REPO_FLAGS.has(word)) i += 2
    else if (word.startsWith('--repo=') || /^-R./.test(word)) i += 1
    else return undefined
  }
  return i
}

const mightMerge = (args: readonly string[]): boolean =>
  args.includes('api') || (args.includes('pr') && args.includes('merge'))

export function mergeTarget(args: readonly string[], env: Env): MergeTarget {
  const start = groupIndex(args)
  if (start === undefined) return mightMerge(args) ? unresolved('a flag before the gh group') : NONE
  if (args[start] === 'api') return apiTarget(args.slice(start + 1), env)
  if (args[start] === 'pr') return prTarget(args, start, env)
  return NONE
}

// --- api ------------------------------------------------------------------------------------------

const MERGE_PATH = /(?:^|\/)repos\/([^/]+)\/([^/]+)\/pulls\/([^/?#]+)\/merge(?:[/?#]|$)/i
const API_PREFIX = /^https?:\/\/api\.github\.com\//i
const OTHER_HOST = /^[a-z][a-z0-9+.-]*:\/\//i

const ASCII_ESCAPE = /%([0-7][0-9A-Fa-f])/g
const MAX_DECODE_ROUNDS = 8

/**
 * Decodes each ASCII `%XX` escape until stable, so a double-encoded path is read the way any later
 * hop could read it. Escapes are decoded one by one, so a malformed or non-ASCII escape elsewhere
 * in the word never stops the rest decoding; every character of a merge path is ASCII.
 * `undefined` when the word is still changing after the last round.
 */
function decoded(word: string): string | undefined {
  let current = word
  for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
    const next = current.replace(ASCII_ESCAPE, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    if (next === current) return current
    current = next
  }
  return undefined
}

/** The method is ignored on purpose: a method-override header could turn a GET into the merge. */
function apiTarget(rest: readonly string[], env: Env): MergeTarget {
  const parsed = parseWords(rest, API_FLAGS)
  if (parsed.positionals.some(isGraphql) && !graphqlIsReadableNonMerge(parsed))
    return unresolved('a GraphQL call that may merge')
  const merges = parsed.positionals.map(endpointTarget).filter(target => target.kind !== 'none')
  if (merges.length === 0) return NONE
  const host = parsed.flags.findLast(flag => flag.name === '--hostname')?.value ?? env.GH_HOST
  if (host !== undefined && host.toLowerCase() !== 'github.com') return unresolved('a merge on another host')
  const first = merges[0] as MergeTarget
  const key = (target: MergeTarget): string => JSON.stringify(target).toLowerCase()
  const same = merges.every(target => key(target) === key(first))
  return same ? first : unresolved('more than one merge endpoint')
}

const isGraphql = (word: string): boolean =>
  /^\/?graphql\/?(?:[?#]|$)/i.test((decoded(word) ?? '').replace(API_PREFIX, ''))

const FIELD_FLAGS = new Set(['-f', '--raw-field', '-F', '--field'])
const GRAPHQL_MERGE = /mergePullRequest|enablePullRequestAutoMerge/i

/** True only when every field is inline and none names a merge mutation; `-F x=@file` and `--input` are unread. */
function graphqlIsReadableNonMerge(parsed: Parsed): boolean {
  if (parsed.flags.some(flag => flag.name === '--input')) return false
  return parsed.flags
    .filter(flag => FIELD_FLAGS.has(flag.name))
    .every(({ name, value }) => {
      if (value === undefined || GRAPHQL_MERGE.test(value)) return false
      return !(name === '-F' || name === '--field') || !value.slice(value.indexOf('=') + 1).startsWith('@')
    })
}

/** False for a path with an empty, `.` or `..` segment, which a later hop may collapse into another path. */
function isCanonical(path: string): boolean {
  const segments = (path.split(/[?#]/)[0] ?? '').replace(/^\//, '').replace(/\/$/, '').split('/')
  return segments.every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

const MENTIONS_MERGE = /pulls[\s\S]*merge/i

function endpointTarget(word: string): MergeTarget {
  const plain = decoded(word)
  if (plain === undefined) return unresolved('a path encoded too deeply to read')
  const path = plain.replace(API_PREFIX, '')
  if (!isCanonical(path) && MENTIONS_MERGE.test(path)) return unresolved('a non-canonical pulls merge path')
  const match = MERGE_PATH.exec(path)
  if (match === null) return NONE
  if (OTHER_HOST.test(path)) return unresolved('a merge endpoint on another host')
  const [, owner = '', repo = '', pr = ''] = match
  if (!NAME.test(owner) || !NAME.test(repo)) return unresolved('a merge endpoint whose repo is not literal')
  if (!PR_NUMBER.test(pr)) return unresolved('a merge endpoint whose PR is not a number')
  return { kind: 'merge', repo: `${owner}/${stripGit(repo)}`, pr: Number(pr) }
}

const stripGit = (repo: string): string => repo.replace(/\.git$/i, '')

// --- pr merge -------------------------------------------------------------------------------------

const PR_URL = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i
const ANY_URL = /^[a-z][a-z0-9+.-]*:\/\//i

function prTarget(args: readonly string[], start: number, env: Env): MergeTarget {
  const verbAt = groupIndex(args.slice(start + 1))
  if (verbAt === undefined) return args.includes('merge') ? unresolved('a flag before the pr verb') : NONE
  const verbIndex = start + 1 + verbAt
  if (args[verbIndex] !== 'merge') return NONE
  const before = [...args.slice(0, start), ...args.slice(start + 1, verbIndex)]
  const parsed = parseWords([...before, ...args.slice(verbIndex + 1)], MERGE_FLAGS)
  const disables = parsed.flags.filter(flag => flag.name === '--disable-auto')
  if (disables.some(flag => flag.value !== undefined)) return unresolved('--disable-auto with a value')
  if (disables.length > 0) return NONE
  if (parsed.unknown.length > 0) return unresolved(`an unknown pr merge flag ${parsed.unknown[0]}`)
  if (parsed.positionals.length !== 1) return unresolved('pr merge needs exactly one PR number or URL')
  return selectorTarget(parsed.positionals[0] ?? '', repoFlags(parsed), env)
}

function repoFlags(parsed: Parsed): (string | undefined)[] {
  return parsed.flags.filter(flag => flag.name === '-R' || flag.name === '--repo').map(flag => flag.value)
}

function selectorTarget(selector: string, flagRepos: (string | undefined)[], env: Env): MergeTarget {
  const repos = flagRepos.map(value => repoName(value, env))
  const bad = repos.find(repo => typeof repo !== 'string')
  if (bad !== undefined) return bad as MergeTarget
  const named = repos as string[]
  if (new Set(named.map(repo => repo.toLowerCase())).size > 1) return unresolved('two different -R repos')
  const url = PR_URL.exec(selector)
  if (url !== null) return urlTarget(url, named[0])
  if (ANY_URL.test(selector)) return unresolved('a PR URL on another host')
  if (!/^#?\d+$/.test(selector)) return unresolved('a pr merge selector that is not a number or URL')
  const pr = Number(selector.replace('#', ''))
  const repo = named[0] ?? (env.GH_REPO === undefined ? undefined : repoName(env.GH_REPO, env))
  if (repo !== undefined && typeof repo !== 'string') return repo
  return repo === undefined ? { kind: 'merge', pr } : { kind: 'merge', repo, pr }
}

function urlTarget(url: RegExpExecArray, flagRepo: string | undefined): MergeTarget {
  const [, owner = '', repo = '', pr = ''] = url
  if (!NAME.test(owner) || !NAME.test(repo)) return unresolved('a PR URL whose repo is not literal')
  const fromUrl = `${owner}/${stripGit(repo)}`
  if (flagRepo !== undefined && flagRepo.toLowerCase() !== fromUrl.toLowerCase())
    return unresolved('a PR URL that disagrees with -R')
  return { kind: 'merge', repo: fromUrl, pr: Number(pr) }
}

/** `[HOST/]OWNER/REPO` as gh reads `-R` and `GH_REPO`; only github.com is named. */
function repoName(value: string | undefined, env: Env): string | MergeTarget {
  if (value === undefined) return unresolved('-R with no value')
  const parts = value
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .split('/')
  const host = parts.length === 3 ? parts[0] : env.GH_HOST
  if (host !== undefined && host.toLowerCase() !== 'github.com') return unresolved('a repo on another host')
  const [owner = '', repo = ''] = parts.slice(-2)
  if (parts.length > 3 || parts.length < 2 || !NAME.test(owner) || !NAME.test(repo))
    return unresolved(`a repo gh-write cannot name: ${value}`)
  return `${owner}/${stripGit(repo)}`
}
