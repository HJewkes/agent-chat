import { HUMAN } from '../protocol.js'
import { contextTokens, type BudgetRead } from './budget.js'

/**
 * CC-290 b: whether `agent ls` marks an agent retire-due. Past its role's threshold
 * alone is not enough: an agent mid-task that is retired loses its work, so it is
 * due only once it has sent its Status or Verdict report.
 */

export interface RetireReading {
  /** Thousands of context tokens; null without a reading. */
  contextK: number | null
  /** The role's threshold in thousands; null when the profile names no hinted role. */
  retireK: number | null
}

export const contextKOf = (read: BudgetRead): number | null => {
  if (!read.found) return null
  const tokens = contextTokens(read.budget.context)
  return tokens === undefined ? null : Math.round(tokens / 1000)
}

export const pastThreshold = ({ contextK, retireK }: RetireReading): boolean =>
  contextK !== null && retireK !== null && contextK > retireK

export const retireDue = (reading: RetireReading, reported: boolean): boolean =>
  reported && pastThreshold(reading)

/** `ctx=212k/200k retire-due`; empty without a reading, and no `/k` without a threshold. */
export function retireCell(reading: RetireReading, due: boolean): string {
  if (reading.contextK === null) return ''
  const limit = reading.retireK === null ? '' : `/${reading.retireK}k`
  return `ctx=${reading.contextK}k${limit}${due ? ' retire-due' : ''}`
}

/** Burndown spawns as the human but its agents report to `tick.reportTo` (CC-266), so both count. */
export const reportTargets = (spawnedBy: string, reportTo: string | undefined): string[] =>
  spawnedBy === HUMAN && reportTo !== undefined ? [HUMAN, reportTo] : [spawnedBy]
