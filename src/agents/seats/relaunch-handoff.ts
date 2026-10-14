import { parseSeat, type HeartbeatSource } from './charter.js'
import { readSeatFile } from './teleport-state.js'
import { TELEPORT_LOOKBACK_DAYS, capText, latestTeleportSection, type TeleportSection } from './boot-read.js'

export const HANDOFF_CAP = 4_000

export const NO_TELEPORT_STATE = `none found in the last ${TELEPORT_LOOKBACK_DAYS} days`

/** CC-960: a relaunched seat registers and boots on its own; a confirmation question stalls it on the owner. */
export const BOOT_WITHOUT_CONFIRMATION = (seat: string): string =>
  `Register as ${seat} with chat_register, then boot fully: read the State at teleport, the inbox and ` +
  'the queue, then act. Do not ask the owner for confirmation before registering or booting.'

interface SeatHandoffInput {
  root: string
  seat: string
  /** The seat's latest `State at teleport` section and its journal day, or undefined when none was found. */
  found: TeleportSection | undefined
  /** CC-391: `watchdog` tells the successor the watchdog sends its ticks; unset reads the seat file. */
  heartbeatSource?: HeartbeatSource
}

export interface HandoffInput extends SeatHandoffInput {
  quietMinutes: number
}

export interface TeleportHandoffInput extends SeatHandoffInput {
  /** The msg_id the State block names as handled through. */
  after: string | undefined
  /** The seat's own block was kept but names no cursor that could be read. */
  cursorMissing?: boolean
  /** TP-1600 e: the state and inbox sections agent-chat composed, after the capped frame. */
  sections?: string[]
}

const seatHeartbeatSource = (root: string, seat: string): HeartbeatSource => {
  const file = readSeatFile(root, seat)
  return (file === undefined ? undefined : parseSeat(seat, file)?.heartbeatSource) ?? 'cron'
}

/** The two lines after the queue file: a cron seat's stay as they were before `heartbeat_source`. */
const heartbeatLines = (source: HeartbeatSource, queue: string, boot: string): string[] =>
  source === 'watchdog'
    ? [
        `and ${queue}, then the 'State at teleport N' below only.`,
        `Do not create a heartbeat cron: the seat watchdog sends your ticks (heartbeat_source: watchdog). ${boot}`,
      ]
    : [`and ${queue}, then the 'State at teleport N' below only. Recreate the`, `heartbeat first. ${boot}`]

/** Charter section 11 step 3, opened by `why` and capped so the first turn stays bounded. */
function renderSeatHandoff(why: string, boot: string, input: SeatHandoffInput, register: string): string {
  const { root, seat, found } = input
  const source = input.heartbeatSource ?? seatHeartbeatSource(root, seat)
  const text = [
    why,
    `Run the autonomy charter at @${root}/charter.md as seat ${seat}. Read @${root}/seats/${seat}.md`,
    ...heartbeatLines(source, `@${root}/queues/${seat}.md`, boot),
    register,
    `Latest State at teleport${found === undefined ? '' : ` (from logs/${seat}/${found.day}.md)`}:`,
    found?.section ?? NO_TELEPORT_STATE,
  ].join('\n')
  return capText(text, HANDOFF_CAP)
}

/** The handoff for a watchdog relaunch. */
export const renderRelaunchHandoff = (input: HandoffInput): string =>
  renderSeatHandoff(
    `Watchdog relaunch: ${input.seat} had no heartbeat for ${input.quietMinutes} min and no live session.`,
    `\`agent-chat seats boot ${input.seat}\` prints the same digest with your inbox.`,
    input,
    BOOT_WITHOUT_CONFIRMATION(input.seat),
  )

/** TP-1600 e: a teleport successor acts on what agent-chat composed rather than reading it again. */
export const ACT_WITHOUT_REVERIFY = (seat: string): string =>
  `Register as ${seat} with chat_register, then act on the first continuation below, or on the ` +
  'queue when it lists none. Do not ask the owner for confirmation before registering or acting.'

export const NO_REVERIFY =
  'Do not re-run seats boot, gh pr view or git status for anything the sections below list: ' +
  'agent-chat read them at the teleport.'

/** CC-863, TP-1600 e: the handoff for a seat's `agent_teleport`, then the state and inbox agent-chat composed. */
export function renderTeleportHandoff(input: TeleportHandoffInput): string {
  const frame = renderSeatHandoff(
    `Teleport: ${input.seat} handed off and ended; you are its successor. agent-chat wrote this ` +
      'prompt and the State block below from the seat event log, the roster, Shepherd, the pace ' +
      'file, the dispatch log and the broker inbox.',
    teleportBoot(input),
    input,
    ACT_WITHOUT_REVERIFY(input.seat),
  )
  const sections = input.sections ?? []
  return sections.length === 0 ? frame : `${frame}\n\n${sections.join('\n')}`
}

function teleportBoot({ cursorMissing }: TeleportHandoffInput): string {
  if (cursorMissing)
    return (
      'The State block below names no inbox cursor agent-chat could read, so the inbox section ' +
      `lists only the last messages: check them against the block. ${NO_REVERIFY}`
    )
  return NO_REVERIFY
}

/** The handoff for `seat`, reading its journals under `root`. */
export function buildRelaunchHandoff(root: string, seat: string, quietMinutes: number, now: Date): string {
  return renderRelaunchHandoff({ root, seat, quietMinutes, found: latestTeleportSection(root, seat, now) })
}
