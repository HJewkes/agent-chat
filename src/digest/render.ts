import type { AccountSpend, Digest, NamedItem, QueueEntry, Reading } from './types.js'

/** Renders a collected digest as terminal text or markdown; the six sections of design section 8, empty ones named once at the end. */

export type Format = 'text' | 'markdown'

interface Style {
  heading: (title: string) => string
  cmd: (command: string) => string
}

const STYLES: Record<Format, Style> = {
  text: { heading: t => `== ${t}`, cmd: c => c },
  markdown: { heading: t => `## ${t}`, cmd: c => `\`${c}\`` },
}

const LABEL: Record<string, string> = {
  question: 'ASK',
  approval_request: 'APPROVE',
  endorse_request: 'ENDORSE',
  notice: 'NOTICE',
}

export const agoFrom = (now: number, at: number): string => {
  const ms = Math.max(0, now - at)
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  if (ms < 172_800_000) return `${Math.round(ms / 3_600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}

const oneLine = (text: string, max = 100): string => {
  const first = text.trim().split('\n')[0] ?? ''
  return first.length > max ? `${first.slice(0, max - 3)}...` : first
}

interface Section {
  title: string
  lines: string[]
}

function needsYou(d: Digest, s: Style): Section {
  const lines: string[] = []
  let n = 0
  const escalation = (e: QueueEntry): void => {
    const label =
      e.itemKind === undefined ? (LABEL[e.kind] ?? e.kind) : `${LABEL[e.kind] ?? e.kind} ${e.itemKind}`
    lines.push(
      `${++n}. [${label}] ${e.msgId} from ${e.from}, ${agoFrom(d.generatedAt, e.at)}: ${oneLine(e.text)}`,
    )
  }
  const named = (heading: string, items: NamedItem[]): void => {
    if (items.length === 0) return
    lines.push(`${heading}:`)
    for (const item of items) lines.push(`${++n}. ${item.label}: ${oneLine(item.detail)}`)
  }
  d.ledger.escalations.forEach(escalation)
  if (d.ledger.escalations.length > 0)
    lines.push(`reply with ${s.cmd('agent-chat answer <id> "..."')} or ${s.cmd('agent-chat dismiss <id>')}`)
  named('Ready to merge', d.readyToMerge)
  named('Needs a grant in the brief', d.needsGrant)
  if (d.ledger.otherNotices > 0)
    lines.push(`plus ${d.ledger.otherNotices} open notices: ${s.cmd('agent-chat inbox')}`)
  return { title: `Needs you (${n})`, lines }
}

function decided(d: Digest, s: Style): Section {
  const lines: string[] = []
  for (const e of d.ledger.decided) {
    lines.push(
      `- ${e.questionId} for ${e.asker}, ${agoFrom(d.generatedAt, e.at)} by ${e.by} [${e.class}, ${e.basis}] ${e.state}`,
    )
    lines.push(`  Q: ${oneLine(e.question)}`, `  A: ${oneLine(e.answer)}`, `  cites: ${oneLine(e.precedent)}`)
    if (e.state === 'awaiting audit')
      lines.push(`  overrule: ${s.cmd(`agent-chat answer ${e.questionId} "..."`)}`)
  }
  if (lines.length > 0 && d.ledger.reversals.length > 0) {
    const rates = d.ledger.reversals.map(
      r => `${r.class} ${r.overruled}/${r.decided} (${Math.round((100 * r.overruled) / r.decided)}%)`,
    )
    lines.push(`reversal rate, last 7 days: ${rates.join(', ')}`)
  }
  return { title: `Decided while you were away (${d.ledger.decided.length})`, lines }
}

function done(d: Digest): Section {
  const lines = d.done.map(t => {
    const prs = t.prs.length === 0 ? '' : ` ${t.prs.join(' ')}`
    return `- ${t.id} ${oneLine(t.title, 80)} (${t.initiative}, ${t.doneAt})${prs}`
  })
  for (const pr of d.mergedPrs) lines.push(`- merged ${pr.label}: ${oneLine(pr.detail, 80)}`)
  return { title: `Done (${d.done.length} tasks, ${d.mergedPrs.length} merged PRs)`, lines }
}

function stalled(d: Digest): Section {
  const lines = d.stalled.map(
    c =>
      `- ${c.taskId} (${c.initiative}) ${c.agentId} in ${c.phase} since ${c.phaseAt}, past its phase timeout`,
  )
  for (const r of d.ledger.reports)
    lines.push(`- ${r.status} ${r.from} to ${r.to}, ${agoFrom(d.generatedAt, r.at)}: ${r.line}`)
  return { title: `Stalled or failed (${lines.length})`, lines }
}

const pct = (value: number | undefined): string => (value === undefined ? '?' : `${Math.round(value)}%`)

const windows = (r: Reading): string => `seven_day ${pct(r.sevenDay)}, five_hour ${pct(r.fiveHour)}`

function spendLine(a: AccountSpend, d: Digest): string {
  const since = agoFrom(d.generatedAt, d.sinceMs)
  if (a.now === undefined) return `- ${a.account}: no reading at all`
  const read = `read ${agoFrom(d.generatedAt, a.now.writtenAt)}`
  const current = a.stale ? `STALE, ${read}: ${windows(a.now)}` : `now ${windows(a.now)} (${read})`
  const then =
    a.then === undefined
      ? `no reading from ${since}`
      : a.then.writtenAt === a.now.writtenAt
        ? 'no newer reading since'
        : `${since}: ${windows(a.then)} (read ${agoFrom(d.generatedAt, a.then.writtenAt)})`
  return `- ${a.account}: ${current}; ${then}`
}

const spend = (d: Digest): Section => ({ title: 'Spend', lines: d.spend.map(a => spendLine(a, d)) })

function next(d: Digest, s: Style): Section {
  const lines = d.next.picks.map(
    p => `- ${p.initiative} ${p.task} as ${p.profile} on ${p.account}: ${p.reason}`,
  )
  if (d.next.error !== undefined) lines.push(`- ${d.next.error}`)
  else if (lines.length === 0)
    lines.push(
      `- nothing to dispatch: ${d.next.refused} refusals, ${d.next.notOptedIn} focused initiatives not opted in; ` +
        `see ${s.cmd('agent-chat burndown plan')}`,
    )
  return { title: 'Next (burndown dry run)', lines }
}

const headline = (d: Digest): string =>
  `agent-chat digest for ${agoFrom(d.generatedAt, d.sinceMs).replace(' ago', '')} since ${new Date(d.sinceMs).toISOString()}`

export function renderDigest(d: Digest, format: Format): string[] {
  const s = STYLES[format]
  const sections = [needsYou(d, s), decided(d, s), done(d), stalled(d), spend(d), next(d, s)]
  const out = [format === 'markdown' ? `# ${headline(d)}` : headline(d)]
  const empty: string[] = []
  for (const section of sections) {
    if (section.lines.length === 0) {
      empty.push(section.title.replace(/ \(.*\)$/, ''))
      continue
    }
    out.push('', s.heading(section.title), ...section.lines)
  }
  if (empty.length > 0) out.push('', `Nothing in: ${empty.join(', ')}.`)
  if (d.gaps.length > 0) out.push('', s.heading('Not read'), ...d.gaps.map(g => `- ${g}`))
  return out
}
