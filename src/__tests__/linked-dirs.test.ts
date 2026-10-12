import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { linkedWriteDirs, withLinkedDirs } from '../agents/linked-dirs.js'

/**
 * CC-236. A headless worker's Write to `<cwd>/sources/...` prompts, and times out,
 * when `sources` is a symlink into the active-work root, because the path resolves
 * outside every working directory. The spawn grants the real dir with --add-dir.
 */

const tmpDirs: string[] = []

function tmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpDirs.push(dir)
  return dir
}

function fixture() {
  const root = tmp('agent-chat-aw-')
  const sources = path.join(root, 'init', 'sources')
  fs.mkdirSync(sources, { recursive: true })
  const cwd = tmp('agent-chat-ws-')
  return { root, sources, cwd }
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('the dirs a spawn cwd links into the active-work root', () => {
  it('returns a top-level link into the root at its real path', () => {
    const { root, sources, cwd } = fixture()
    fs.symlinkSync(path.join(root, 'init', '.', 'sources'), path.join(cwd, 'sources'))

    expect(linkedWriteDirs(cwd, root)).toEqual([{ link: 'sources', dir: sources }])
  })

  it('skips a link to a sibling repo outside the root', () => {
    const { root, cwd } = fixture()
    const sibling = tmp('agent-chat-sibling-')
    fs.symlinkSync(sibling, path.join(cwd, 'voltras'))

    expect(linkedWriteDirs(cwd, root)).toEqual([])
  })

  it('skips a link back inside the cwd and a dangling link without throwing', () => {
    const { root, cwd } = fixture()
    fs.mkdirSync(path.join(cwd, 'docs'))
    fs.symlinkSync(path.join(cwd, 'docs'), path.join(cwd, 'notes'))
    fs.symlinkSync(path.join(cwd, 'gone'), path.join(cwd, 'settings.json'))

    expect(linkedWriteDirs(cwd, root)).toEqual([])
  })

  it('skips a link that sits inside the root when the cwd itself is in the root', () => {
    const root = tmp('agent-chat-aw-')
    const cwd = path.join(root, 'init')
    fs.mkdirSync(path.join(cwd, 'real'), { recursive: true })
    fs.symlinkSync(path.join(cwd, 'real'), path.join(cwd, 'sources'))

    expect(linkedWriteDirs(cwd, root)).toEqual([])
  })
})

describe('granting the linked dirs to an allocation', () => {
  it('merges into existing addDirs without duplicates and appends to the note', () => {
    const { root, sources, cwd } = fixture()
    fs.symlinkSync(sources, path.join(cwd, 'sources'))

    const granted = withLinkedDirs({ cwd, addDirs: ['/shared', sources], note: 'you own src/' }, root)

    expect(granted.addDirs).toEqual(['/shared', sources])
    expect(granted.note).toBe(
      `you own src/\n${path.join(cwd, 'sources')} is ${sources}; write there by either path`,
    )
  })

  it('returns the allocation unchanged when nothing links into the root', () => {
    const { root, cwd } = fixture()
    const allocation = { cwd }

    expect(withLinkedDirs(allocation, root)).toBe(allocation)
  })
})
