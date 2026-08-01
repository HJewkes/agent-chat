import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { briefingFor, resolveBriefing } from '../agents/active-work.js'

/**
 * CC-63. A spawned agent starts from its brief and nothing else, so every brief
 * written by hand has re-described the same project context. These cover the two
 * halves of fixing that: reading an initiative off disk, and DECIDING which
 * initiative a spawn belongs to when cwd does not name one.
 */

const tmpDirs: string[] = []

function activeWorkRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-aw-'))
  tmpDirs.push(dir)
  return fs.realpathSync(dir)
}

function initiative(root: string, slug: string): string {
  const dir = path.join(root, slug)
  fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'brief.md'),
    `---\ntitle: ${slug}\nstate: focused\n---\n# ${slug}\n\nWhy: the reason this exists.\n`,
  )
  fs.writeFileSync(
    path.join(dir, 'tasks', 'XX-1.yml'),
    'id: XX-1\ntitle: Fix the thing that is\n  broken across two lines\npriority: 5\nstatus: open\n',
  )
  fs.writeFileSync(
    path.join(dir, 'tasks', 'XX-2.yml'),
    'id: XX-2\ntitle: Already handled\npriority: 1\nstatus: done\n',
  )
  fs.writeFileSync(
    path.join(dir, 'sessions', '2026-07-30-0900-older.md'),
    '---\nsession_id: older\n---\nAncient history.\n',
  )
  fs.writeFileSync(
    path.join(dir, 'sessions', '2026-07-31-2200-latest.md'),
    '---\nsession_id: latest\n---\nWhat happened most recently.\n',
  )
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('the briefing built from an active-work initiative', () => {
  it('carries the brief, the open tasks and the newest session', () => {
    const root = activeWorkRoot()
    initiative(root, 'widgets')

    const result = briefingFor('widgets', root)

    expect('text' in result).toBe(true)
    const { text } = result as { text: string }
    expect(text).toContain('Why: the reason this exists.')
    expect(text).toContain('XX-1: Fix the thing that is broken across two lines')
    expect(text).toContain('What happened most recently.')
    // Frontmatter is bookkeeping, and a done task is not orientation.
    expect(text).not.toContain('session_id:')
    expect(text).not.toContain('Already handled')
  })

  it('reports a missing initiative rather than inventing one', () => {
    const root = activeWorkRoot()

    expect(briefingFor('nothing-here', root)).toEqual({
      warning: expect.stringContaining('no active-work initiative "nothing-here"'),
    })
  })
})

describe('deciding which initiative a spawn belongs to', () => {
  it('takes an explicit slug over anyone’s directory', () => {
    const root = activeWorkRoot()
    initiative(root, 'widgets')
    initiative(root, 'gadgets')

    const result = resolveBriefing({
      briefing: 'gadgets',
      requesterCwd: path.join(root, 'widgets'),
      root,
    })

    expect(result).toMatchObject({ slug: 'gadgets' })
  })

  /**
   * The decision CC-63 asked for: the coordinator is the party that knows which
   * initiative the work belongs to, and the target cwd is usually just a
   * checkout — several initiatives can share one.
   */
  it('resolves auto from the requester’s directory before the target cwd', () => {
    const root = activeWorkRoot()
    initiative(root, 'widgets')
    initiative(root, 'gadgets')

    const result = resolveBriefing({
      briefing: 'auto',
      requesterCwd: path.join(root, 'widgets', 'sessions'),
      targetCwd: path.join(root, 'gadgets'),
      root,
    })

    expect(result).toMatchObject({ slug: 'widgets' })
  })

  it('falls back to the target cwd when the requester is not in an initiative', () => {
    const root = activeWorkRoot()
    initiative(root, 'gadgets')

    const result = resolveBriefing({
      briefing: 'auto',
      requesterCwd: os.tmpdir(),
      targetCwd: path.join(root, 'gadgets'),
      root,
    })

    expect(result).toMatchObject({ slug: 'gadgets' })
  })

  it('warns instead of guessing when neither directory names an initiative', () => {
    const root = activeWorkRoot()
    initiative(root, 'widgets')

    const result = resolveBriefing({
      briefing: 'auto',
      requesterCwd: os.tmpdir(),
      targetCwd: os.homedir(),
      root,
    })

    expect(result).toEqual({ warning: expect.stringContaining('could not tell which active-work') })
  })
})
