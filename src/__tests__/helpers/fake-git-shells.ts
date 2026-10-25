import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Real bash and zsh with a fake `git` first on PATH that only logs its arguments, so a test can
 * see what a line would push without pushing. `push.sh` in the root holds a push to feed shells.
 */
export interface FakeGitShells {
  root: string
  bin: string
  /** Each installed shell and the flags that keep its startup files out. */
  shells: [string, string[]][]
  hasZsh: boolean
  /** The git calls `shell -c src` made, one per line. */
  gitCalls(shell: string, args: string[], src: string): string
  cleanup(): void
}

/** `dirs` go on PATH after the fake git and before /usr/bin and /bin, for shells installed elsewhere. */
export function fakeGitShells(prefix: string, script: string, dirs: readonly string[] = []): FakeGitShells {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const bin = path.join(root, 'bin')
  const record = path.join(root, 'git-calls')
  const env = { PATH: [bin, ...dirs, '/usr/bin', '/bin'].join(':'), HOME: root, RECORD: record }
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$RECORD"\n', { mode: 0o755 })
  fs.writeFileSync(path.join(root, 'push.sh'), `${script}\n`)
  const shells = (
    [
      ['/bin/bash', ['--noprofile', '--norc']],
      ['/bin/zsh', ['-f']],
    ] satisfies [string, string[]][]
  ).filter(([shell]) => fs.existsSync(shell))
  const gitCalls = (shell: string, args: string[], src: string): string => {
    fs.rmSync(record, { force: true })
    try {
      execFileSync(shell, [...args, '-c', src], { env, cwd: root, stdio: ['ignore', 'ignore', 'ignore'] })
    } catch {
      // A failing pipeline still counts by what it ran.
    }
    return fs.existsSync(record) ? fs.readFileSync(record, 'utf8').trim() : ''
  }
  return {
    root,
    bin,
    shells,
    hasZsh: shells.some(([shell]) => shell.endsWith('zsh')),
    gitCalls,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}
