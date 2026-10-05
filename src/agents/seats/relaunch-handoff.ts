import { TELEPORT_LOOKBACK_DAYS, capText, latestTeleportSection, type TeleportSection } from './boot-read.js'

export const HANDOFF_CAP = 4_000

export const NO_TELEPORT_STATE = `none found in the last ${TELEPORT_LOOKBACK_DAYS} days`

export interface HandoffInput {
  root: string
  seat: string
  quietMinutes: number
  /** The seat's latest `State at teleport` section and its journal day, or undefined when none was found. */
  found: TeleportSection | undefined
}

/** Charter section 11 step 3 for a watchdog relaunch, capped so the resume message stays bounded. */
export function renderRelaunchHandoff({ root, seat, quietMinutes, found }: HandoffInput): string {
  const text = [
    `Watchdog relaunch: ${seat} had no heartbeat for ${quietMinutes} min and no live session.`,
    `Run the autonomy charter at @${root}/charter.md as seat ${seat}. Read @${root}/seats/${seat}.md`,
    `and @${root}/queues/${seat}.md, then the 'State at teleport N' below only. Recreate the`,
    `heartbeat first. \`agent-chat seats boot ${seat}\` prints the same digest with your inbox.`,
    `Latest State at teleport${found === undefined ? '' : ` (from logs/${seat}/${found.day}.md)`}:`,
    found?.section ?? NO_TELEPORT_STATE,
  ].join('\n')
  return capText(text, HANDOFF_CAP)
}

/** The handoff for `seat`, reading its journals under `root`. */
export function buildRelaunchHandoff(root: string, seat: string, quietMinutes: number, now: Date): string {
  return renderRelaunchHandoff({ root, seat, quietMinutes, found: latestTeleportSection(root, seat, now) })
}
