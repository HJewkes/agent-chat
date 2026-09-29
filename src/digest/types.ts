/** The morning digest's model: every section as plain data, rendered by `render.ts`. */

export interface QueueEntry {
  msgId: string
  kind: string
  from: string
  text: string
  at: number
  /** Slice 5's item kind on a notice (`ready-to-merge`, `needs-grant`, `stalled`), when set. */
  itemKind?: string
}

export type DecisionState = 'awaiting audit' | 'overruled' | 'accepted'

export interface DecidedEntry {
  questionId: string
  asker: string
  question: string
  answer: string
  by: string
  at: number
  class: string
  basis: string
  precedent: string
  state: DecisionState
}

export interface ClassReversal {
  class: string
  decided: number
  overruled: number
}

export type ReportStatus = 'BLOCKED' | 'NEEDS_CONTEXT'

export interface StatusReport {
  msgId: string
  from: string
  to: string
  at: number
  status: ReportStatus
  /** The line the status appears on, trimmed to one screen line. */
  line: string
}

/** CC-266: headless agents that exited with no Status report, grouped by UTC day and last action. */
export interface UnreportedExitGroup {
  day: string
  lastAction: string
  count: number
  agents: string[]
}

export interface LedgerFacts {
  /** False when events.db is missing or unreadable; every list below is then empty. */
  available: boolean
  escalations: QueueEntry[]
  /** Open notices with no item kind: counted, not listed. */
  otherNotices: number
  decided: DecidedEntry[]
  reversals: ClassReversal[]
  reports: StatusReport[]
  unreportedExits: UnreportedExitGroup[]
}

export interface DoneTask {
  id: string
  title: string
  initiative: string
  doneAt: string
  prs: string[]
}

export interface Reading {
  sevenDay?: number
  fiveHour?: number
  /** Epoch ms the status line wrote it. */
  writtenAt: number
}

export interface AccountSpend {
  account: string
  now?: Reading
  /** True when the freshest reading is too old to call current. */
  stale: boolean
  /** The newest reading written at or before the window's start. */
  then?: Reading
}

export interface StalledClaim {
  taskId: string
  initiative: string
  agentId: string
  phase: string
  phaseAt: string
}

export interface NamedItem {
  label: string
  detail: string
}

export interface NextPick {
  initiative: string
  task: string
  profile: string
  account: string
  reason: string
}

export interface Digest {
  generatedAt: number
  sinceMs: number
  ledger: LedgerFacts
  readyToMerge: NamedItem[]
  needsGrant: NamedItem[]
  done: DoneTask[]
  mergedPrs: NamedItem[]
  stalled: StalledClaim[]
  spend: AccountSpend[]
  next: { picks: NextPick[]; refused: number; notOptedIn: number; error?: string }
  /** Sources that could not be read, each a one-line reason; shown so a gap is never silent. */
  gaps: string[]
}
