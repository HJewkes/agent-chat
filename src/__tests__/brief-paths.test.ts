import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { crossingBriefPaths } from '../agents/brief-paths.js'

/**
 * CC-236 b. A brief that names `<cwd>/link/file.md`, where `link` resolves outside
 * the cwd to a dir nobody granted, sends a headless worker into a Write prompt it
 * cannot answer. The spawn warns about such paths; it never refuses.
 */

const tmpDirs: string[] = []

function tmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpDirs.push(dir)
  return dir
}

function linkedWorkspace() {
  const cwd = tmp('agent-chat-ws-')
  const outside = tmp('agent-chat-out-')
  fs.symlinkSync(outside, path.join(cwd, 'link'))
  return { cwd, outside }
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('brief paths that cross a symlink out of the spawn cwd', () => {
  it('warns about an absolute path through an ungranted link, naming its real target', () => {
    const { cwd, outside } = linkedWorkspace()
    const brief = `Write your report to ${path.join(cwd, 'link', 'out.md')}.`

    const warnings = crossingBriefPaths(brief, cwd, [])

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(path.join(outside, 'out.md'))
  })

  it('warns about a relative path through the link too', () => {
    const { cwd } = linkedWorkspace()

    expect(crossingBriefPaths('Write `link/audits/x.md` when done', cwd, [])).toHaveLength(1)
  })

  it('stays quiet when the link target is a granted dir', () => {
    const { cwd, outside } = linkedWorkspace()
    const brief = `Write ${path.join(cwd, 'link', 'out.md')}`

    expect(crossingBriefPaths(brief, cwd, [outside])).toEqual([])
  })

  it('stays quiet for a not-yet-existing file under a real subdir of the cwd', () => {
    const cwd = tmp('agent-chat-ws-')
    fs.mkdirSync(path.join(cwd, 'docs'))

    expect(crossingBriefPaths('Write docs/new/plan.md and ./src/x.ts:12', cwd, [])).toEqual([])
  })

  it('stays quiet for an absolute path outside the cwd that crosses no link', () => {
    const cwd = tmp('agent-chat-ws-')
    const elsewhere = tmp('agent-chat-plans-')

    expect(crossingBriefPaths(`Read ${path.join(elsewhere, 'plan.md')}`, cwd, [])).toEqual([])
  })

  it('ignores prose and URLs', () => {
    const { cwd } = linkedWorkspace()

    expect(crossingBriefPaths('See https://example.com/link/a.md and the link dir.', cwd, [])).toEqual([])
  })
})
