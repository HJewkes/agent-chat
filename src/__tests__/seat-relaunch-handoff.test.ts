import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { latestTeleportSection } from '../agents/seats/boot-read.js'
import {
  HANDOFF_CAP,
  NO_TELEPORT_STATE,
  buildRelaunchHandoff,
  renderRelaunchHandoff,
} from '../agents/seats/relaunch-handoff.js'

let root: string
const NOW = new Date(2026, 9, 2, 9)

const writeLog = (seat: string, day: string, text: string): void => {
  const dir = path.join(root, 'logs', seat)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${day}.md`), text)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'relaunch-handoff-'))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('latestTeleportSection', () => {
  it('reads yesterday when today has no section', () => {
    writeLog('alpha', '2026-09-30', '## State at teleport 2\nyesterday state\n')
    writeLog('alpha', '2026-10-01', '10:00 heartbeat\n')
    expect(latestTeleportSection(root, 'alpha', NOW)).toEqual({
      day: '2026-09-30',
      section: '## State at teleport 2\nyesterday state',
    })
  })

  it('takes the last section of the newest day that has one', () => {
    writeLog('alpha', '2026-09-30', '## State at teleport 1\nold day\n')
    writeLog(
      'alpha',
      '2026-10-01',
      '## State at teleport 1\nfirst\n## Notes\nx\n## State at teleport 2\nsecond\n',
    )
    expect(latestTeleportSection(root, 'alpha', NOW)).toEqual({
      day: '2026-10-01',
      section: '## State at teleport 2\nsecond',
    })
  })

  it('keeps a journal exactly 7 days old and ignores one 8 days old', () => {
    writeLog('alpha', '2026-09-25', '## State at teleport 1\nedge\n')
    expect(latestTeleportSection(root, 'alpha', NOW)?.day).toBe('2026-09-25')
    fs.rmSync(path.join(root, 'logs', 'alpha', '2026-09-25.md'))
    writeLog('alpha', '2026-09-24', '## State at teleport 1\ntoo old\n')
    expect(latestTeleportSection(root, 'alpha', NOW)).toBeUndefined()
  })

  it('ignores old files even when fewer than 7 journals exist', () => {
    writeLog('alpha', '2026-08-01', '## State at teleport 1\nweeks old\n')
    expect(latestTeleportSection(root, 'alpha', NOW)).toBeUndefined()
  })

  it('returns undefined when no journal has a section', () => {
    writeLog('alpha', '2026-10-01', '10:00 heartbeat\n')
    expect(latestTeleportSection(root, 'alpha', NOW)).toBeUndefined()
    expect(latestTeleportSection(root, 'nobody', NOW)).toBeUndefined()
  })
})

describe('renderRelaunchHandoff', () => {
  const base = { root: '/r', seat: 'alpha', quietMinutes: 20 }

  it('names the seat, files, boot pointer and section', () => {
    const text = renderRelaunchHandoff({
      ...base,
      found: { day: '2026-10-01', section: '## State at teleport 3\nbody' },
    })
    expect(text).toContain('alpha had no heartbeat for 20 min and no live session.')
    expect(text).toContain('(from logs/alpha/2026-10-01.md)')
    expect(text).toContain('@/r/charter.md as seat alpha')
    expect(text).toContain('@/r/seats/alpha.md')
    expect(text).toContain('@/r/queues/alpha.md')
    expect(text).toContain('`agent-chat seats boot alpha`')
    expect(text.endsWith('## State at teleport 3\nbody')).toBe(true)
  })

  it('says none was found when the section is absent', () => {
    expect(renderRelaunchHandoff({ ...base, found: undefined }).endsWith(NO_TELEPORT_STATE)).toBe(true)
  })

  it('holds the cap on a long section', () => {
    const section = `## State at teleport 1\n${'line of state\n'.repeat(1000)}`
    expect(
      renderRelaunchHandoff({ ...base, found: { day: '2026-10-01', section } }).length,
    ).toBeLessThanOrEqual(HANDOFF_CAP)
  })
})

describe('buildRelaunchHandoff', () => {
  it('carries the section found in an earlier day', () => {
    writeLog('alpha', '2026-09-30', '## State at teleport 4\nfrom the night\n')
    expect(buildRelaunchHandoff(root, 'alpha', 30, NOW)).toContain('from the night')
  })
})
