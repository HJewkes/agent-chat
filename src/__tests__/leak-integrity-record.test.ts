import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { compare, sessionSet, startupSet } from '../leak-guard/integrity/record.js'

/**
 * TP-4256 A1: the record of the files a later shell sources, and its comparison. Real files in a
 * synthetic HOME and config dir; nothing here reads shell line text.
 */

const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-integrity-')))
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }))

let n = 0
let home = ''
let config = ''
let snapshots = ''
let sessionEnv = ''

beforeEach(() => {
  const root = path.join(SCRATCH, `case-${n++}`)
  home = path.join(root, 'home')
  config = path.join(root, 'config')
  snapshots = path.join(config, 'shell-snapshots')
  sessionEnv = path.join(config, 'session-env', 'sess-a')
  for (const dir of [home, snapshots, sessionEnv]) fs.mkdirSync(dir, { recursive: true })
})

const startup = (): ReturnType<typeof startupSet> => startupSet(home, undefined, {})
const session = (id = 'sess-a', env: Record<string, string> = {}): ReturnType<typeof sessionSet> =>
  sessionSet(config, id, env)

describe('startup files', () => {
  it('records absent files and passes while they stay absent', () => {
    const base = startup()

    expect(base[path.join(home, '.zshenv')]).toEqual({ kind: 'startup', state: 'absent' })
    expect(compare(base, startup())).toBeUndefined()
  })

  it('denies a startup file that appears', () => {
    const base = startup()
    fs.writeFileSync(path.join(home, '.zlogin'), 'echo x\n')

    expect(compare(base, startup())).toEqual({ file: path.join(home, '.zlogin'), field: 'state' })
  })

  it('denies a startup file that is deleted', () => {
    const file = path.join(home, '.zshenv')
    fs.writeFileSync(file, 'export A=1\n')
    const base = startup()
    fs.rmSync(file)

    expect(compare(base, startup())).toEqual({ file, field: 'state' })
  })

  it('names ctime when bytes and mtime are restored after an append', () => {
    const file = path.join(home, '.zshenv')
    fs.writeFileSync(file, 'export A=1\n')
    const original = fs.readFileSync(file)
    const times = fs.statSync(file)
    const base = startup()

    fs.appendFileSync(file, 'source /tmp/rc\n')
    fs.writeFileSync(file, original)
    fs.utimesSync(file, times.atime, times.mtime)

    expect(compare(base, startup())).toEqual({ file, field: 'ctimeNs' })
  })

  it('names the inode when a rename replaces the file with the same bytes', () => {
    const file = path.join(home, '.zshrc')
    fs.writeFileSync(file, 'alias l=ls\n')
    const base = startup()
    const copy = path.join(home, 'copy')
    fs.writeFileSync(copy, 'alias l=ls\n')
    fs.renameSync(copy, file)

    expect(compare(base, startup())).toEqual({ file, field: 'ino' })
  })

  it('denies a symlink swapped to another target', () => {
    const file = path.join(home, '.zshenv')
    fs.writeFileSync(path.join(home, 'a'), 'same\n')
    fs.writeFileSync(path.join(home, 'b'), 'same\n')
    fs.symlinkSync(path.join(home, 'a'), file)
    const base = startup()
    fs.rmSync(file)
    fs.symlinkSync(path.join(home, 'b'), file)

    expect(compare(base, startup())?.file).toBe(file)
  })

  it('denies a compiled .zwc twin that appears, with or without the source file', () => {
    const base = startup()
    fs.writeFileSync(path.join(home, '.zshenv.zwc'), 'x\n')

    expect(compare(base, startup())).toEqual({ file: path.join(home, '.zshenv.zwc'), field: 'state' })
  })

  it('records BASH_ENV and ENV only when absolute', () => {
    const abs = path.join(home, 'benv')
    const records = startupSet(home, undefined, { BASH_ENV: abs, ENV: 'relative' })

    expect(records[abs]?.state).toBe('absent')
    expect(Object.keys(records)).not.toContain('relative')
  })

  it('records the startup files of ZDOTDIR as well', () => {
    const zdot = path.join(home, 'zdot')
    fs.mkdirSync(zdot)
    const base = startupSet(home, zdot, {})
    fs.writeFileSync(path.join(zdot, '.zshenv'), 'x\n')

    expect(compare(base, startupSet(home, zdot, {}))).toEqual({
      file: path.join(zdot, '.zshenv'),
      field: 'state',
    })
  })
})

describe('session files', () => {
  it('allows a baselined snapshot to be deleted', () => {
    const file = path.join(snapshots, 'snap-1.sh')
    fs.writeFileSync(file, 'alias\n')
    const base = session()
    fs.rmSync(file)

    expect(compare(base, session())).toBeUndefined()
  })

  it('denies a baselined snapshot that is rewritten', () => {
    const file = path.join(snapshots, 'snap-1.sh')
    fs.writeFileSync(file, 'alias\n')
    const base = session()
    fs.writeFileSync(file, 'alias\nsource /tmp/rc\n')

    expect(compare(base, session())?.file).toBe(file)
  })

  it('denies a deleted snapshot that reappears with other content', () => {
    const file = path.join(snapshots, 'snap-1.sh')
    fs.writeFileSync(file, 'alias\n')
    const base = session()
    fs.rmSync(file)
    fs.writeFileSync(file, 'alias\n')

    expect(compare(base, session())?.file).toBe(file)
  })

  it("ignores another session's new snapshot", () => {
    fs.writeFileSync(path.join(snapshots, 'snap-1.sh'), 'alias\n')
    const base = session()
    fs.writeFileSync(path.join(snapshots, 'snap-2.sh'), 'alias\n')
    fs.mkdirSync(path.join(config, 'session-env', 'sess-b'))
    fs.writeFileSync(path.join(config, 'session-env', 'sess-b', 'sessionstart-hook-1.sh'), 'x\n')

    expect(compare(base, session())).toBeUndefined()
  })

  it('denies a baselined session-env file that is appended to', () => {
    const file = path.join(sessionEnv, 'sessionstart-hook-1.sh')
    fs.writeFileSync(file, 'export A=1\n')
    const base = session()
    fs.appendFileSync(file, 'export B=2\n')

    expect(compare(base, session())?.file).toBe(file)
  })

  it('denies a new file in the session own session-env dir, even when it was empty', () => {
    const base = session()
    const file = path.join(sessionEnv, 'sessionstart-hook-9.sh')
    fs.writeFileSync(file, 'export A=1\n')

    expect(compare(base, session())).toEqual({ file, field: 'state' })
  })

  it('denies a new file in the session own dir when its directory was missing at the baseline', () => {
    fs.rmSync(sessionEnv, { recursive: true })
    const base = session()
    fs.mkdirSync(sessionEnv)
    fs.writeFileSync(path.join(sessionEnv, 'sessionstart-hook-1.sh'), 'x\n')

    expect(compare(base, session())?.field).toBe('state')
  })

  it('denies a deleted CLAUDE_ENV_FILE', () => {
    const file = path.join(sessionEnv, 'env.sh')
    fs.writeFileSync(file, 'export A=1\n')
    const base = session('sess-a', { CLAUDE_ENV_FILE: file })
    fs.rmSync(file)

    expect(compare(base, session('sess-a', { CLAUDE_ENV_FILE: file }))).toEqual({ file, field: 'state' })
  })

  it('records a FIFO without a hash and without blocking', () => {
    const fifo = path.join(snapshots, 'pipe')
    execFileSync('mkfifo', [fifo])
    const records = session()

    expect(records[fifo]).toMatchObject({ state: 'present' })
    expect(records[fifo]).not.toHaveProperty('sha256')
  })
})
