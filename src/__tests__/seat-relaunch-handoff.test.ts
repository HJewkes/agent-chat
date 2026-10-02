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
    expect(latestTeleportSection(root, 'alpha')).toBe('## State at teleport 2\nyesterday state')
  })

  it('takes the last section of the newest day that has one', () => {
    writeLog('alpha', '2026-09-30', '## State at teleport 1\nold day\n')
    writeLog(
      'alpha',
      '2026-10-01',
      '## State at teleport 1\nfirst\n## Notes\nx\n## State at teleport 2\nsecond\n',
    )
    expect(latestTeleportSection(root, 'alpha')).toBe('## State at teleport 2\nsecond')
  })

  it('returns undefined when no journal has a section', () => {
    writeLog('alpha', '2026-10-01', '10:00 heartbeat\n')
    expect(latestTeleportSection(root, 'alpha')).toBeUndefined()
    expect(latestTeleportSection(root, 'nobody')).toBeUndefined()
  })
})

describe('renderRelaunchHandoff', () => {
  const base = { root: '/r', seat: 'alpha', quietMinutes: 20 }

  it('names the seat, files, boot pointer and section', () => {
    const text = renderRelaunchHandoff({ ...base, section: '## State at teleport 3\nbody' })
    expect(text).toContain('alpha had no heartbeat for 20 min and no live session.')
    expect(text).toContain('@/r/charter.md as seat alpha')
    expect(text).toContain('@/r/seats/alpha.md')
    expect(text).toContain('@/r/queues/alpha.md')
    expect(text).toContain('`agent-chat seats boot alpha`')
    expect(text.endsWith('## State at teleport 3\nbody')).toBe(true)
  })

  it('says none was found when the section is absent', () => {
    expect(renderRelaunchHandoff({ ...base, section: undefined }).endsWith(NO_TELEPORT_STATE)).toBe(true)
  })

  it('holds the cap on a long section', () => {
    const section = `## State at teleport 1\n${'line of state\n'.repeat(1000)}`
    expect(renderRelaunchHandoff({ ...base, section }).length).toBeLessThanOrEqual(HANDOFF_CAP)
  })
})

describe('buildRelaunchHandoff', () => {
  it('carries the section found in an earlier day', () => {
    writeLog('alpha', '2026-09-30', '## State at teleport 4\nfrom the night\n')
    expect(buildRelaunchHandoff(root, 'alpha', 30)).toContain('from the night')
  })
})
