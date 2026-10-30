import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isRunning, killQuietly, waitUntilGone } from './helpers/process-gone.js'
import { createRunRoot, runBase, sweepDeadRuns } from './helpers/run-root.js'

let base: string
const leftover: number[] = []

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'run-root-'))
})

afterEach(() => {
  for (const pid of leftover.splice(0)) killQuietly(pid)
  fs.rmSync(base, { recursive: true, force: true })
})

interface Run {
  run: ReturnType<typeof spawn>
  root: string
  git: number
}

/** A run that owns a root and whose git blocks on a FIFO include there, as leak-pretool's include case does. */
function startRunWithBlockedGit(): Promise<Run> {
  const script =
    'read fifo; git -c include.path="$fifo" config --includes --get-regexp "^core\\.hookspath$" & echo $!; wait'
  const run = spawn('sh', ['-c', script], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const root = createRunRoot(base, run.pid)
  const fifo = path.join(root, 'agent-chat-pretool-x', 'include-fifo')
  fs.mkdirSync(path.dirname(fifo))
  execFileSync('mkfifo', [fifo])
  run.stdin.write(`${fifo}\n`)
  return new Promise(resolve =>
    run.stdout.once('data', (chunk: Buffer) => resolve({ run, root, git: Number(String(chunk).trim()) })),
  )
}

describe('a test run killed with SIGKILL (CC-1673)', () => {
  it('leaves no run root and no git process once the next run has swept', async () => {
    const { run, root, git } = await startRunWithBlockedGit()
    leftover.push(git)

    run.kill('SIGKILL')
    await new Promise(resolve => run.once('exit', resolve))
    // Long enough for git to reach the FIFO, so it is blocked there rather than not yet started.
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(isRunning(git)).toBe(true)
    const swept = sweepDeadRuns([base])

    expect(swept).toEqual([root])
    expect(fs.existsSync(root)).toBe(false)
    expect(await waitUntilGone(git)).toBe(true)
  })
})

describe('the sweep at the start of a run', () => {
  it('keeps a root whose owner is still running', () => {
    const root = createRunRoot(base)

    expect(sweepDeadRuns([base])).toEqual([])
    expect(fs.existsSync(root)).toBe(true)
  })

  it('removes a root from before owner files once it is a day old, and keeps a fresh one', () => {
    const old = fs.mkdtempSync(path.join(base, 'agent-chat-test-run-'))
    const fresh = fs.mkdtempSync(path.join(base, 'agent-chat-test-run-'))
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    fs.utimesSync(old, twoDaysAgo, twoDaysAgo)

    expect(sweepDeadRuns([base])).toEqual([old])
    expect(fs.existsSync(fresh)).toBe(true)
  })

  it('keeps a fresh root whose owner-pid is still empty', () => {
    const root = fs.mkdtempSync(path.join(base, 'agent-chat-test-run-'))
    fs.writeFileSync(path.join(root, 'owner-pid'), '')

    expect(sweepDeadRuns([base])).toEqual([])
    expect(fs.existsSync(root)).toBe(true)
  })

  it('sweeps a day-old root whose owner-pid is garbage', () => {
    const root = fs.mkdtempSync(path.join(base, 'agent-chat-test-run-'))
    fs.writeFileSync(path.join(root, 'owner-pid'), 'garbage')
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    fs.utimesSync(root, twoDaysAgo, twoDaysAgo)
    const fresh = fs.mkdtempSync(path.join(base, 'agent-chat-test-run-'))
    fs.writeFileSync(path.join(fresh, 'owner-pid'), '0')

    expect(sweepDeadRuns([base])).toEqual([root])
    expect(fs.existsSync(root)).toBe(false)
    expect(fs.existsSync(fresh)).toBe(true)
  })

  it('skips a symlinked root and leaves its target untouched', () => {
    const target = fs.mkdtempSync(path.join(base, 'elsewhere-'))
    const keep = path.join(target, 'keep.txt')
    fs.writeFileSync(keep, 'x')
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    fs.utimesSync(target, twoDaysAgo, twoDaysAgo)
    const link = path.join(base, 'agent-chat-test-run-link')
    fs.symlinkSync(target, link)

    expect(sweepDeadRuns([base])).toEqual([])
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(keep, 'utf8')).toBe('x')
  })

  it('leaves dirs that are not run roots alone', () => {
    const other = path.join(base, 'unrelated')
    fs.mkdirSync(other)
    fs.utimesSync(other, new Date(0), new Date(0))

    expect(sweepDeadRuns([base])).toEqual([])
    expect(fs.existsSync(other)).toBe(true)
  })
})

describe('where the run root goes', () => {
  it('uses a short TMPDIR', () => {
    expect(runBase('/var/tmp/short', '/h/zq7')).toBe('/var/tmp/short')
  })

  it('falls back to a short dir on disk when TMPDIR would push socket paths too long', () => {
    expect(runBase('/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T', '/h/zq7')).toBe(
      '/h/zq7/.cache/ac-test',
    )
  })
})
