import type { TranscriptSpendRead } from '../transcript-spend.js'

/** CC-722: a claim's summed transcript spend and the pure verdict against a seat's `spend.per_claim_usd`. */

export interface ClaimSpend {
  /** The sum of the priced reads: a lower bound whenever `unknown` is not empty. */
  usd: number
  tokens: number
  agents: number
  /** The path of every read that is not ok or has no price. */
  unknown: string[]
}

export type CapVerdict = 'over' | 'under' | 'unknown'

const usdPlaces = 1e4

export function sumSpend(reads: TranscriptSpendRead[]): ClaimSpend {
  const spend: ClaimSpend = { usd: 0, tokens: 0, agents: reads.length, unknown: [] }
  for (const read of reads) {
    if (!read.ok) {
      spend.unknown.push(read.path)
      continue
    }
    spend.tokens += read.tokens
    if (read.usd_est === null) spend.unknown.push(read.path)
    else spend.usd += read.usd_est
  }
  spend.usd = Math.round(spend.usd * usdPlaces) / usdPlaces
  return spend
}

/** Spend only grows, so a known sum at the cap is over whatever the unknown reads hold. */
export function capVerdict(spend: ClaimSpend, cap: number): CapVerdict {
  if (spend.usd >= cap) return 'over'
  return spend.unknown.length > 0 ? 'unknown' : 'under'
}
