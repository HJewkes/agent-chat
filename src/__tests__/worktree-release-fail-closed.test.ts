import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Allocation } from '../agents/isolation/index.js'
import { refusalOf } from '../agents/isolation/refusals.js'
import { createWorktreeStrategy, inspectForRelease } from '../agents/isolation/worktree.js'
import { HOST_PATH } from './helpers/git-shim-fixture.js'

/**
 * TP-640 P8. The product copy of release inspection ran `git status --porcelain`, which hides
 * ignored files, and read a failed status as clean. On the package it must fail closed: an
 * ignored file, a status that cannot be read, an ignored list that cannot be read, and a removal
 * git refuses all leave the tree and its branch on disk.
 */

const branch = 'agent-chat/worker'
const roots: string[] = []
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, PATH: HOST_PATH },
  }).trim()

/** Fails the one git call named in `fault`, and drops its own dir from PATH so `git` is the real one. */
function writeFaultShim(bin: string, fault: string): void {
  fs.writeFileSync(
    path.join(bin, 'git'),
    [
      '#!/bin/sh',
      `PATH=$(printf '%s' "$PATH" | tr ':' '\\n' | grep -vxF ${quote(bin)} | paste -sd: -)`,
      'export PATH',
      `fault=$(cat ${quote(fault)} 2>/dev/null)`,
      'if [ "$fault" = status ] && [ "$1" = status ]; then exit 1; fi',
      'if [ "$fault" = ignored ] && [ "$1" = ls-files ]; then exit 1; fi',
      'if [ "$fault" = remove ] && [ "$1" = worktree ] && [ "$2" = remove ]; then',
      '  printf "%s\\n" "synthetic removal refusal" >&2; exit 1',
      'fi',
      'exec git "$@"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-fail-closed-')))
  roots.push(root)
  const repo = path.join(root, 'repo')
  const bin = path.join(root, 'bin')
  const fault = path.join(root, 'fault')
  fs.mkdirSync(repo)
  fs.mkdirSync(bin)
  git(repo, ['init', '-q', '-b', 'main'])
  for (const [key, value] of [
    ['user.email', 'test@example.com'],
    ['user.name', 'Test'],
    ['commit.gpgsign', 'false'],
  ] as const)
    git(repo, ['config', key, value])
  fs.writeFileSync(path.join(repo, 'README.md'), 'owned seed\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-qm', 'seed'])
  const base = git(repo, ['rev-parse', 'HEAD'])
  const tree = path.join(repo, '.worktrees', 'worker')
  git(repo, ['worktree', 'add', '-qb', branch, tree])
  writeFaultShim(bin, fault)
  vi.stubEnv('PATH', bin + path.delimiter + HOST_PATH)
  const allocation: Allocation = { cwd: tree, ref: { branch, worktree: tree, gitRoot: repo, base } }
  return { repo, tree, base, fault, allocation }
}

type Fixture = ReturnType<typeof fixture>

function ignoredNote(f: Fixture): string {
  fs.appendFileSync(path.join(f.repo, '.git', 'info', 'exclude'), '\nlate-owned-note.txt\n')
  const note = path.join(f.tree, 'late-owned-note.txt')
  fs.writeFileSync(note, 'harmless owned note\n')
  expect(git(f.tree, ['status', '--porcelain', '-uall'])).toBe('')
  return note
}

const release = (f: Fixture) =>
  createWorktreeStrategy().release(
    { agentId: 'synthetic-release', agentName: 'worker', baseCwd: f.repo },
    f.allocation,
  )

function expectKept(f: Fixture): void {
  expect(fs.existsSync(f.tree)).toBe(true)
  expect(git(f.repo, ['branch', '--list', branch])).toContain(branch)
}

it('counts an ignored file that no build regenerates as dirty, and keeps it on release', async () => {
  const f = fixture()
  const note = ignoredNote(f)

  const safety = await inspectForRelease(f.repo, f.tree, branch, f.base)
  const released = await release(f)

  expect(safety.dirty).toBe(true)
  expect(released).toBe(false)
  expect(refusalOf(f.allocation)).toContain('ignored files')
  expect(fs.readFileSync(note, 'utf8')).toBe('harmless owned note\n')
  expectKept(f)
})

it.each([
  ['status-error', 'status', 'could not read git status'],
  ['ignored-error', 'ignored', 'could not list ignored files'],
])('refuses release when git status fails closed (%s)', async (_kind, fault, detail) => {
  const f = fixture()
  fs.writeFileSync(f.fault, fault)

  const safety = await inspectForRelease(f.repo, f.tree, branch, f.base)
  const released = await release(f)

  expect(safety.dirty).toBe(true)
  expect(released).toBe(false)
  expect(refusalOf(f.allocation)).toContain(detail)
  expectKept(f)
})

it('reports a refused removal of a clean tree as not released, and keeps the branch', async () => {
  const f = fixture()
  expect((await inspectForRelease(f.repo, f.tree, branch, f.base)).dirty).toBe(false)
  fs.writeFileSync(f.fault, 'remove')

  const released = await release(f)

  expect(released).toBe(false)
  expectKept(f)
})

it('releases a clean tree when git answers every call', async () => {
  const f = fixture()

  expect(await release(f)).toBe(true)
  expect(fs.existsSync(f.tree)).toBe(false)
  expect(git(f.repo, ['branch', '--list', branch])).toBe('')
})
