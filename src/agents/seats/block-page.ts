import type { OpenBlock } from '../../seat-blocks.js'
import type { Roster, WakeResult } from './run.js'

/** CC-1057: a seat waiting on its own AskUserQuestion longer than this pages the operator. */
export const BLOCK_PAGE_AFTER_MS = 5 * 60_000
export const BLOCK_PAGE_TO = 'tp-operator'

const LIVE_STATES = ['spawning', 'live', 'detached']

export const blockKey = (block: OpenBlock): string => `${block.sessionId}@${block.since}`

const SAFE_TOKEN = /^[A-Za-z0-9._-]+$/

/** The hook writes seat and session unchecked, so only plain tokens may reach the page text. */
export const safeBlock = (block: OpenBlock): boolean =>
  SAFE_TOKEN.test(block.seat) && SAFE_TOKEN.test(block.sessionId)

/**
 * A block counts only while its seat's roster row is live on exactly the same session. An unreadable
 * roster, or a row with no sessionId, pages nothing: the block row is agent-written and unverifiable.
 */
export function blockLive(roster: Roster, block: OpenBlock): boolean {
  if (roster.unknown !== undefined) return false
  return roster.agents.some(
    agent =>
      agent.name === block.seat &&
      LIVE_STATES.includes(agent.state) &&
      agent.sessionId !== undefined &&
      agent.sessionId === block.sessionId,
  )
}

export interface PagePick {
  page: OpenBlock[]
  /** The paged keys whose blocks are still open; a closed block's key is dropped. */
  keep: string[]
}

export function pickPages(
  open: OpenBlock[],
  paged: string[],
  isLive: (block: OpenBlock) => boolean,
  nowMs: number,
  seats?: string[],
): PagePick {
  const openKeys = new Set(open.map(blockKey))
  const keep = paged.filter(key => openKeys.has(key))
  const page = open.filter(
    block =>
      nowMs - block.since > BLOCK_PAGE_AFTER_MS &&
      !keep.includes(blockKey(block)) &&
      (seats === undefined || seats.includes(block.seat)) &&
      isLive(block),
  )
  return { page, keep }
}

const hhmm = (at: number): string => new Date(at).toISOString().slice(11, 16) + 'Z'

export function pageText(block: OpenBlock, nowMs: number): string {
  const minutes = Math.floor((nowMs - block.since) / 60_000)
  return (
    `Seat ${block.seat} has been blocked on AskUserQuestion since ${hhmm(block.since)} ` +
    `(${minutes} min), session ${block.sessionId}. Answer it in that seat's pane.`
  )
}

export interface BlockPageInput {
  /** Undefined when events.db cannot be read: nothing is paged and the paged keys are kept. */
  open: OpenBlock[] | undefined
  paged: string[]
  isLive: (block: OpenBlock) => boolean
  nowMs: number
  seats?: string[]
  dryRun: boolean
  page: (to: string, text: string) => Promise<WakeResult>
}

/** Sends each new page; a key is kept only once its page was delivered, so a failed send retries next pass. */
export async function blockPageChange(input: BlockPageInput): Promise<{ lines: string[]; paged: string[] }> {
  if (input.open === undefined) return { lines: [], paged: input.paged }
  const { page, keep } = pickPages(input.open, input.paged, input.isLive, input.nowMs, input.seats)
  const lines: string[] = []
  for (const block of page) {
    if (!safeBlock(block)) {
      lines.push(
        `refused to page: block row with an unsafe seat or session (${JSON.stringify(block.seat).slice(0, 60)})`,
      )
      continue
    }
    const text = pageText(block, input.nowMs)
    if (input.dryRun) {
      lines.push(`would page ${BLOCK_PAGE_TO}: ${text}`)
      continue
    }
    const sent = await input.page(BLOCK_PAGE_TO, text)
    lines.push(`paged ${BLOCK_PAGE_TO}: ${text}${sent.ok ? '' : ` (not delivered: ${sent.detail})`}`)
    if (sent.ok) keep.push(blockKey(block))
  }
  return { lines, paged: keep }
}
