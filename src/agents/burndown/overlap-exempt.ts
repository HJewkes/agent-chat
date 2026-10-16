import { basename } from 'node:path'
import { readAgentChatConfig, type AgentChatConfig } from '../../config.js'
import { matchPattern } from '../isolation/file-ownership.js'

/**
 * Append-only shared docs, exempt in every repo (CC-1185). Shepherd's merge-up resolves the text
 * conflict at land, so two slices that both add a line to one never wait on each other.
 */
export const SHARED_DOC_EXEMPT: readonly string[] = ['**/CAPABILITIES.md', '**/README*.md', '.changeset/**']

/**
 * Append-only indexes and regenerated output, per repo basename (CC-1153). Two PRs that both
 * touch one of these merge up cleanly or regenerate at land, so serialising them at dispatch
 * only idles implementers (autonomy charter 6.2).
 */
export const DEFAULT_OVERLAP_EXEMPT: Readonly<Record<string, readonly string[]>> = {
  'titan-platform': [
    'site/reference/**',
    'site/.vitepress/reference-sidebar.json',
    'site/guides/capabilities.md',
    '.codewatch/check.json',
  ],
}

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string')

/** The shared docs plus the repo's own list. */
export function overlapExemptFor(repo: string, config: AgentChatConfig = readAgentChatConfig()): string[] {
  return [...SHARED_DOC_EXEMPT, ...repoExemptFor(basename(repo), config)]
}

/** `dispatchOverlapExempt` replaces the default for each repo it names; a malformed value keeps the default, since a typo must not stop dispatch. */
function repoExemptFor(name: string, config: AgentChatConfig): string[] {
  const fallback = [...(DEFAULT_OVERLAP_EXEMPT[name] ?? [])]
  const table = config.dispatchOverlapExempt
  if (typeof table !== 'object' || table === null || !Object.hasOwn(table, name)) return fallback
  const value = (table as Record<string, unknown>)[name]
  return isStringList(value) ? value : fallback
}

/** The owns no exempt pattern matches. */
export const exemptFromOverlap = (owns: readonly string[], exempt: readonly string[]): string[] =>
  owns.filter(own => !exempt.some(pattern => matchPattern(own, pattern)))
