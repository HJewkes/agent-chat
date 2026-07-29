import { warn } from './warnings.js'
import type { Allocation, IsolationContext, IsolationStrategy, LivePeer } from './index.js'

/**
 * Ownership as advice, and — with `--strict` — as a gate.
 *
 * The pure half of this file is lifted from brain's file-ownership module: it
 * needs no adaptation, having no imports and no state. What agent-chat adds is
 * the manifest's provenance. In brain the manifest is a static object assembled
 * at dispatch time; here it is built from the claims of currently-CONNECTED
 * agents, so a claim is a lease held by presence. A dead agent's claim stops
 * blocking the moment its socket closes: no stale locks, and nothing to reap.
 */

export interface OwnershipRule {
  agentId: string
  patterns: string[]
}

export interface FileOwnershipManifest {
  rules: OwnershipRule[]
}

export interface OwnershipConflict {
  pattern: string
  agents: string[]
}

export interface FileOwnershipSummary {
  ownedFiles: string[]
  readOnlyHint: string
}

/**
 * Match a file path against a glob-like pattern.
 * Supports: `*` (single segment wildcard), `**` (multi-segment), exact matches,
 * and prefix patterns like `src/services/`.
 */
export function matchPattern(filePath: string, pattern: string): boolean {
  // Trailing slash means directory prefix match
  if (pattern.endsWith('/')) {
    return filePath.startsWith(pattern) || filePath === pattern.slice(0, -1)
  }

  // Exact match
  if (!pattern.includes('*')) {
    return filePath === pattern
  }

  return new RegExp(`^${globToRegex(pattern)}$`).test(filePath)
}

/** Token-by-token so that `**` can span separators while `*` cannot. */
function globToRegex(pattern: string): string {
  let regexStr = ''
  let i = 0
  while (i < pattern.length) {
    const char = pattern[i] as string
    if (char === '*' && pattern[i + 1] === '*') {
      i += 2
      if (pattern[i] === '/') i++
      // Divergence from the brain lift, which always emitted the interior form
      // and so made a trailing `src/**` — the most natural way to claim a
      // subtree — match no file at all, silently.
      regexStr += i >= pattern.length ? '.*' : '(?:.+/)?'
    } else if (char === '*') {
      regexStr += '[^/]*'
      i++
    } else {
      regexStr += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      i++
    }
  }
  return regexStr
}

/** Build a manifest from a set of agent-to-pattern assignments. */
export function buildOwnershipManifest(
  assignments: Array<{ agentId: string; patterns: readonly string[] }>,
): FileOwnershipManifest {
  return {
    rules: assignments.map(a => ({ agentId: a.agentId, patterns: [...a.patterns] })),
  }
}

/** Detect overlapping ownership: two or more agents claiming the same glob pattern. */
export function checkConflicts(manifest: FileOwnershipManifest): OwnershipConflict[] {
  const patternOwners = new Map<string, string[]>()

  for (const rule of manifest.rules) {
    for (const pattern of rule.patterns) {
      const existing = patternOwners.get(pattern)
      if (existing) existing.push(rule.agentId)
      else patternOwners.set(pattern, [rule.agentId])
    }
  }

  const conflicts: OwnershipConflict[] = []
  for (const [pattern, agents] of patternOwners) {
    if (agents.length > 1) conflicts.push({ pattern, agents })
  }
  return conflicts
}

/** Resolve who owns a given file path. Returns the agent ID or null if unowned. */
export function getOwner(manifest: FileOwnershipManifest, filePath: string): string | null {
  return getOwners(manifest, filePath)[0] ?? null
}

/** All owners matching a path — the path-level counterpart to `checkConflicts`. */
export function getOwners(manifest: FileOwnershipManifest, filePath: string): string[] {
  const owners: string[] = []
  for (const rule of manifest.rules) {
    if (rule.patterns.some(pattern => matchPattern(filePath, pattern))) owners.push(rule.agentId)
  }
  return owners
}

/** Build a summary for a specific agent: which files it owns and a read-only hint. */
export function getAgentOwnershipSummary(
  manifest: FileOwnershipManifest,
  agentId: string,
): FileOwnershipSummary {
  const rule = manifest.rules.find(r => r.agentId === agentId)
  const ownedFiles = rule?.patterns ?? []

  const otherPatterns = manifest.rules.filter(r => r.agentId !== agentId).flatMap(r => r.patterns)

  const readOnlyHint =
    otherPatterns.length > 0
      ? `Read-only (owned by other agents): ${otherPatterns.join(', ')}`
      : 'No other agents have file ownership claims.'

  return { ownedFiles, readOnlyHint }
}

/** Format ownership info for inclusion in a dispatch brief. */
export function formatOwnershipBrief(manifest: FileOwnershipManifest, agentId: string): string {
  const summary = getAgentOwnershipSummary(manifest, agentId)
  const lines = ['--- File Ownership ---']

  if (summary.ownedFiles.length > 0) {
    lines.push('Owned (can modify):')
    for (const p of summary.ownedFiles) lines.push(`  ${p}`)
  } else {
    lines.push('No file ownership assigned.')
  }
  lines.push(summary.readOnlyHint)

  return lines.join('\n')
}

/** The lease: only connected peers, and only those sharing this agent's checkout. */
function leaseholders(ctx: IsolationContext): LivePeer[] {
  return (ctx.peers ?? []).filter(
    p => p.agentId !== ctx.agentId && p.cwd === ctx.baseCwd && (p.claims?.length ?? 0) > 0,
  )
}

function manifestFor(ctx: IsolationContext): FileOwnershipManifest {
  return buildOwnershipManifest([
    { agentId: ctx.agentId, patterns: ctx.declaredPaths ?? [] },
    ...leaseholders(ctx).map(p => ({ agentId: p.name, patterns: p.claims ?? [] })),
  ])
}

/**
 * Overlaps this agent's declared paths against live claims, both ways: identical
 * patterns, and a declared path that falls inside somebody else's glob.
 */
function overlaps(ctx: IsolationContext): string[] {
  const manifest = manifestFor(ctx)
  const reasons = checkConflicts(manifest).map(
    c => `${c.pattern} is claimed by ${c.agents.filter(a => a !== ctx.agentId).join(', ')}`,
  )

  const others = { rules: manifest.rules.filter(r => r.agentId !== ctx.agentId) }
  for (const declared of ctx.declaredPaths ?? []) {
    const owners = getOwners(others, declared)
    if (owners.length > 0 && !reasons.some(r => r.startsWith(`${declared} `))) {
      reasons.push(`${declared} falls under a claim held by ${owners.join(', ')}`)
    }
  }
  return reasons
}

export const fileOwnershipStrategy: IsolationStrategy = {
  name: 'file-ownership',

  /**
   * Warn by default, refuse under `--strict`. Refusing by default would break
   * the ordinary case of two agents both needing to touch `package.json`.
   */
  async check(ctx: IsolationContext): Promise<string[]> {
    const found = overlaps(ctx)
    if (found.length === 0) return []
    return ctx.strict ? found : found.map(warn)
  },

  async allocate(ctx: IsolationContext): Promise<Allocation> {
    return {
      cwd: ctx.baseCwd,
      note: formatOwnershipBrief(manifestFor(ctx), ctx.agentId),
      ...(ctx.declaredPaths?.length ? { ref: { claims: ctx.declaredPaths.join(',') } } : {}),
    }
  },

  /** The claim was only ever a lease on presence; there is nothing on disk to undo. */
  async release(): Promise<boolean> {
    return true
  },
}
