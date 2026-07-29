/**
 * The concurrency budget, keyed by agent id.
 *
 * Non-blocking on purpose. brain's version queues callers, which suits a
 * dispatch loop that owns its own pace; here the caller is a spawn request
 * arriving over a socket, and making it wait would hold the broker's reply while
 * a slot maybe frees. A refusal a model can read and act on is better than a
 * request that silently hangs — so this answers immediately and the supervisor
 * appends `agent_spawn_refused`.
 *
 * Keyed rather than counted so release is idempotent: exit handling can fire
 * from a child's exit AND from the detach settle window, and a bare counter
 * would drift up a slot every time both ran.
 */

export const DEFAULT_SLOTS = 3

export class Semaphore {
  private readonly held = new Set<string>()

  constructor(readonly slots: number = DEFAULT_SLOTS) {}

  /**
   * Take a slot for `agentId`, or report there is none. Re-acquiring a slot the
   * same agent already holds succeeds without consuming a second one, so a
   * resume of a live agent cannot leak.
   */
  acquire(agentId: string): boolean {
    if (this.held.has(agentId)) return true
    if (this.held.size >= this.slots) return false
    this.held.add(agentId)
    return true
  }

  release(agentId: string): void {
    this.held.delete(agentId)
  }

  has(agentId: string): boolean {
    return this.held.has(agentId)
  }

  get inUse(): number {
    return this.held.size
  }

  get available(): number {
    return Math.max(0, this.slots - this.held.size)
  }

  ids(): string[] {
    return [...this.held]
  }

  /**
   * "3/3 slots (1 blocked)" for `agent ls`.
   *
   * A blocked agent keeps its slot — it still owns its worktree and is resumable
   * in place, so releasing it would let a second agent allocate over the top.
   * That genuinely starves the budget, and the mitigation is saying so on screen
   * rather than evicting: "why can't I spawn" should have its answer visible.
   */
  summary(blocked = 0): string {
    const base = `${this.held.size}/${this.slots} slots`
    return blocked > 0 ? `${base} (${blocked} blocked)` : base
  }
}
