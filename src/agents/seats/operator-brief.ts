import type { AgentIdentity, QueueItem } from '../../protocol.js'
import { roleOfProfile, type AgentRole } from './agent-rows.js'
import { BLOCK_PAGE_TO } from './block-page.js'
import { branchOfSeat, type ShepherdFlight } from './in-flight-read.js'
import type { ShepherdWaiting, WaitingGate } from './shepherd-waiting.js'
import { ownedBy, type AccountPace, type InboxReading } from './status.js'

/**
 * CC-1551: what a coordinator re-read after every action (roster, inbox, Shepherd rows and gates, pools,
 * burndown, the owner queue), joined per seat in one pure step. Every source arrives already read; an
 * absent one is listed under `unavailable` by the reader and contributes nothing here.
 */

/** A seat block's text, header included, before the overflow folds into `+N more (--json)`. */
export const SEAT_LINES = 8
/** The text brief's default height; `--json` is never cut. */
export const MAX_LINES = 60

export interface BriefSeat {
  name: string
  prefix: string | undefined
  /** Null for a seat the charter does not list, such as the operator. */
  caps: { implementer: number; reviewer: number } | null
}

export interface BurndownState {
  pausedSince: string | null
  lastTick: string | null
}

export interface BriefUnavailable {
  source: string
  reason: string
}

export interface OperatorBriefInput {
  now: Date
  /** Every coordinator seat: a run is attributed against all of them, whichever blocks are shown. */
  seats: BriefSeat[]
  /** The seats whose blocks are shown; all of them when absent. */
  show?: string[]
  roster?: AgentIdentity[] | undefined
  inbox?: Record<string, InboxReading> | undefined
  shepherd?: ShepherdFlight[] | undefined
  waiting?: ShepherdWaiting | undefined
  queue?: QueueItem[] | undefined
  pools?: AccountPace[] | undefined
  machineStop?: string | null | undefined
  paceAgeSeconds?: number | null | undefined
  burndown?: BurndownState | undefined
  /** Task status by the task id Shepherd names, such as `init/T-1`. */
  taskStatus?: Record<string, string> | undefined
  unavailable: BriefUnavailable[]
}

export interface BriefPr {
  pr: string
  head: string | null
  phase: string
  pendingGate: string | null
  gateAgeHours: number | null
  held: boolean
  stalled: boolean
  implementer: string | null
  task: string | null
  taskStatus: string | null
  nextAction: string | null
  /** Owned by no seat's implementer or branch prefix, so filed under the operator. */
  inherited: boolean
  actionable: boolean
}

export interface BriefGate {
  pr: string
  stepId: string
  ageHours: number
  held: boolean
}

export interface RoleCount {
  active: number
  cap: number | null
}

export interface SeatBlock {
  seat: string
  implementers: RoleCount
  reviewers: RoleCount
  unread: number | null
  sinceLastSend: string | null
  live: string[]
  /** Newest first: the seat's agents that exited after its last send. */
  finished: string[]
  prs: BriefPr[]
  seatGates: BriefGate[]
}

export interface BriefHeader {
  pools: AccountPace[] | null
  machineStop: string | null
  paceAgeSeconds: number | null
  burndown: BurndownState | null
  /** Open questions in the human queue; its notices and endorse requests are not counted. */
  ownerQuestions: number | null
  ownerGates: BriefGate[] | null
}

export interface OperatorBrief {
  at: string
  header: BriefHeader
  seats: SeatBlock[]
  unavailable: BriefUnavailable[]
}

const HOUR_MS = 3_600_000
const hoursSince = (iso: string, now: Date): number =>
  Math.round(((now.getTime() - Date.parse(iso)) / HOUR_MS) * 10) / 10

const prRef = (repo: string, pr: number): string => `${repo}#${pr}`
const prKey = (ref: string): string => ref.toLowerCase()
const ended = (a: AgentIdentity): boolean => a.state === 'exited' || a.state === 'retired'
const prefixed = (name: string | null, prefix: string): boolean =>
  name !== null && name.startsWith(`${prefix}-`)

/** The seat whose prefix starts the implementer, else the branch's; null when neither names a seat. */
export function ownerOfRow(
  row: Pick<ShepherdFlight, 'branch' | 'implementer'>,
  seats: BriefSeat[],
): string | null {
  const named = seats.flatMap(s => (s.prefix === undefined ? [] : [{ name: s.name, prefix: s.prefix }]))
  const owner =
    named.find(s => prefixed(row.implementer, s.prefix)) ??
    named.find(s => branchOfSeat(row.branch, s.prefix))
  return owner?.name ?? null
}

/** A PR earns its own line when someone must act on it; the rest fold into the quiet count. */
export const actionable = (row: ShepherdFlight): boolean =>
  row.pendingGate !== null || row.phase === 'fixing' || row.phase === 'unknown' || row.held || row.stalled

function briefPr(row: ShepherdFlight, inherited: boolean, input: OperatorBriefInput): BriefPr {
  return {
    pr: prRef(row.repo, row.pr as number),
    head: row.headSha,
    phase: row.phase,
    pendingGate: row.pendingGate,
    gateAgeHours: row.gateSince === null ? null : hoursSince(row.gateSince, input.now),
    held: row.held,
    stalled: row.stalled,
    implementer: row.implementer,
    task: row.task,
    taskStatus: row.task === null ? null : (input.taskStatus?.[row.task] ?? null),
    nextAction: row.nextAction,
    inherited,
    actionable: actionable(row),
  }
}

/** Every run with a PR, under the seat that owns it; an unowned run goes to the operator as inherited. */
function prsBySeat(input: OperatorBriefInput): Map<string, BriefPr[]> {
  const bySeat = new Map<string, BriefPr[]>()
  for (const row of input.shepherd ?? []) {
    if (row.pr === null) continue
    const owner = ownerOfRow(row, input.seats)
    const seat = owner ?? BLOCK_PAGE_TO
    bySeat.set(seat, [...(bySeat.get(seat) ?? []), briefPr(row, owner === null, input)])
  }
  return bySeat
}

const briefGate = (g: WaitingGate): BriefGate => ({
  pr: prRef(g.repo, g.pr),
  stepId: g.stepId,
  ageHours: g.ageHours,
  held: g.held,
})

/** A seat gate belongs to the seat that owns its PR's run; one with no run here goes to the operator. */
function seatGatesBySeat(input: OperatorBriefInput, prs: Map<string, BriefPr[]>): Map<string, BriefGate[]> {
  const ownerOfPr = new Map([...prs].flatMap(([seat, rows]) => rows.map(p => [prKey(p.pr), seat] as const)))
  const bySeat = new Map<string, BriefGate[]>()
  for (const g of input.waiting?.seat ?? []) {
    const gate = briefGate(g)
    const seat = ownerOfPr.get(prKey(gate.pr)) ?? BLOCK_PAGE_TO
    bySeat.set(seat, [...(bySeat.get(seat) ?? []), gate])
  }
  return bySeat
}

function roleCount(agents: AgentIdentity[], role: AgentRole, cap: number | undefined): RoleCount {
  const active = agents.filter(a => !ended(a) && roleOfProfile(a.profile) === role).length
  return { active, cap: cap ?? null }
}

/** Exited strictly after the seat's last send; a seat that never sent has seen none of them. */
function finishedSince(agents: AgentIdentity[], sinceLastSend: string | null): string[] {
  const cutoff = sinceLastSend === null ? -Infinity : Date.parse(sinceLastSend)
  return agents
    .filter(a => ended(a) && a.exitedAt !== undefined && a.exitedAt > cutoff)
    .sort((x, y) => (y.exitedAt ?? 0) - (x.exitedAt ?? 0))
    .map(a => a.name)
}

function seatBlock(
  seat: BriefSeat,
  input: OperatorBriefInput,
  prs: Map<string, BriefPr[]>,
  gates: Map<string, BriefGate[]>,
): SeatBlock {
  const agents = ownedBy(input.roster ?? [], seat.name, seat.prefix)
  const inbox = input.inbox?.[seat.name]
  const sinceLastSend = inbox?.sinceLastSend ?? null
  return {
    seat: seat.name,
    implementers: roleCount(agents, 'implementer', seat.caps?.implementer),
    reviewers: roleCount(agents, 'reviewer', seat.caps?.reviewer),
    unread: inbox?.unread ?? null,
    sinceLastSend,
    live: agents
      .filter(a => !ended(a))
      .map(a => a.name)
      .sort(),
    finished: finishedSince(agents, sinceLastSend),
    prs: prs.get(seat.name) ?? [],
    seatGates: gates.get(seat.name) ?? [],
  }
}

function header(input: OperatorBriefInput): BriefHeader {
  return {
    pools: input.pools ?? null,
    machineStop: input.machineStop ?? null,
    paceAgeSeconds: input.paceAgeSeconds ?? null,
    burndown: input.burndown ?? null,
    ownerQuestions: input.queue === undefined ? null : input.queue.filter(i => i.kind === 'question').length,
    ownerGates: input.waiting === undefined ? null : input.waiting.owner.map(briefGate),
  }
}

export function deriveOperatorBrief(input: OperatorBriefInput): OperatorBrief {
  const prs = prsBySeat(input)
  const gates = seatGatesBySeat(input, prs)
  const shown = input.seats.filter(s => input.show === undefined || input.show.includes(s.name))
  return {
    at: input.now.toISOString(),
    header: header(input),
    seats: shown.map(s => seatBlock(s, input, prs, gates)),
    unavailable: input.unavailable,
  }
}

/** What the renderer may cut, in the order it cuts: quiet counts, then finished agents, then the rest. */
type LineKind = 'keep' | 'quiet' | 'finished' | 'body'

interface Line {
  text: string
  kind: LineKind
}

const minute = (iso: string): string => `${iso.slice(0, 16)}Z`
const stamp = (iso: string): string => `${iso.slice(5, 10)} ${iso.slice(11, 16)}Z`
const clock = (iso: string): string => `${iso.slice(11, 16)}Z`
const short = (sha: string | null): string => (sha === null ? '?' : sha.slice(0, 8))
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()
const or = <T>(v: T | null, show: (v: T) => string): string => (v === null ? '?' : show(v))

function poolsLine(h: BriefHeader): string {
  const pools = or(h.pools, rows =>
    rows.length === 0 ? 'none' : rows.map(p => `${p.pool} ${p.sevenDay ?? '?'}%/7d (${p.level})`).join(' · '),
  )
  const pace = or(h.paceAgeSeconds, s => `${Math.floor(s / 60)}m`)
  return `pools: ${pools} · stop ${h.machineStop ?? 'none'} · pace.json ${pace}`
}

function burndownLine(b: BurndownState | null): string {
  if (b === null) return 'burndown: ?'
  const state = b.pausedSince === null ? 'running' : `paused since ${stamp(b.pausedSince)}`
  return `burndown: ${state} · last tick ${b.lastTick === null ? 'none' : stamp(b.lastTick)}`
}

function ownerLine(h: BriefHeader): string {
  const gates = or(h.ownerGates, list => {
    const oldest = [...list].sort((x, y) => y.ageHours - x.ageHours)[0]
    return oldest === undefined
      ? '0 gates'
      : `${list.length} gates (oldest ${oldest.ageHours}h ${oldest.pr} ${oldest.stepId})`
  })
  return `owner: ${or(h.ownerQuestions, n => `${n} questions`)} · ${gates}`
}

function headerLines(brief: OperatorBrief): Line[] {
  const h = brief.header
  return [
    `operator-brief ${minute(brief.at)}`,
    poolsLine(h),
    burndownLine(h.burndown),
    ownerLine(h),
    ...brief.unavailable.map(u => `unavailable: ${u.source} (${oneLine(u.reason)})`),
  ].map(text => ({ text, kind: 'keep' }))
}

const roleText = (label: string, r: RoleCount): string => `${label} ${r.active}/${r.cap ?? 'n/a'}`

function seatHead(b: SeatBlock): string {
  const since = b.sinceLastSend === null ? '' : ` since ${clock(b.sinceLastSend)}`
  return [
    `== ${b.seat}  ${roleText('impl', b.implementers)} ${roleText('rev', b.reviewers)}`,
    `unread ${b.unread ?? '?'}`,
    `finished ${b.finished.length}${since}`,
  ].join(' · ')
}

function prLine(p: BriefPr): string {
  const gate = p.pendingGate === null ? [] : [`gate ${p.pendingGate}${or(p.gateAgeHours, h => ` ${h}h`)}`]
  const flags = [...(p.held ? ['held'] : []), ...(p.stalled ? ['stalled'] : [])]
  const inherited = p.inherited ? ['(inherited)'] : []
  return ['  pr', p.pr, short(p.head), p.phase, ...gate, ...flags, ...inherited].join(' ')
}

function quietLine(prs: BriefPr[]): Line[] {
  const counts = new Map<string, number>()
  for (const p of prs) counts.set(p.phase, (counts.get(p.phase) ?? 0) + 1)
  if (counts.size === 0) return []
  const text = [...counts].map(([phase, n]) => `${n} ${phase}`).join(', ')
  return [{ text: `  quiet: ${text}`, kind: 'quiet' }]
}

function seatLines(b: SeatBlock): Line[] {
  const gates = b.seatGates.map(g => `${g.pr} ${g.stepId} ${g.ageHours}h${g.held ? ' held' : ''}`)
  const fixed: Line[] = [
    { text: seatHead(b), kind: 'keep' },
    ...(b.live.length === 0 ? [] : [{ text: `  live: ${b.live.join(', ')}`, kind: 'body' as const }]),
    ...(b.finished.length === 0
      ? []
      : [{ text: `  finished: ${b.finished.join(', ')}`, kind: 'finished' as const }]),
    ...(gates.length === 0 ? [] : [{ text: `  gates(seat): ${gates.join(', ')}`, kind: 'body' as const }]),
  ]
  const quiet = quietLine(b.prs.filter(p => !p.actionable))
  const loud = b.prs.filter(p => p.actionable).map(prLine)
  const room = SEAT_LINES - fixed.length - quiet.length
  const shown =
    loud.length <= room ? loud : [...loud.slice(0, room - 1), `  +${loud.length - room + 1} more (--json)`]
  return [...fixed, ...shown.map(text => ({ text, kind: 'body' as const })), ...quiet]
}

/** Cuts the last line of each kind in turn until the brief, with its cut note, fits; `keep` lines stay. */
function fit(lines: Line[], maxLines: number): string[] {
  if (lines.length <= maxLines) return lines.map(l => l.text)
  const out = [...lines]
  let cut = 0
  for (const kind of ['quiet', 'finished', 'body'] as const) {
    for (let i = out.length - 1; i >= 0 && out.length > maxLines - 1; i--) {
      if (out[i]?.kind !== kind) continue
      out.splice(i, 1)
      cut++
    }
  }
  return [...out.map(l => l.text), `cut ${cut} lines to fit ${maxLines} (--json has all)`]
}

export function renderOperatorBrief(brief: OperatorBrief, opts: { maxLines?: number } = {}): string[] {
  const lines = [...headerLines(brief), ...brief.seats.flatMap(seatLines)]
  return fit(lines, opts.maxLines ?? MAX_LINES)
}
