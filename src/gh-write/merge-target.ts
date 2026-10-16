/**
 * The PR a gh argument list would merge (CC-1319 a). gh-write and the agent gh shim read the PR's
 * Shepherd owner hold before a merge starts, so they need its exact `<owner>/<repo>#<n>`. Both see
 * raw argv, so this parser is deliberately narrow: a call it can tell is a merge but cannot name
 * exactly is `unresolved`, which its callers refuse. On the surfaces that can write a repo's
 * branches (`api`, `pr`, `repo`), `none` comes only from an allow-list of operations known not to
 * merge, so a spelling nobody listed fails closed; every other gh group is `none`. Each value is
 * read exactly as the program that consumes it (cobra, gh, GitHub's router or its GraphQL lexer)
 * receives it: the only transforms are ones that consumer applies too, and a `none` never rests on
 * a transform it might not apply.
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
  boolLong: new Set('--include --paginate --silent --slurp --verbose'.split(' ')),
  boolShort: 'i',
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

/** cobra drops an empty or whitespace-only word when it picks the command, so `'' pr merge` is `pr merge`. */
const isBlank = (word: string | undefined): boolean => word !== undefined && word.trim() === ''

const BRANCH_WRITING_GROUPS = new Set(['api', 'pr', 'repo'])

/** Read-only verbs, and verbs that change only a PR's conversation or state or a local checkout. */
const PR_NON_MERGE_VERBS = new Set(
  'view list ls status checks diff checkout co create new comment review edit close reopen ready lock unlock'.split(
    ' ',
  ),
)

/** Read-only verbs, and verbs that only make a new repo or change local setup. */
const REPO_NON_MERGE_VERBS = new Set(
  'view list ls clone create new fork set-default gitignore license'.split(' '),
)

const mightWrite = (args: readonly string[]): boolean => args.some(word => BRANCH_WRITING_GROUPS.has(word))

export function mergeTarget(args: readonly string[], env: Env): MergeTarget {
  const start = groupIndex(args)
  if (start === undefined) return mightWrite(args) ? unresolved('a flag before the gh group') : NONE
  if (isBlank(args[start])) return mightWrite(args) ? unresolved('an empty word before the gh group') : NONE
  if (args[start] === 'api') return apiTarget(args.slice(start + 1), env)
  if (args[start] === 'pr') return prTarget(args, start, env)
  if (args[start] === 'repo') return verbTarget(args, start, REPO_NON_MERGE_VERBS)
  return NONE
}

/** The verb's index past `-R` pairs, or unresolved when a flag or an empty word hides it. */
function verbIndex(args: readonly string[], start: number): number | MergeTarget {
  const group = args[start] ?? ''
  const verbAt = groupIndex(args.slice(start + 1))
  if (verbAt === undefined) return unresolved(`a flag before the ${group} verb`)
  const at = start + 1 + verbAt
  return isBlank(args[at]) ? unresolved(`an empty word before the ${group} verb`) : at
}

/** `none` only for a verb on `nonMerge`; any other verb, or one that cannot be read, is unresolved. */
function verbTarget(args: readonly string[], start: number, nonMerge: ReadonlySet<string>): MergeTarget {
  const at = verbIndex(args, start)
  if (typeof at !== 'number') return at
  const verb = args[at] ?? ''
  return nonMerge.has(verb)
    ? NONE
    : unresolved(`a ${args[start]} verb not known to leave branches alone: ${verb}`)
}

// --- api ------------------------------------------------------------------------------------------

/**
 * The operations known to land a PR's commits on its base, one row each, so a call can be named
 * or refused with a reason. The table only sharpens the answer: a write that matches no row is
 * still unresolved unless an allow-list below shows it does not merge. A row states what it
 * covers once, as `vocabulary`, and both readers apply that same pattern, so neither can be
 * narrower than the other:
 * - REST runs it on every decoded API path past its repo, whatever its prefix or suffix. A match is
 *   unresolved unless the path is exactly `PR_MERGE_PATH`, the one spelling that names a target.
 * - GraphQL runs it on every field of a call to exactly `graphql` whose document is a mutation.
 * `writesOnly` rows skip REST reads; a GraphQL query cannot write, so only mutations are read.
 * Refs are here because a ref write can fast-forward a PR's base.
 */
interface MergeOperation {
  covers: string
  vocabulary: RegExp
  writesOnly: boolean
}

export const MERGE_OPERATIONS: readonly MergeOperation[] = [
  { covers: 'a PR merge or auto-merge', vocabulary: /pull[\s\S]*merge|merge[\s\S]*pull/i, writesOnly: false },
  { covers: 'a branch merge', vocabulary: /merge(?:s|branch)/i, writesOnly: false },
  { covers: 'a merge queue change', vocabulary: /queue/i, writesOnly: false },
  { covers: 'any ref create, update or delete', vocabulary: /ref/i, writesOnly: true },
]

const PR_MERGE_PATH = /^\/?repos\/([^/]+)\/([^/]+)\/pulls\/([^/?#]+)\/merge(?:[/?#]|$)/i
const API_PREFIX = /^https?:\/\/api\.github\.com\//i

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

/** A merge path ignores the method on purpose: a method-override header could turn a GET into the merge. */
function apiTarget(rest: readonly string[], env: Env): MergeTarget {
  const parsed = parseWords(rest, API_FLAGS)
  const graphql = parsed.positionals.filter(mentionsGraphql)
  if (!graphql.every(word => EXACT_GRAPHQL.test(word.replace(API_PREFIX, ''))))
    return unresolved('a GraphQL path that is not exactly graphql')
  if (graphql.length > 0 && !graphqlIsReadableNonMerge(parsed))
    return unresolved('a GraphQL call that may merge')
  const writes = isWrite(parsed)
  const merges = parsed.positionals
    .filter(word => !mentionsGraphql(word))
    .map(word => endpointTarget(word, writes, env))
    .filter(target => target.kind !== 'none')
  if (merges.length === 0) return NONE
  const host = parsed.flags.findLast(flag => flag.name === '--hostname')?.value ?? env.GH_HOST
  if (host !== undefined && host.toLowerCase() !== 'github.com') return unresolved('a merge on another host')
  const first = merges[0] as MergeTarget
  const key = (target: MergeTarget): string => JSON.stringify(target).toLowerCase()
  const same = merges.every(target => key(target) === key(first))
  return same ? first : unresolved('more than one merge endpoint')
}

/** The decoded path with any api.github.com prefix stripped; `undefined` when it never stops decoding. */
const apiPath = (word: string): string | undefined => decoded(word)?.replace(API_PREFIX, '')

/**
 * Any path that names graphql, even encoded, is the GraphQL endpoint unless proven otherwise: only
 * exactly `graphql` as written has its fields read, and every other spelling (`graphql.json`,
 * `v3/graphql`, `gr%61phql`) is unresolved.
 */
const EXACT_GRAPHQL = /^\/?graphql$/i
const mentionsGraphql = (word: string): boolean => /graphql/i.test(apiPath(word) ?? '')

const FIELD_FLAGS = new Set(['-f', '--raw-field', '-F', '--field'])

/** gh fills these in a path and in every `-F` value from the current repo, which this parser cannot see. */
const PLACEHOLDER = /\{(?:owner|repo|branch)\}|:(?:owner|repo|branch)\b/

/**
 * True only when every flag is known and every field reaches GitHub exactly as written, as a
 * document that is no mutation or whose top-level fields are all on NON_MERGE_MUTATIONS. Neither
 * gh nor GitHub's GraphQL lexer percent-decodes a field, so this reads the raw value; a value that
 * would decode differently, a file read (`=@`), `--input` or a `-F` placeholder is unread.
 */
function graphqlIsReadableNonMerge(parsed: Parsed): boolean {
  if (parsed.unknown.length > 0 || parsed.flags.some(flag => flag.name === '--input')) return false
  const fields = parsed.flags.filter(flag => FIELD_FLAGS.has(flag.name))
  if (!fields.every(field => fieldReachesGithubAsWritten(field))) return false
  const mutations = fields.map(({ value = '' }) => value).filter(value => /mutation/i.test(value))
  return mutations.every(value =>
    mutationFields(value.slice(value.indexOf('=') + 1))?.every(field => NON_MERGE_MUTATIONS.has(field)),
  )
}

function fieldReachesGithubAsWritten({ name, value }: Parsed['flags'][number]): boolean {
  if (value === undefined || decoded(value) !== value || /^[^=]*=@/.test(value)) return false
  return !(/^(?:-F|--field)$/.test(name) && PLACEHOLDER.test(value))
}

/** Mutations that change only an issue's or PR's conversation, labels or state. */
const NON_MERGE_MUTATIONS = new Set(
  [
    'addComment updateIssueComment deleteIssueComment minimizeComment addReaction removeReaction',
    'addPullRequestReview addPullRequestReviewComment addPullRequestReviewThread submitPullRequestReview',
    'updatePullRequestReview deletePullRequestReview dismissPullRequestReview requestReviews',
    'resolveReviewThread unresolveReviewThread addLabelsToLabelable removeLabelsFromLabelable',
    'createIssue updateIssue closeIssue reopenIssue createPullRequest updatePullRequest closePullRequest',
    'reopenPullRequest markPullRequestReadyForReview convertPullRequestToDraft',
  ]
    .join(' ')
    .split(' '),
)

/**
 * One lexical token of the subset of GraphQL whose lexing no two parsers dispute: ignored
 * whitespace and commas, a comment of printable ASCII, a one-line string with only the spec's
 * escapes, `...`, a name, or one printable ASCII character. Anything else, such as a control or
 * non-ASCII character outside a string, ends the walk and the document is unread.
 */
const GRAPHQL_TOKEN =
  /[\t\n\r ,]+|#[\t\x20-\x7E]*|"(?:[^"\\\n\r]|\\["\\/bfnrt]|\\u[0-9A-Fa-f]{4})*"|\.\.\.|[_A-Za-z]\w*|[\x21-\x7E]/y
const IGNORED_TOKEN = /^(?:[\t\n\r ,]|#|"[\s\S])/
const NAME_TOKEN = /^[_A-Za-z]/

/**
 * The document's significant tokens, or `undefined` when it holds a block string (lexers differ
 * on its `\"""` escape) or anything outside the subset GRAPHQL_TOKEN reads.
 */
function graphqlTokens(document: string): string[] | undefined {
  if (document.includes('"""')) return undefined
  const tokens: string[] = []
  GRAPHQL_TOKEN.lastIndex = 0
  while (GRAPHQL_TOKEN.lastIndex < document.length) {
    const token = GRAPHQL_TOKEN.exec(document)?.[0]
    if (token === undefined) return undefined
    if (!IGNORED_TOKEN.test(token)) tokens.push(token)
  }
  return tokens
}

interface Walk {
  braces: number
  parens: number
  keyword: boolean
  mutation: boolean
  fields: string[]
}

/**
 * The top-level fields of every mutation in a GraphQL document, or `undefined` when the document
 * does not read plainly: a fragment spread, a directive, an unclosed string or stray punctuation.
 */
function mutationFields(document: string): string[] | undefined {
  const tokens = graphqlTokens(document)
  if (tokens === undefined) return undefined
  const walk: Walk = { braces: 0, parens: 0, keyword: true, mutation: false, fields: [] }
  for (let i = 0; i < tokens.length; i++) if (!step(walk, tokens[i] ?? '', tokens[i + 1])) return undefined
  return walk.braces === 0 && walk.parens === 0 ? walk.fields : undefined
}

/** One token; false when it makes the document unreadable. A name before `:` is an alias, not a field. */
function step(walk: Walk, token: string, next: string | undefined): boolean {
  if (walk.parens > 0) return argumentStep(walk, token)
  if (token === '(') walk.parens = 1
  else if (token === '{') openBrace(walk)
  else if (token === '}') return closeBrace(walk)
  else if (!NAME_TOKEN.test(token)) return token === ':' && walk.braces > 0
  else if (walk.braces === 0) return definitionName(walk, token)
  else if (walk.mutation && walk.braces === 1 && next !== ':') walk.fields.push(token)
  return true
}

/** Inside arguments or variable definitions only parens nest; object braces there are values. */
function argumentStep(walk: Walk, token: string): boolean {
  if (token === '(') walk.parens++
  if (token === ')') walk.parens--
  return token !== '"'
}

function openBrace(walk: Walk): void {
  if (walk.braces === 0 && walk.keyword) walk.mutation = false
  walk.keyword = false
  walk.braces++
}

function closeBrace(walk: Walk): boolean {
  if (walk.braces === 0) return false
  walk.braces--
  if (walk.braces === 0) Object.assign(walk, { keyword: true, mutation: false })
  return true
}

/** The first name of a definition is its keyword; any later one (a name, `on`, a type) is skipped. */
function definitionName(walk: Walk, token: string): boolean {
  if (!walk.keyword) return true
  walk.keyword = false
  walk.mutation = /^mutation$/i.test(token)
  return walk.mutation || /^(?:query|subscription|fragment)$/.test(token)
}

/** False for a path with an empty, `.` or `..` segment, which a later hop may collapse into another path. */
function isCanonical(path: string): boolean {
  const segments = (path.split(/[?#]/)[0] ?? '').replace(/^\//, '').replace(/\/$/, '').split('/')
  return segments.every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * gh's own method: `-X` as written, since gh sends it unchanged, else POST when it sends a body.
 * A header whose name mentions a method or an override counts as a write.
 */
function isWrite(parsed: Parsed): boolean {
  const header = (flag: Parsed['flags'][number]): boolean =>
    /^(?:-H|--header)$/.test(flag.name) && /^[^:]*(?:method|override)/i.test(flag.value ?? '')
  if (parsed.flags.some(header)) return true
  const method = parsed.flags.findLast(flag => flag.name === '-X' || flag.name === '--method')
  if (method !== undefined) return !/^(?:GET|HEAD)$/.test(method.value ?? '')
  return parsed.flags.some(flag => FIELD_FLAGS.has(flag.name) || flag.name === '--input')
}

const REPO_PREFIX = /^\/?(?:repos\/[^/]+\/[^/?#]+|repositories\/[^/?#]+)(?=[/?#]|$)/i

/** A canonical path past its repo, so a repo named `refinery` or `merges-lib` is not read as an operation. */
const afterRepo = (path: string): string => (isCanonical(path) ? path.replace(REPO_PREFIX, '') : path)

function endpointTarget(word: string, writes: boolean, env: Env): MergeTarget {
  const sent = filledPlaceholders(word, env)
  if (sent === undefined && writes) return unresolved('a write path gh fills from a repo it cannot see')
  const raw = sent ?? word
  const path = apiPath(raw)
  if (path === undefined) return unresolved('a path encoded too deeply to read')
  // A read's query string cannot merge, so a GET is scanned only up to `?`.
  const scanned = afterRepo(writes ? path : (path.split('?')[0] ?? ''))
  const named = MERGE_OPERATIONS.find(
    ({ vocabulary, writesOnly }) => (writes || !writesOnly) && vocabulary.test(scanned),
  )
  if (named === undefined)
    return writes && !isNonMergeWrite(raw, path)
      ? unresolved('a write not known to leave branches alone')
      : NONE
  const exact = isCanonical(path) ? PR_MERGE_PATH.exec(path) : null
  return exact === null ? unresolved(`a path that may be ${named.covers}`) : prMergeTarget(exact)
}

/**
 * The path gh sends once it fills `{owner}` and `{repo}` from GH_REPO, or `undefined` when gh
 * would fill one from a git remote or the current branch, which this parser cannot see.
 */
function filledPlaceholders(word: string, env: Env): string | undefined {
  if (!PLACEHOLDER.test(word)) return word
  const repo = env.GH_REPO === undefined ? undefined : repoName(env.GH_REPO, env)
  if (typeof repo !== 'string' || /\{branch\}|:branch\b/.test(word)) return undefined
  const [owner = '', name = ''] = repo.split('/')
  return word.replace(new RegExp(PLACEHOLDER, 'g'), found => (found.includes('owner') ? owner : name))
}

/** Repo writes that change only an issue's or PR's conversation, labels, reviewers or state. */
const NON_MERGE_WRITES: readonly RegExp[] = [
  /^\/issues(?:\/\d+(?:\/(?:comments|labels|assignees))?)?$/,
  /^\/issues\/comments\/\d+$/,
  /^\/pulls(?:\/\d+(?:\/(?:comments|reviews|requested_reviewers))?)?$/,
  /^\/pulls\/\d+\/reviews\/\d+(?:\/events)?$/,
  /^\/pulls\/comments\/\d+$/,
]

/**
 * True only for a canonical repo path whose rest, query and all, is exactly on the allow-list and
 * holds no escape, so the allow-list never rests on how GitHub decodes a path.
 */
function isNonMergeWrite(raw: string, path: string): boolean {
  if (raw.includes('%') || !isCanonical(path) || !REPO_PREFIX.test(path)) return false
  const rest = path.replace(REPO_PREFIX, '')
  return NON_MERGE_WRITES.some(pattern => pattern.test(rest))
}

function prMergeTarget(match: RegExpExecArray): MergeTarget {
  const [, owner = '', repo = '', pr = ''] = match
  if (!NAME.test(owner) || !isRepoName(repo)) return unresolved('a merge endpoint whose repo is not literal')
  const number = prNumber(pr)
  if (number === undefined) return unresolved('a merge endpoint whose PR is not a number')
  return { kind: 'merge', repo: `${owner}/${repo}`, pr: number }
}

/**
 * A repo name as given. A `.git` suffix is unread rather than stripped: gh strips it only from a
 * URL, and how GitHub resolves `r.git` is not something this parser can see.
 */
const isRepoName = (repo: string): boolean => NAME.test(repo) && !/\.git$/i.test(repo)

/** The PR number, or `undefined` past the integers a JS number holds exactly, which gh would read differently. */
function prNumber(digits: string): number | undefined {
  const number = Number(digits)
  return PR_NUMBER.test(digits) && Number.isSafeInteger(number) ? number : undefined
}

// --- pr merge -------------------------------------------------------------------------------------

const PR_URL = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i
const ANY_URL = /^[a-z][a-z0-9+.-]*:\/\//i

function prTarget(args: readonly string[], start: number, env: Env): MergeTarget {
  const at = verbIndex(args, start)
  if (typeof at !== 'number') return at
  if (args[at] !== 'merge') return verbTarget(args, start, PR_NON_MERGE_VERBS)
  const before = [...args.slice(0, start), ...args.slice(start + 1, at)]
  const parsed = parseWords([...before, ...args.slice(at + 1)], MERGE_FLAGS)
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
  const pr = prNumber(selector.replace(/^#/, ''))
  if (pr === undefined) return unresolved('a pr merge selector that is not a number or URL')
  const repo = named[0] ?? (env.GH_REPO === undefined ? undefined : repoName(env.GH_REPO, env))
  if (repo !== undefined && typeof repo !== 'string') return repo
  return repo === undefined ? { kind: 'merge', pr } : { kind: 'merge', repo, pr }
}

function urlTarget(url: RegExpExecArray, flagRepo: string | undefined): MergeTarget {
  const [, owner = '', repo = '', digits = ''] = url
  if (!NAME.test(owner) || !isRepoName(repo)) return unresolved('a PR URL whose repo is not literal')
  const pr = prNumber(digits)
  if (pr === undefined) return unresolved('a PR URL whose PR is not a number')
  const fromUrl = `${owner}/${repo}`
  if (flagRepo !== undefined && flagRepo.toLowerCase() !== fromUrl.toLowerCase())
    return unresolved('a PR URL that disagrees with -R')
  return { kind: 'merge', repo: fromUrl, pr }
}

/** `[HOST/]OWNER/REPO` as gh reads `-R` and `GH_REPO`; only github.com is named. */
function repoName(value: string | undefined, env: Env): string | MergeTarget {
  if (value === undefined) return unresolved('-R with no value')
  const parts = repoParts(value)
  const host = parts.length === 3 ? parts[0] : env.GH_HOST
  if (host !== undefined && host.toLowerCase() !== 'github.com') return unresolved('a repo on another host')
  const [owner = '', repo = ''] = parts.slice(-2)
  if (parts.length > 3 || parts.length < 2 || !NAME.test(owner) || !isRepoName(repo))
    return unresolved(`a repo gh-write cannot name: ${value}`)
  return `${owner}/${repo}`
}

/**
 * The words of a repo as gh splits them: a plain value on `/` as written, and an http(s) URL into
 * its host and a path that must be exactly `OWNER/REPO` once gh trims outer slashes and one `.git`.
 */
function repoParts(value: string): string[] {
  const url = /^https?:\/\/([^/]*)\/(.*)$/i.exec(value)
  if (url === null) return value.split('/')
  const [, host = '', path = ''] = url
  const rest = path.replace(/^\/+|\/+$/g, '').split('/')
  return rest.length === 2 ? [host, rest[0] ?? '', (rest[1] ?? '').replace(/\.git$/, '')] : []
}
