import { ISOLATION_NAMES, type IsolationName } from '../../protocol.js'
import { fileOwnershipStrategy } from './file-ownership.js'
import { noneStrategy } from './none.js'
import { toolsetStrategy } from './toolset.js'
import { worktreeStrategy } from './worktree.js'

/**
 * A peer an isolation strategy is allowed to reason about: an agent that is both
 * a durable identity and currently connected (roster ∩ registry).
 *
 * The caller computes the intersection and hands it in, which is what keeps every
 * strategy pure and testable without a broker. It is also the mechanism behind
 * the claim-as-lease rule: a claim by an agent whose socket has closed is simply
 * absent from `peers`, so it stops blocking with no reaper and no stale lock.
 */
export interface LivePeer {
  agentId: string
  name: string
  cwd: string
  /** Paths this peer declared it would modify, from its own allocation. */
  claims?: readonly string[]
}

export interface IsolationContext {
  agentId: string
  agentName: string
  baseCwd: string
  /** For file-ownership: the paths this agent declares it will modify. */
  declaredPaths?: string[]
  /** Roster ∩ registry, supplied by the caller. Absent means "assume nobody". */
  peers?: readonly LivePeer[]
  /** For toolset-limited: the profile's tool lists, which the context does not otherwise carry. */
  toolset?: { allowedTools?: string[]; disallowedTools?: string[] }
  /** Turns advisory conflicts into refusals. Wired to `--strict`. */
  strict?: boolean
  /**
   * `agent_exited.ts` for this agent, when it has exited. Anchors the worktree
   * reclaim grace window — see RECLAIM_GRACE_MS in worktree.ts.
   */
  exitedAt?: number
  /**
   * Discard a leftover branch instead of adopting it. Opt-in, and deliberately
   * on the context rather than defaulted: allocation can destroy commits exactly
   * as release can, so it takes the same explicit instruction.
   */
  forceReset?: boolean
}

export interface Allocation {
  cwd: string
  env?: Record<string, string>
  addDirs?: string[]
  allowedTools?: string[]
  disallowedTools?: string[]
  /** One line for the agent's brief: "you own src/cli/**; everything else is read-only". */
  note?: string
  /** Strategy-specific handle — branch, worktree path, claim id. Goes in meta. */
  ref?: Record<string, string>
}

export interface ReleaseOptions {
  /** Bypass the dirty/unmerged refusal. Explicit destruction only. */
  force?: boolean
}

export interface IsolationStrategy {
  readonly name: IsolationName
  /** Pre-flight. Empty array = safe to proceed. Non-empty = reasons, shown to the requester. */
  check(ctx: IsolationContext): Promise<string[]>
  allocate(ctx: IsolationContext): Promise<Allocation>
  /** Returns false when it refused (dirty/unmerged) rather than failed. */
  release(ctx: IsolationContext, alloc: Allocation, opts?: ReleaseOptions): Promise<boolean>
}

const STRATEGIES: Record<IsolationName, IsolationStrategy> = {
  none: noneStrategy,
  worktree: worktreeStrategy,
  'file-ownership': fileOwnershipStrategy,
  'toolset-limited': toolsetStrategy,
}

export const isIsolationName = (value: string): value is IsolationName =>
  (ISOLATION_NAMES as readonly string[]).includes(value)

export function getStrategy(name: IsolationName): IsolationStrategy {
  return STRATEGIES[name]
}

/**
 * Compose strategies into one.
 *
 * MVP ships single-strategy selection — a profile names exactly one — but the
 * composite exists from the start so that `['toolset-limited', 'worktree']`
 * stays a config change rather than a refactor. Do NOT reintroduce the
 * single-strategy assumption into the supervisor: call this even for one name.
 */
export function resolve(names: readonly IsolationName[]): IsolationStrategy {
  if (names.length === 0) return noneStrategy
  const only = names.length === 1 ? names[0] : undefined
  if (only !== undefined) return getStrategy(only)
  return composite(names.map(getStrategy))
}

/** `cwd` comes from the last strategy that moved it; tools narrow, never widen. */
function mergeAllocations(baseCwd: string, parts: readonly Allocation[]): Allocation {
  const merged: Allocation = { cwd: baseCwd }
  const notes: string[] = []
  for (const part of parts) {
    if (part.cwd !== baseCwd) merged.cwd = part.cwd
    if (part.env) merged.env = { ...merged.env, ...part.env }
    if (part.addDirs) merged.addDirs = [...new Set([...(merged.addDirs ?? []), ...part.addDirs])]
    if (part.allowedTools) merged.allowedTools = intersect(merged.allowedTools, part.allowedTools)
    if (part.disallowedTools)
      merged.disallowedTools = [...new Set([...(merged.disallowedTools ?? []), ...part.disallowedTools])]
    if (part.note) notes.push(part.note)
    if (part.ref) merged.ref = { ...merged.ref, ...part.ref }
  }
  if (notes.length > 0) merged.note = notes.join('\n')
  return merged
}

const intersect = (left: string[] | undefined, right: string[]): string[] =>
  left === undefined ? [...right] : left.filter(tool => right.includes(tool))

function composite(strategies: readonly IsolationStrategy[]): IsolationStrategy {
  return {
    // The composite reports as the last strategy that owns a cwd, since that is
    // the one whose ref a human has to go and clean up by hand if anything leaks.
    name: strategies[strategies.length - 1]?.name ?? 'none',

    async check(ctx) {
      const results = await Promise.all(strategies.map(s => s.check(ctx)))
      return results.flat()
    },

    async allocate(ctx) {
      const done: Array<{ strategy: IsolationStrategy; alloc: Allocation }> = []
      try {
        for (const strategy of strategies) {
          const last = done[done.length - 1]?.alloc
          const alloc = await strategy.allocate(last ? { ...ctx, baseCwd: last.cwd } : ctx)
          done.push({ strategy, alloc })
        }
      } catch (err) {
        // A half-allocated agent leaks a worktree nobody will ever release, so
        // unwind with force — these allocations are seconds old and cannot hold work.
        for (const { strategy, alloc } of done.reverse()) {
          await strategy.release(ctx, alloc, { force: true }).catch(() => false)
        }
        throw err
      }
      return mergeAllocations(
        ctx.baseCwd,
        done.map(d => d.alloc),
      )
    },

    async release(ctx, alloc, opts) {
      let released = true
      for (const strategy of [...strategies].reverse()) {
        if (!(await strategy.release(ctx, alloc, opts))) released = false
      }
      return released
    },
  }
}

export { noneStrategy, worktreeStrategy, fileOwnershipStrategy, toolsetStrategy }
export { WARNING_PREFIX, isWarning, refusalsIn } from './warnings.js'
