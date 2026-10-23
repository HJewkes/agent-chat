/**
 * How an implementer's `gh api` call is read when the guard asks whether it merges (CC-1120). It
 * parses the words the way gh and GitHub do, so a spelling gh accepts cannot slip past a string match.
 */

// gh api's short flags that take a value; every other short letter is a switch such as -i.
const SHORT_VALUE = 'XfFHqtp'
const LONG_VALUE = new Set(
  '--method --raw-field --field --header --input --jq --template --hostname --cache --preview'.split(' '),
)

/** One short-flag word as gh reads it: `-iX PUT` is `-i -X PUT`, `-ifk=v` is `-i -f k=v`. */
function expandCluster(word: string): { words: string[]; open: boolean } {
  const words: string[] = []
  for (let k = 1; k < word.length; k++) {
    const letter = word[k] as string
    words.push(`-${letter}`)
    if (!SHORT_VALUE.includes(letter)) continue
    const rest = word.slice(k + 1).replace(/^=/, '')
    return rest === '' ? { words, open: true } : { words: [...words, rest], open: false }
  }
  return { words, open: false }
}

/** The words of a `gh api` call with each short-flag cluster split into one flag a word. */
export function splitApiFlags(args: readonly string[]): string[] {
  const out: string[] = []
  let open = false
  for (const arg of args) {
    if (open || !arg.startsWith('-') || arg === '-') {
      out.push(arg)
      open = false
    } else if (arg.startsWith('--')) {
      out.push(arg)
      open = LONG_VALUE.has(arg)
    } else {
      const cluster = expandCluster(arg)
      out.push(...cluster.words)
      open = cluster.open
    }
  }
  return out
}

const decoded = (path: string): string => {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

/** The API path gh requests: no scheme or host, no GHES `api/v3` prefix, query, fragment or stray slash. */
export function normalizeEndpoint(endpoint: string): string {
  const path = decoded(endpoint)
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '')
    .replace(/[?#][^]*$/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/|\/$/g, '')
  return path.replace(/^api\/v3\//i, '').replace(/^api\/graphql$/i, 'graphql')
}

// A pull's merge, a branch merge, and a ref move, which can set the base branch to the head.
const MERGE_WRITE = /^repos\/[^/]+\/[^/]+\/(?:pulls\/[^/]+\/merge|merges|git\/refs(?:\/.*)?)$/i

export const writeMerges = (endpoint: string): boolean => MERGE_WRITE.test(endpoint)

export const isGraphqlEndpoint = (endpoint: string): boolean => endpoint.toLowerCase() === 'graphql'

// GraphQL field names are case-sensitive, so `MergePullRequest` is no mutation GitHub runs.
const GRAPHQL_MERGE = /\b(?:mergePullRequest|enablePullRequestAutoMerge|mergeBranch)\b/

/** Every string in a JSON value, keys included, as GitHub sees them once it decodes the body. */
function jsonStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(jsonStrings)
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, inner]) => [key, ...jsonStrings(inner)])
}

/** Whether a query merges; a JSON `--input` body is decoded first, so an escape cannot hide a name. */
export function queryMerges(text: string, json: boolean): boolean {
  if (!json) return GRAPHQL_MERGE.test(text)
  try {
    return jsonStrings(JSON.parse(text)).some(s => GRAPHQL_MERGE.test(s))
  } catch {
    return GRAPHQL_MERGE.test(text)
  }
}
