import { spawnSync } from 'node:child_process'
import type { NamedItem } from './types.js'

/**
 * Optional GitHub lookups through the REST search endpoint: one call each for
 * approved open PRs and PRs merged in the window. Each call is time-boxed, and
 * a failure becomes a gap line rather than an error, so the digest never hangs
 * on GitHub.
 */

export const PR_TIMEOUT_MS = 8000
export const PR_PAGE = 50

export type Search = (query: string) => { items: NamedItem[] } | { error: string }

export const ghSearch: Search = query => {
  const res = spawnSync(
    'gh',
    [
      'api',
      '-X',
      'GET',
      'search/issues',
      '-f',
      `q=${query}`,
      '-f',
      `per_page=${PR_PAGE}`,
      '--jq',
      '.items[] | [.html_url, .title] | @tsv',
    ],
    { encoding: 'utf8', timeout: PR_TIMEOUT_MS },
  )
  if (res.error !== undefined) return { error: res.error.message }
  if (res.status !== 0)
    return { error: (res.stderr || `gh exited ${res.status}`).trim().split('\n')[0] ?? '' }
  const items = res.stdout
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => {
      const [label = '', detail = ''] = line.split('\t')
      return { label, detail }
    })
  return { items }
}

const isoSeconds = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

export interface PrLookup {
  readyToMerge: NamedItem[]
  merged: NamedItem[]
  gaps: string[]
}

export function lookupPrs(sinceMs: number, search: Search = ghSearch): PrLookup {
  const result: PrLookup = { readyToMerge: [], merged: [], gaps: [] }
  const queries: [keyof Omit<PrLookup, 'gaps'>, string][] = [
    ['readyToMerge', 'is:pr is:open review:approved author:@me'],
    ['merged', `is:pr is:merged merged:>=${isoSeconds(sinceMs)} author:@me`],
  ]
  for (const [key, query] of queries) {
    const found = search(query)
    if ('error' in found) result.gaps.push(`GitHub search "${query}" failed: ${found.error}`)
    else result[key] = found.items
    if (!('error' in found) && found.items.length >= PR_PAGE)
      result.gaps.push(`GitHub search "${query}" hit its ${PR_PAGE}-row page; more may exist`)
  }
  return result
}
