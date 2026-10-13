import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const ROOT = path.resolve(import.meta.dirname, '../..')
const BASE_SCRIPT = path.join(ROOT, 'scripts/ci/egress-base.mjs')

interface Workflow {
  concurrency: { group: string; 'cancel-in-progress': string }
  jobs: Record<string, { steps?: Array<{ id?: string; env?: Record<string, string> }> }>
}

const workflow = parse(readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')) as Workflow

// The workflow's own expressions are plain JS over the `github` context, so
// evaluating them checks the behaviour a run would get, not the spelling.
function evaluate(template: string, github: Record<string, unknown>): unknown {
  const expr = /^\$\{\{\s*(.*?)\s*\}\}$/s.exec(template)?.[1]
  if (expr === undefined) throw new Error(`not a single expression: ${template}`)
  return new Function('github', `return (${expr})`)(github)
}

function groupOf(github: Record<string, unknown>): string {
  return workflow.concurrency.group.replace(/\$\{\{.*?\}\}/g, part =>
    String(evaluate(part, { ...github, workflow: 'CI' })),
  )
}

const push = (runId: number) => ({ event_name: 'push', ref: 'refs/heads/main', run_id: runId })
const pr = (ref: string, runId: number) => ({
  event_name: 'pull_request',
  ref,
  run_id: runId,
})

describe('ci.yml concurrency', () => {
  it('puts every main push in one group, so a newer push replaces a queued run', () => {
    expect(groupOf(push(1))).toBe(groupOf(push(2)))
  })

  it('never cancels a main run that is already running', () => {
    expect(evaluate(workflow.concurrency['cancel-in-progress'], push(1))).toBe(false)
  })

  it('keeps one group per PR ref and cancels the superseded run', () => {
    expect(groupOf(pr('refs/pull/1/merge', 1))).toBe(groupOf(pr('refs/pull/1/merge', 2)))
    expect(groupOf(pr('refs/pull/1/merge', 1))).not.toBe(groupOf(pr('refs/pull/2/merge', 1)))
    expect(evaluate(workflow.concurrency['cancel-in-progress'], pr('refs/pull/1/merge', 1))).toBe(true)
  })

  it('keeps main pushes out of every PR group', () => {
    expect(groupOf(push(1))).not.toBe(groupOf(pr('refs/pull/1/merge', 1)))
  })
})

describe('ci.yml egress-scan range on a main push', () => {
  it('starts from the last successful main run, not the previous tip', () => {
    const steps = workflow.jobs['egress-scan']?.steps ?? []
    const scan = steps.find(step => step.env?.BASE_SHA !== undefined)
    const github = { event_name: 'push', event: { before: 'prev-tip' } }
    const run = (base: string) =>
      new Function('github', 'steps', `return (${base})`)(github, {
        base: { outputs: { sha: 'last-green' } },
      })
    const expr = /^\$\{\{\s*(.*?)\s*\}\}$/s.exec(scan?.env?.BASE_SHA ?? '')?.[1] ?? ''
    expect(run(expr)).toBe('last-green')
  })
})

describe('egress-base.mjs', () => {
  let repo: string
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  const commit = (message: string) => {
    git(
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.test',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      message,
    )
    return git('rev-parse', 'HEAD')
  }
  const pick = (before: string, head: string, runs: unknown[]) =>
    execFileSync('node', [BASE_SCRIPT, before, head], {
      cwd: repo,
      input: JSON.stringify(runs),
      encoding: 'utf8',
    }).trim()

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'egress-base-'))
    git('init', '-q', '-b', 'main')
  })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('reaches back past commits whose queued run was cancelled', () => {
    const green = commit('c1')
    const cancelled = commit('c2')
    const before = commit('c3')
    const head = commit('c4')
    const runs = [
      { head_sha: before, conclusion: 'cancelled' },
      { head_sha: cancelled, conclusion: 'cancelled' },
      { head_sha: green, conclusion: 'success' },
    ]
    expect(pick(before, head, runs)).toBe(green)
  })

  it('skips a commit whose run did not succeed even when it is the newest', () => {
    const green = commit('c1')
    const failed = commit('c2')
    const head = commit('c3')
    const runs = [
      { head_sha: failed, conclusion: 'failure' },
      { head_sha: green, conclusion: 'success' },
    ]
    expect(pick(failed, head, runs)).toBe(green)
  })

  it('falls back to the previous tip when no successful run is an ancestor', () => {
    const before = commit('c1')
    const head = commit('c2')
    expect(pick(before, head, [{ head_sha: 'f'.repeat(40), conclusion: 'success' }])).toBe(before)
    expect(pick(before, head, [])).toBe(before)
  })
})
