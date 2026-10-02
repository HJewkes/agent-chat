import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseRequest } from '../gh-shim/argv.js'
import { writeGhShim } from '../gh-shim/install.js'

/**
 * CC-395: the `gh` on an agent's PATH answers read-only commands from REST.
 *
 * Driven end to end through the script `run-agent` writes, against the built `dist/gh-shim/main.js`,
 * with a fake gh behind it that records every argv. That record is the claim under test: the listed
 * subcommands reach the real gh only as `gh api <REST path>`, never as GraphQL.
 */

const MAIN = path.join(import.meta.dirname, '..', '..', 'dist', 'gh-shim', 'main.js')
const REPO = 'repos/acme/widgets'
const SHA = 'a'.repeat(40)

/** Serves `api <path>` from a fixture map, popping arrays in order; anything else reports itself as the real gh. */
const FAKE_GH = `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n')
if (args[0] !== 'api') { process.stdout.write('real-gh ' + args.join(' ') + '\\n'); process.exit(0) }
const fixtures = JSON.parse(fs.readFileSync(process.env.FAKE_GH_FIXTURES, 'utf8'))
let body = fixtures[args[1]]
if (Array.isArray(body) && body[0] === '__sequence') {
  body = body.splice(1, 1)[0] ?? body[1]
  fs.writeFileSync(process.env.FAKE_GH_FIXTURES, JSON.stringify(fixtures))
}
if (body === undefined) { process.stderr.write('HTTP 404: Not Found\\n'); process.exit(1) }
process.stdout.write(JSON.stringify(body))
`

const pull = (overrides: Record<string, unknown> = {}) => ({
  number: 7,
  node_id: 'PR_node7',
  title: 'Add widget',
  body: null,
  state: 'closed',
  merged_at: '2026-01-02T03:04:05Z',
  merge_commit_sha: 'b'.repeat(40),
  html_url: 'https://github.com/acme/widgets/pull/7',
  draft: false,
  created_at: '2026-01-01T00:00:00Z',
  user: { login: 'octo', node_id: 'U_octo', type: 'User' },
  labels: [{ name: 'bug', color: 'ff0000', description: 'broken', node_id: 'L_bug' }],
  head: { ref: 'feat/widget', sha: SHA, repo: { full_name: 'acme/widgets' } },
  base: { ref: 'main', sha: 'c'.repeat(40), repo: { full_name: 'acme/widgets' } },
  mergeable: true,
  mergeable_state: 'clean',
  additions: 3,
  deletions: 1,
  changed_files: 1,
  ...overrides,
})

const checkRun = (name: string, status: string, conclusion: string | null, id: number) => ({
  name,
  status,
  conclusion,
  started_at: '2026-01-01T00:00:00Z',
  completed_at: status === 'completed' ? '2026-01-01T00:02:28Z' : null,
  details_url: `https://github.com/acme/widgets/actions/runs/1/job/${id}`,
  check_suite: { id: 55 },
  output: { title: null },
})

const checksFixtures = (runs: unknown[]) => ({
  [`${REPO}/commits/${SHA}/check-runs?per_page=100`]: { total_count: runs.length, check_runs: runs },
  [`${REPO}/commits/${SHA}/status?per_page=100`]: { state: 'pending', statuses: [] },
  [`${REPO}/actions/runs?head_sha=${SHA}&per_page=100`]: {
    workflow_runs: [{ check_suite_id: 55, name: 'CI', event: 'pull_request' }],
  },
})

let dir: string
let logFile: string
let fixturesFile: string
let env: Record<string, string>

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-gh-shim-'))
  const fakeDir = path.join(dir, 'fake')
  fs.mkdirSync(fakeDir)
  fs.writeFileSync(path.join(fakeDir, 'gh'), FAKE_GH, { mode: 0o755 })
  const shimDir = writeGhShim(path.join(dir, 'shim'), process.execPath, MAIN)
  logFile = path.join(dir, 'gh.log')
  fixturesFile = path.join(dir, 'fixtures.json')
  env = {
    PATH: [shimDir, fakeDir, '/usr/bin', '/bin'].join(':'),
    FAKE_GH_LOG: logFile,
    FAKE_GH_FIXTURES: fixturesFile,
  }
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function gh(fixtures: Record<string, unknown>, ...args: string[]) {
  fs.writeFileSync(fixturesFile, JSON.stringify(fixtures))
  return spawnSync('gh', args, { cwd: dir, env, encoding: 'utf8' })
}

const calls = (): string[][] =>
  fs.existsSync(logFile)
    ? fs
        .readFileSync(logFile, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as string[])
    : []

/** Every call the shim made is `gh api <path>` with a REST path, which is the whole point of it. */
function expectRestOnly(): void {
  expect(calls().length).toBeGreaterThan(0)
  for (const argv of calls()) {
    expect(argv).toHaveLength(2)
    expect(argv[0]).toBe('api')
    expect(argv[1]).toMatch(/^repos\//)
  }
}

describe('gh shim answering pr view from REST', () => {
  it('maps the pull fields agents ask for, keys sorted, with no GraphQL call', () => {
    const fixtures = { [`${REPO}/pulls/7`]: pull() }
    const fields =
      'number,state,headRefOid,headRefName,mergeable,mergedAt,title,body,url,author,labels,mergeCommit,isDraft'

    const result = gh(fixtures, 'pr', 'view', '7', '--repo', 'acme/widgets', '--json', fields)

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      author: { id: 'U_octo', is_bot: false, login: 'octo', name: '' },
      body: '',
      headRefName: 'feat/widget',
      headRefOid: SHA,
      isDraft: false,
      labels: [{ color: 'ff0000', description: 'broken', id: 'L_bug', name: 'bug' }],
      mergeCommit: { oid: 'b'.repeat(40) },
      mergeable: 'MERGEABLE',
      mergedAt: '2026-01-02T03:04:05Z',
      number: 7,
      state: 'MERGED',
      title: 'Add widget',
      url: 'https://github.com/acme/widgets/pull/7',
    })
    expect(Object.keys(JSON.parse(result.stdout))).toEqual(fields.split(',').sort())
    expectRestOnly()
  })

  it('builds statusCheckRollup from check runs, statuses and the workflow run', () => {
    const fixtures = {
      [`${REPO}/pulls/7`]: pull({ state: 'open', merged_at: null }),
      ...checksFixtures([checkRun('std / verify', 'completed', 'success', 11)]),
    }

    const result = gh(fixtures, 'pr', 'view', '7', '-R', 'acme/widgets', '--json', 'state,statusCheckRollup')

    expect(JSON.parse(result.stdout)).toEqual({
      state: 'OPEN',
      statusCheckRollup: [
        {
          __typename: 'CheckRun',
          completedAt: '2026-01-01T00:02:28Z',
          conclusion: 'SUCCESS',
          detailsUrl: 'https://github.com/acme/widgets/actions/runs/1/job/11',
          name: 'std / verify',
          startedAt: '2026-01-01T00:00:00Z',
          status: 'COMPLETED',
          workflowName: 'CI',
        },
      ],
    })
    expectRestOnly()
  })

  it('applies --jq the way gh does, printing a string raw', () => {
    const result = gh(
      { [`${REPO}/pulls/7`]: pull() },
      'pr',
      'view',
      '7',
      '-R',
      'acme/widgets',
      '--json',
      'headRefOid',
      '--jq',
      '.headRefOid',
    )

    expect(result.stdout).toBe(`${SHA}\n`)
    expectRestOnly()
  })

  it('finds the pull for the current branch through the head filter when no number is given', () => {
    spawnSync('git', ['init', '-q', '-b', 'feat/widget', dir])
    const fixtures = {
      'repos/{owner}/{repo}': { owner: { login: 'acme' } },
      'repos/{owner}/{repo}/pulls?head=acme%3Afeat%2Fwidget&per_page=1&state=open': [pull()],
      'repos/{owner}/{repo}/pulls/7': pull(),
    }

    const result = gh(fixtures, 'pr', 'view', '--json', 'number')

    expect(result.stdout).toBe('{"number":7}\n')
    expect(calls().every(argv => argv[0] === 'api' && !argv[1]?.startsWith('graphql'))).toBe(true)
  })
})

describe('gh shim answering pr list from REST', () => {
  it('lists merged pulls by filtering closed ones on merged_at', () => {
    const fixtures = {
      [`${REPO}/pulls?state=closed&per_page=100`]: [pull(), pull({ number: 8, merged_at: null })],
    }

    const result = gh(
      fixtures,
      'pr',
      'list',
      '--repo',
      'acme/widgets',
      '--state',
      'merged',
      '--json',
      'number,state,headRefName',
    )

    expect(JSON.parse(result.stdout)).toEqual([{ headRefName: 'feat/widget', number: 7, state: 'MERGED' }])
    expectRestOnly()
  })
})

describe('gh shim answering pr checks from REST', () => {
  it('prints gh’s tab-separated table and exits 1 when a check failed', () => {
    const fixtures = {
      [`${REPO}/pulls/7`]: pull(),
      ...checksFixtures([
        checkRun('lint', 'completed', 'success', 1),
        checkRun('test', 'completed', 'failure', 2),
      ]),
    }

    const result = gh(fixtures, 'pr', 'checks', '7', '--repo', 'acme/widgets')

    expect(result.stdout).toBe(
      'test\tfail\t2m28s\thttps://github.com/acme/widgets/actions/runs/1/job/2\t\n' +
        'lint\tpass\t2m28s\thttps://github.com/acme/widgets/actions/runs/1/job/1\t\n',
    )
    expect(result.status).toBe(1)
    expectRestOnly()
  })

  it('exits 8 while a check is still running', () => {
    const fixtures = {
      [`${REPO}/pulls/7`]: pull(),
      ...checksFixtures([checkRun('test', 'in_progress', null, 2)]),
    }

    const result = gh(fixtures, 'pr', 'checks', '7', '--repo', 'acme/widgets')

    expect(result.stdout).toBe('test\tpending\t0\thttps://github.com/acme/widgets/actions/runs/1/job/2\t\n')
    expect(result.status).toBe(8)
  })

  it('emits the check fields as JSON', () => {
    const fixtures = {
      [`${REPO}/pulls/7`]: pull(),
      ...checksFixtures([checkRun('test', 'completed', 'success', 2)]),
    }

    const result = gh(
      fixtures,
      'pr',
      'checks',
      '7',
      '--repo',
      'acme/widgets',
      '--json',
      'name,bucket,state,workflow,event',
    )

    expect(JSON.parse(result.stdout)).toEqual([
      { bucket: 'pass', event: 'pull_request', name: 'test', state: 'SUCCESS', workflow: 'CI' },
    ])
    expectRestOnly()
  })
})

describe('gh shim leaving oversized check lists to the real gh', () => {
  const prChecksArgs = ['pr', 'checks', '7', '--repo', 'acme/widgets']

  it('passes pr checks through when check-runs total more than one page returned', () => {
    const fixtures: Record<string, unknown> = checksFixtures([checkRun('lint', 'completed', 'success', 1)])
    const key = `${REPO}/commits/${SHA}/check-runs?per_page=100`
    fixtures[key] = { total_count: 101, check_runs: [checkRun('lint', 'completed', 'success', 1)] }

    const result = gh({ [`${REPO}/pulls/7`]: pull(), ...fixtures }, ...prChecksArgs)

    expect(calls().at(-1)).toEqual(prChecksArgs)
    expect(result.stdout).toBe(`real-gh ${prChecksArgs.join(' ')}\n`)
  })

  it('passes pr checks through when statuses total more than one page returned', () => {
    const fixtures: Record<string, unknown> = checksFixtures([checkRun('lint', 'completed', 'success', 1)])
    fixtures[`${REPO}/commits/${SHA}/status?per_page=100`] = { total_count: 101, statuses: [] }

    gh({ [`${REPO}/pulls/7`]: pull(), ...fixtures }, ...prChecksArgs)

    expect(calls().at(-1)).toEqual(prChecksArgs)
  })
})

const run = (status: string, conclusion: string | null) => ({
  id: 99,
  name: 'CI',
  status,
  conclusion,
  head_sha: SHA,
  head_branch: 'feat/widget',
  run_attempt: 1,
  html_url: 'https://github.com/acme/widgets/actions/runs/99',
})

const jobs = {
  jobs: [
    {
      id: 5,
      name: 'test',
      status: 'completed',
      conclusion: 'failure',
      started_at: '2026-01-01T00:00:00Z',
      completed_at: '2026-01-01T00:00:22Z',
      html_url: 'https://github.com/acme/widgets/actions/runs/99/job/5',
      steps: [],
    },
  ],
}

describe('gh shim answering run view and run watch from REST', () => {
  it('maps run view --json fields and jobs', () => {
    const fixtures = {
      [`${REPO}/actions/runs/99`]: run('completed', 'failure'),
      [`${REPO}/actions/runs/99/jobs?per_page=100`]: jobs,
    }

    const result = gh(
      fixtures,
      'run',
      'view',
      '99',
      '--repo',
      'acme/widgets',
      '--json',
      'conclusion,headSha,jobs',
    )

    expect(JSON.parse(result.stdout)).toEqual({
      conclusion: 'failure',
      headSha: SHA,
      jobs: [
        {
          completedAt: '2026-01-01T00:00:22Z',
          conclusion: 'failure',
          databaseId: 5,
          name: 'test',
          startedAt: '2026-01-01T00:00:00Z',
          status: 'completed',
          steps: [],
          url: 'https://github.com/acme/widgets/actions/runs/99/job/5',
        },
      ],
    })
    expectRestOnly()
  })

  it('polls until the run completes, then exits 1 under --exit-status for a failed run', () => {
    const fixtures = {
      [`${REPO}/actions/runs/99`]: ['__sequence', run('in_progress', null), run('completed', 'failure')],
      [`${REPO}/actions/runs/99/jobs?per_page=100`]: jobs,
    }

    const result = gh(
      fixtures,
      'run',
      'watch',
      '99',
      '--repo',
      'acme/widgets',
      '--exit-status',
      '--interval',
      '1',
    )

    expect(result.stdout).toContain('X test in 22s (ID 5)')
    expect(result.stdout).toContain("Run CI (99) completed with 'failure'")
    expect(result.status).toBe(1)
    expect(calls().filter(argv => argv[1] === `${REPO}/actions/runs/99`)).toHaveLength(2)
    expectRestOnly()
  })
})

describe('gh shim passing commands through to the real gh', () => {
  it('hands an unhandled command to the real gh untouched, writes included', () => {
    const result = gh({}, 'pr', 'merge', '7', '--squash', '--repo', 'acme/widgets')

    expect(result.stdout).toBe('real-gh pr merge 7 --squash --repo acme/widgets\n')
    expect(calls()).toEqual([['pr', 'merge', '7', '--squash', '--repo', 'acme/widgets']])
  })

  it('passes through a field it cannot answer from REST without spending any API call', () => {
    gh({}, 'pr', 'view', '7', '--repo', 'acme/widgets', '--json', 'reviewDecision')

    expect(calls()).toEqual([['pr', 'view', '7', '--repo', 'acme/widgets', '--json', 'reviewDecision']])
  })

  it('falls back to the real gh when a REST read fails, so the error is gh’s own', () => {
    const result = gh({}, 'pr', 'view', '404', '--repo', 'acme/widgets', '--json', 'number')

    expect(calls()).toEqual([
      ['api', `${REPO}/pulls/404`],
      ['pr', 'view', '404', '--repo', 'acme/widgets', '--json', 'number'],
    ])
    expect(result.stdout).toBe('real-gh pr view 404 --repo acme/widgets --json number\n')
  })

  it('passes everything through when AGENT_CHAT_GH_SHIM_OFF is 1', () => {
    env.AGENT_CHAT_GH_SHIM_OFF = '1'

    gh({}, 'pr', 'view', '7', '--repo', 'acme/widgets', '--json', 'number')

    expect(calls()).toEqual([['pr', 'view', '7', '--repo', 'acme/widgets', '--json', 'number']])
  })
})

describe('gh shim argument parsing', () => {
  it.each([
    ['pr view without --json', ['pr', 'view', '7']],
    ['pr view --web', ['pr', 'view', '7', '--web']],
    ['pr checks --watch', ['pr', 'checks', '7', '--watch']],
    ['pr list --search', ['pr', 'list', '--search', 'x', '--json', 'number']],
    ['run view --log-failed', ['run', 'view', '99', '--log-failed']],
    ['a repeated flag', ['pr', 'view', '7', '--json', 'number', '--json', 'title']],
  ])('leaves %s to the real gh', (_name, argv) => {
    expect(parseRequest(argv)).toBeUndefined()
  })

  it.each(['0', '0.5', '0.001', '1.5', '-2', 'abc'])(
    'leaves run watch --interval %s to the real gh',
    interval => {
      expect(parseRequest(['run', 'watch', '99', '--interval', interval])).toBeUndefined()
    },
  )

  it('accepts a whole-second run watch interval of 1', () => {
    expect(parseRequest(['run', 'watch', '99', '-i', '1'])).toMatchObject({ intervalSec: 1 })
  })

  it('reads --flag=value forms', () => {
    expect(
      parseRequest(['run', 'watch', '99', '--repo=acme/widgets', '--interval=30', '--exit-status']),
    ).toEqual({
      kind: 'run-watch',
      repo: 'acme/widgets',
      runId: '99',
      exitStatus: true,
      intervalSec: 30,
    })
  })
})
