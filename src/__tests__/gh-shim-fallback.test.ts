import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeGhShim } from '../gh-shim/install.js'

/**
 * CC-664: with its build gone the gh shim drops its own dir from PATH and execs gh. A PATH entry that
 * reaches the shim dir by another spelling must be dropped too, or gh resolves to the shim again and
 * the script re-execs itself forever (one process, so only the timeout ends it).
 */

// /bin/sh is bash on macOS and dash on Ubuntu; each available interpreter runs the fallback.
const SHELLS = ['/bin/dash', '/bin/sh', '/bin/bash'].filter(shell => fs.existsSync(shell))

const FAKE_GH = `#!/bin/sh
echo "$*" >> "$FAKE_GH_LOG"
echo "real-gh $*"
echo "path $PATH"
`

let dir: string
let shimDir: string
let fakeDir: string
let logFile: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-gh-shim-fallback-'))
  fakeDir = path.join(dir, 'fake')
  fs.mkdirSync(fakeDir)
  fs.writeFileSync(path.join(fakeDir, 'gh'), FAKE_GH, { mode: 0o755 })
  shimDir = writeGhShim(
    path.join(dir, 'shim'),
    process.execPath,
    path.join(dir, 'gone', 'main.js'),
    path.join(dir, 'keys'),
  )
  logFile = path.join(dir, 'gh.log')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function runShim(shell: string, shimEntry: string, args = ['pr', 'view', '7']) {
  const env = { PATH: [shimEntry, fakeDir, '/usr/bin', '/bin'].join(':'), FAKE_GH_LOG: logFile }
  return spawnSync(shell, [path.join(shimDir, 'gh'), ...args], {
    cwd: dir,
    env,
    encoding: 'utf8',
    timeout: 10_000,
  })
}

const realGhRuns = (): string[] =>
  fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n') : []

describe.each(SHELLS)('the gh shim fallback under %s, its build gone', shell => {
  it('drops a symlink to its own dir from PATH and runs the real gh once', () => {
    const link = path.join(dir, 'shim-link')
    fs.symlinkSync(shimDir, link)

    const result = runShim(shell, link)

    // Kills: comparing entries as strings, or resolving them logically (`cd` without -P).
    expect(result.stdout).toContain('real-gh pr view 7\n')
    expect(result.status).toBe(0)
    expect(realGhRuns()).toEqual(['pr view 7'])
  })

  it('drops a trailing-slash spelling of its own dir and runs the real gh once', () => {
    const result = runShim(shell, `${shimDir}/`)

    // Kills: comparing entries as strings, the pre-CC-664 `grep -vxF` filter.
    expect(result.stdout).toContain('real-gh pr view 7\n')
    expect(result.status).toBe(0)
    expect(realGhRuns()).toEqual(['pr view 7'])
  })

  it('keeps every other PATH entry, in order', () => {
    const result = runShim(shell, shimDir)

    // Kills: a filter that drops or reorders entries other than the shim's own.
    expect(result.stdout).toContain(`path ${[fakeDir, '/usr/bin', '/bin'].join(':')}\n`)
  })

  it.each([
    ['a write', ['issue', 'comment', '3', '--body', 'x']],
    ['an api call, which it cannot classify', ['api', 'repos/acme/widgets/pulls']],
    ['a leading repo flag', ['-R', 'acme/widgets', 'pr', 'view', '7']],
    ['a verb that is a read only in another group', ['ext-name', 'view']],
  ])('refuses %s without starting the real gh (CC-1644)', (_, args) => {
    const result = runShim(shell, shimDir, args)

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/^gh-shim: refused \(write\)/)
    expect(realGhRuns()).toEqual([])
  })

  it.each([['auth', 'git-credential', 'get'], ['run', 'download', '9'], ['search', 'prs'], ['--version']])(
    'runs the known read %s',
    (...args) => {
      const result = runShim(shell, shimDir, args)

      expect(result.status).toBe(0)
      expect(realGhRuns()).toEqual([args.join(' ')])
    },
  )
})
