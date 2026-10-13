import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const PLUGIN_BIN = path.join(import.meta.dirname, '..', '..', 'plugins', 'agent-chat', 'bin')
const RUN_BASH = path.join(PLUGIN_BIN, 'run-bash')

const hasZsh = spawnSync('zsh', ['-fc', 'true']).status === 0

const WORD_SPLIT = 'p="a b"; n=0; for x in $p; do n=$((n+1)); done; echo $n'

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-run-bash-'))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

const baseEnv = () => ({ PATH: `${PLUGIN_BIN}:/usr/bin:/bin`, HOME: home })

const runBash = (args: string[], input?: string, env: Record<string, string> = {}) =>
  spawnSync(RUN_BASH, args, { encoding: 'utf8', input, env: { ...baseEnv(), ...env } })

const inZsh = (command: string) =>
  spawnSync('zsh', ['-f', '-c', command], { encoding: 'utf8', env: baseEnv() })

const heredoc = (body: string, args = '') => `run-bash ${args}<<'EOF'\n${body}\nEOF`

const writeScript = (body: string) => {
  const file = path.join(home, 's.sh')
  fs.writeFileSync(file, `${body}\n`)
  return file
}

describe('run-bash launched from zsh', () => {
  it.skipIf(!hasZsh)('splits an unquoted variable holding "a b" into two loop iterations', () => {
    const result = inZsh(heredoc(WORD_SPLIT))

    expect(result.stdout).toBe('2\n')
  })

  it.skipIf(!hasZsh)('prints ==== for echo ====', () => {
    const result = inZsh(heredoc('echo ===='))

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('====\n')
  })

  it.skipIf(!hasZsh)('passes heredoc args through to $1 and $2', () => {
    const result = inZsh(heredoc('echo "[$1][$2]"', '- x y '))

    expect(result.stdout).toBe('[x][y]\n')
  })
})

describe('zsh without run-bash (control)', () => {
  it.skipIf(!hasZsh)('runs the loop once, because zsh does not word-split', () => {
    expect(inZsh(WORD_SPLIT).stdout).toBe('1\n')
  })

  it.skipIf(!hasZsh)('fails echo ====, because zsh expands the leading =', () => {
    expect(inZsh('echo ====').status).not.toBe(0)
  })
})

describe('run-bash', () => {
  it('passes args after a script file through to $1 and $2', () => {
    const result = runBash([writeScript('echo "[$1][$2]"'), 'x', 'y z'])

    expect(result.stdout).toBe('[x][y z]\n')
  })

  it('runs a script on stdin when given no args', () => {
    const result = runBash([], 'echo hi')

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('hi\n')
  })

  it('passes args after - through to a stdin script', () => {
    const result = runBash(['-', 'x', 'y'], 'echo "[$1][$2]"')

    expect(result.stdout).toBe('[x][y]\n')
  })

  it("exits with the script's status", () => {
    expect(runBash([writeScript('exit 3')]).status).toBe(3)
    expect(runBash([], 'exit 3').status).toBe(3)
  })

  it('reports a missing script and exits 2', () => {
    const missing = path.join(home, 'nonexistent.sh')

    const result = runBash([missing])

    expect(result.status).toBe(2)
    expect(result.stderr).toBe(`FAIL no script ${missing}\n`)
  })

  it('sources neither the rc files nor BASH_ENV', () => {
    for (const rc of ['.bashrc', '.bash_profile', '.profile']) {
      fs.writeFileSync(path.join(home, rc), 'echo RC\n')
    }
    const bashEnv = path.join(home, 'env.sh')
    fs.writeFileSync(bashEnv, 'echo ENV\n')

    const result = runBash([], 'echo ran', { BASH_ENV: bashEnv })

    expect(result.stdout).toBe('ran\n')
  })
})
