import { countVerdict } from './explain.js'
import type { Count, CountItem, Verdict } from './types.js'

/** CC-1282 (K2): `counts --check` lines and exit status from K1's `Count[]`. Pure. */

export const COUNTS_EXIT = { agree: 0, unexplained: 1, unread: 2 } as const
export type CountsExit = (typeof COUNTS_EXIT)[keyof typeof COUNTS_EXIT]

/** 2 when any reader failed, else 1 when any item is unexplained, else 0: an unread count never passes as agreeing. */
export function countsExit(counts: Count[]): CountsExit {
  const verdicts = counts.map(countVerdict)
  if (verdicts.includes('unread')) return COUNTS_EXIT.unread
  if (verdicts.includes('unexplained')) return COUNTS_EXIT.unexplained
  return COUNTS_EXIT.agree
}

export function renderCounts(counts: Count[], now: Date): string[] {
  return counts.flatMap(count => [headLine(count), ...itemLines(count.items, now)])
}

const scope = (count: Count): string =>
  [
    count.seat === undefined ? '' : ` seat ${count.seat}`,
    count.repo === undefined ? '' : ` repo ${count.repo}`,
  ].join('')

const HEAD_VERDICT: Record<ReturnType<typeof countVerdict>, string> = {
  agree: 'agree',
  explained: 'explained',
  unexplained: 'UNEXPLAINED',
  unread: 'unread',
}

function headLine(count: Count): string {
  const live =
    count.live === undefined ? 'live unread' : `live ${count.live.value} (${count.live.derivation})`
  const shown = count.shown.map(s => `${s.surface} ${s.value}`)
  return [`${count.id}${scope(count)}: ${live}`, ...shown, HEAD_VERDICT[countVerdict(count)]].join(' · ')
}

/** Every item but the agreeing ones, each naming its verdict, so a line never hides what it explains. */
const itemLines = (items: CountItem[], now: Date): string[] =>
  items
    .filter(item => item.verdict.kind !== 'agree')
    .map(item => `  ${itemText(item.key, item.verdict, now)}`)

function itemText(key: string, verdict: Verdict, now: Date): string {
  switch (verdict.kind) {
    case 'agree':
      return `agree: ${key}`
    case 'explained':
      return `explained: ${verdict.code} ${key} (${age(verdict.since, now)})`
    case 'unexplained':
      return `UNEXPLAINED: ${key} (${verdict.why})`
    case 'unread':
      return `unread: ${key} (${verdict.why})`
  }
}

export function age(since: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(since)) / 60_000))
  if (Number.isNaN(minutes)) return 'age unknown'
  return minutes < 60
    ? `${minutes}m`
    : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}
