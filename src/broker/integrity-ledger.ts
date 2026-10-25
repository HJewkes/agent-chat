import { compare, type Mismatch, type Records } from '../leak-guard/integrity/record.js'

/**
 * TP-4256 (TP-4232 option R1): the broker's record of the files a later shell sources, per launch
 * nonce. The launcher registers the startup record in-process; the first check per session stores
 * that session's record. Nothing is ever overwritten or cleared: a mismatch quarantines the nonce
 * for good, and only `agent-chat agent resume`, which mints a new nonce, starts a fresh baseline.
 */

export interface LaunchEntry {
  readonly agentId: string
  readonly startup: Records
  readonly sessions: Readonly<Record<string, Records>>
  readonly quarantine?: Mismatch
}

/** Memory only for now (persistence is an open owner decision); kept behind this seam so it can move. */
export interface IntegrityStore {
  get(nonce: string): LaunchEntry | undefined
  put(nonce: string, entry: LaunchEntry): void
}

export const memoryStore = (): IntegrityStore => {
  const entries = new Map<string, LaunchEntry>()
  return { get: nonce => entries.get(nonce), put: (nonce, entry) => void entries.set(nonce, entry) }
}

export type CheckResult =
  | { ok: true }
  | { ok: false; reason: 'no baseline' }
  /** `latched` is true only on the check that quarantined the nonce, so the caller notifies once. */
  | ({ ok: false; reason: 'changed' | 'quarantined'; latched: boolean } & Mismatch)

export class IntegrityLedger {
  constructor(private readonly store: IntegrityStore = memoryStore()) {}

  registerLaunch(nonce: string, agentId: string, startup: Records): void {
    if (this.store.get(nonce) !== undefined) throw new Error(`integrity nonce already registered`)
    this.store.put(nonce, { agentId, startup, sessions: {} })
  }

  agentOf(nonce: string): string | undefined {
    return this.store.get(nonce)?.agentId
  }

  /** Quarantines a nonce for a change the hook cannot see (its own settings file); true only on the first latch. */
  latch(nonce: string, mismatch: Mismatch): boolean {
    const entry = this.store.get(nonce)
    if (entry === undefined || entry.quarantine !== undefined) return false
    this.store.put(nonce, { ...entry, quarantine: mismatch })
    return true
  }

  check(nonce: string, session: string, records: Records): CheckResult {
    const entry = this.store.get(nonce)
    if (entry === undefined) return { ok: false, reason: 'no baseline' }
    if (entry.quarantine !== undefined)
      return { ok: false, reason: 'quarantined', latched: false, ...entry.quarantine }
    const base = entry.sessions[session]
    const mismatch =
      compare(entry.startup, records) ?? (base === undefined ? undefined : compare(base, records))
    if (mismatch !== undefined) {
      this.store.put(nonce, { ...entry, quarantine: mismatch })
      return { ok: false, reason: 'changed', latched: true, ...mismatch }
    }
    if (base === undefined)
      this.store.put(nonce, { ...entry, sessions: { ...entry.sessions, [session]: records } })
    return { ok: true }
  }
}
