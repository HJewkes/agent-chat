import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorktreeStrategy } from '../agents/isolation/worktree.js'
import { HOST_PATH } from './helpers/git-shim-fixture.js'

const roots: string[] = []
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function fixture(output: string, failed = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-result-')))
  roots.push(root)
  const repo = path.join(root, 'repo')
  const bin = path.join(root, 'bin')
  fs.mkdirSync(repo)
  fs.mkdirSync(bin)
  execFileSync('git', ['init', '-q', '-b', 'main'], {
    cwd: repo,
    stdio: 'pipe',
    env: { ...process.env, PATH: HOST_PATH },
  })
  const branchOutput = path.join(root, 'branch-output')
  const cwdLog = path.join(root, 'worktree-cwds')
  fs.writeFileSync(branchOutput, output)
  fs.writeFileSync(
    path.join(bin, 'git'),
    [
      '#!/bin/sh',
      `PATH=$(printf '%s' "$PATH" | tr ':' '\\n' | grep -vxF ${quote(bin)} | paste -sd: -)`,
      'export PATH',
      'if [ "$1" = rev-parse ] && [ "$3" = --git-common-dir ]; then',
      `  printf '  %s\\n' ${quote(path.join(repo, '.git'))}; exit 0`,
      'fi',
      'if [ "$1" = rev-parse ] && [ "$2" = --verify ]; then',
      failed ? '  exit 1' : `  cat ${quote(branchOutput)}; exit 0`,
      'fi',
      `if [ "$1" = worktree ]; then printf '%s\\n' "$PWD" >> ${quote(cwdLog)}; fi`,
      'exec git "$@"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  vi.stubEnv('PATH', bin + path.delimiter + HOST_PATH)
  return { repo, cwdLog }
}
describe('worktree check Git result semantics', () => {
  const check = (repo: string) =>
    createWorktreeStrategy({ budget: 8, reviewerBudget: 8 }).check({
      agentId: 'synthetic',
      agentName: 'worker',
      baseCwd: repo,
    })
  it.each(['  synthetic-tip\n', '  \n'])(
    'keeps a successful ref observation advisory even for padded or empty output %j',
    async output => {
      const f = fixture(output)
      expect(await check(f.repo)).toEqual([
        'warning: branch agent-chat/worker already exists; it will be adopted if it holds commits, reset if it does not',
      ])
      expect(fs.readFileSync(f.cwdLog, 'utf8').trim().split('\n')).toEqual([f.repo, f.repo])
    },
  )
  it('treats a failed ref observation as absent while preserving the trimmed repository root', async () => {
    const f = fixture('', true)
    expect(await check(f.repo)).toEqual([])
    expect(fs.readFileSync(f.cwdLog, 'utf8').trim().split('\n')).toEqual([f.repo, f.repo])
  })
})
