import { randomBytes } from 'node:crypto'
import { compare, type Mismatch, type Records } from '../leak-guard/integrity/record.js'
import { SettingsWatch } from './settings-watch.js'

/**
 * TP-4256 (TP-4232 option R1), A3 redesign: the one place a launch is admitted and the one place
 * that answers whether an agent may act. A quarantine belongs to the agent principal, never to a
 * launch nonce, so a fresh nonce from a resume, mode switch or wake cannot launder it. Each
 * principal's parent is set on first admit and never changes; `verdict` walks self → parent → human
 * and anything it cannot resolve denies. Only an admit carrying `humanProof` clears.
 */

/** The parent of an agent a human started; every chain must end here to be allowed. */
export const HUMAN_ROOT: unique symbol = Symbol('human root')
export type Parent = string | typeof HUMAN_ROOT

/** Mismatch `file` for a quarantine of the chain itself rather than of a file on disk. */
export const LINEAGE = '<lineage>'

interface Quarantine {
  readonly mismatch: Mismatch
  readonly seq: number
}

export interface Principal {
  readonly parent: Parent
  readonly quarantine?: Quarantine
  readonly clearedAt?: number
}

export interface LaunchEntry {
  readonly agentId: string
  readonly startup: Records
  readonly sessions: Readonly<Record<string, Records>>
}

/** Memory only for now (persistence is an open owner decision); kept behind this seam so it can move. */
export interface IntegrityStore {
  principal(agentId: string): Principal | undefined
  putPrincipal(agentId: string, principal: Principal): void
  launch(nonce: string): LaunchEntry | undefined
  putLaunch(nonce: string, entry: LaunchEntry): void
}

export const memoryStore = (): IntegrityStore => {
  const principals = new Map<string, Principal>()
  const launches = new Map<string, LaunchEntry>()
  return {
    principal: agentId => principals.get(agentId),
    putPrincipal: (agentId, principal) => void principals.set(agentId, principal),
    launch: nonce => launches.get(nonce),
    putLaunch: (nonce, entry) => void launches.set(nonce, entry),
  }
}

const MINT = Symbol('integrity admission')

/** Proof that the ledger admitted a launch. Only `IntegrityLedger.admit` can construct one. */
export class LaunchAdmission {
  constructor(
    private readonly token: typeof MINT,
    readonly nonce: string,
    readonly agentId: string,
  ) {
    if (this.token !== MINT) throw new Error('integrity: a launch admission comes only from admit')
  }
}

export interface AdmitRequest {
  readonly agentId: string
  readonly parent: Parent
  /** Set only for a launch the broker proved a human asked for; it is the one way to clear. */
  readonly humanProof?: boolean
}

/** What the launcher wrote under the minted nonce: the startup record and every file to watch. */
export interface LaunchWrite {
  readonly startup: Records
  readonly files: readonly string[]
}

export type Verdict =
  | { ok: true }
  | { ok: false; reason: 'no baseline' }
  /** `principal` is the agent on the chain whose quarantine denies, which may be an ancestor. */
  | ({ ok: false; reason: 'quarantined'; principal: string } & Mismatch)

export type CheckResult = Verdict | ({ ok: false; reason: 'changed' } & Mismatch)

export type LatchOutcome = 'latched' | 'already' | 'unknown'

const NO_BASELINE = { ok: false, reason: 'no baseline' } as const

export class IntegrityLedger {
  /** Re-hashes every admitted launch's files; replaced per agent by `admit`, never edited elsewhere. */
  readonly watch = new SettingsWatch(this)
  private seq = 0

  constructor(
    private readonly onQuarantine: (agentId: string, mismatch: Mismatch) => void = () => undefined,
    private readonly store: IntegrityStore = memoryStore(),
  ) {}

  /** Sweep, enrol, clear, mint, write, record, re-watch: one synchronous call, in this order. */
  admit(req: AdmitRequest, write: (admission: LaunchAdmission) => LaunchWrite): LaunchAdmission {
    this.watch.sweepAgent(req.agentId)
    this.enrol(req.agentId, req.parent)
    if (req.humanProof === true) this.clear(req.agentId)
    const admission = new LaunchAdmission(MINT, randomBytes(32).toString('hex'), req.agentId)
    const { startup, files } = write(admission)
    this.store.putLaunch(admission.nonce, { agentId: req.agentId, startup, sessions: {} })
    this.watch.replace(req.agentId, files)
    return admission
  }

  /** Whether any admit enrolled `agentId`; a principal it knows is always answered by `verdict`. */
  knows(agentId: string): boolean {
    return this.store.principal(agentId) !== undefined
  }

  agentOf(nonce: string): string | undefined {
    return this.store.launch(nonce)?.agentId
  }

  /** Quarantines a principal; the owner hears of it once, on the latch that set it. */
  latch(agentId: string, mismatch: Mismatch): LatchOutcome {
    const principal = this.store.principal(agentId)
    if (principal === undefined) return 'unknown'
    if (active(principal, principal.clearedAt)) return 'already'
    this.store.putPrincipal(agentId, { ...principal, quarantine: { mismatch, seq: ++this.seq } })
    this.onQuarantine(agentId, mismatch)
    return 'latched'
  }

  /** The only read: denies if any principal from `agentId` up to the human root is quarantined. */
  verdict(agentId: string): Verdict {
    const self = this.store.principal(agentId)
    if (self === undefined) return NO_BASELINE
    const seen = new Set<string>()
    for (let id: Parent = agentId; id !== HUMAN_ROOT;) {
      const principal = this.store.principal(id)
      if (principal === undefined || seen.has(id)) return NO_BASELINE
      seen.add(id)
      const quarantine = active(principal, self.clearedAt)
      if (quarantine !== undefined)
        return { ok: false, reason: 'quarantined', principal: id, ...quarantine.mismatch }
      id = principal.parent
    }
    return { ok: true }
  }

  check(nonce: string, session: string, records: Records): CheckResult {
    const entry = this.store.launch(nonce)
    if (entry === undefined) return NO_BASELINE
    const verdict = this.verdict(entry.agentId)
    if (!verdict.ok) return verdict
    const base = entry.sessions[session]
    const mismatch =
      compare(entry.startup, records) ?? (base === undefined ? undefined : compare(base, records))
    if (mismatch !== undefined) {
      this.latch(entry.agentId, mismatch)
      return { ok: false, reason: 'changed', ...mismatch }
    }
    if (base === undefined)
      this.store.putLaunch(nonce, { ...entry, sessions: { ...entry.sessions, [session]: records } })
    return { ok: true }
  }

  /**
   * Creates the principal on first admit; its parent is write-once. A parent the ledger cannot
   * vouch for (unknown, or quarantined now) latches the child, so its own later admits stay denied
   * even once that parent is cleared.
   */
  private enrol(agentId: string, parent: Parent): void {
    const known = this.store.principal(agentId)
    if (known === undefined) this.store.putPrincipal(agentId, { parent })
    else if (known.parent !== parent) this.latch(agentId, { file: LINEAGE, field: 'parent changed' })
    const lineage = known?.parent ?? parent
    if (lineage === HUMAN_ROOT) return
    const upstream = this.verdict(lineage)
    if (!upstream.ok)
      this.latch(agentId, {
        file: LINEAGE,
        field: upstream.reason === 'no baseline' ? 'unknown parent' : 'quarantined parent',
      })
  }

  private clear(agentId: string): void {
    const principal = this.store.principal(agentId)
    if (principal !== undefined) this.store.putPrincipal(agentId, { ...principal, clearedAt: ++this.seq })
  }
}

/** A principal's quarantine, if it is newer than its own clear and than the asking agent's clear. */
function active(principal: Principal, askerClearedAt: number | undefined): Quarantine | undefined {
  const quarantine = principal.quarantine
  if (quarantine === undefined) return undefined
  const floor = Math.max(principal.clearedAt ?? 0, askerClearedAt ?? 0)
  return quarantine.seq > floor ? quarantine : undefined
}
