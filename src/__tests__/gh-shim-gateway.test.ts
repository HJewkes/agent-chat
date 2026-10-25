import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeGhShim } from '../gh-shim/install.js'
import { GH_BUDGET_URL_ENV } from '../gh-shim/rate-limit.js'

/**
 * CC-1178 b: the shim's answers read through Shepherd serve's `shepherd.ghRead` first, and only a path
 * the gateway does not answer from GitHub or its memory goes to the real gh, under the REST cooldown.
 *
 * Driven through the built `dist/gh-shim/main.js`. The gateway is a loopback fixture serving the same
 * map as the fake gh, which records every argv it receives. No network.
 */

const MAIN = path.join(import.meta.dirname, '..', '..', 'dist', 'gh-shim', 'main.js')
const REPO = 'repos/acme/widgets'
const SHA = 'a'.repeat(40)
const CLOSED_GATEWAY = 'http://127.0.0.1:1/rpc/shepherd.ghBudget'

const FAKE_GH = `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n')
if (args[0] !== 'api') { process.stdout.write('real-gh ' + args.join(' ') + '\\n'); process.exit(0) }
const body = JSON.parse(fs.readFileSync(process.env.FAKE_GH_FIXTURES, 'utf8'))[args[1]]
if (body === undefined) { process.stderr.write('HTTP 404: Not Found\\n'); process.exit(1) }
process.stdout.write(JSON.stringify(body))
`

const FIXTURES: Record<string, unknown> = {
  [`${REPO}/pulls/7`]: {
    number: 7,
    state: 'open',
    head: { ref: 'feat/widget', sha: SHA },
    base: { ref: 'main', sha: 'c'.repeat(40) },
  },
  'repos/{owner}/{repo}/pulls/7': { number: 7, head: { sha: SHA } },
  [`${REPO}/pulls/7/files?per_page=100`]: [{ filename: 'src/a.ts', additions: 3, deletions: 1 }],
  [`${REPO}/commits/${SHA}/check-runs?per_page=100`]: {
    total_count: 1,
    check_runs: [
      {
        name: 'std / verify',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-01-01T00:00:00Z',
        completed_at: '2026-01-01T00:02:28Z',
        details_url: 'https://github.com/acme/widgets/actions/runs/1/job/11',
        check_suite: { id: 55 },
        output: { title: null },
      },
    ],
  },
  [`${REPO}/commits/${SHA}/status?per_page=100`]: { state: 'pending', statuses: [] },
  [`${REPO}/actions/runs?head_sha=${SHA}&per_page=100`]: {
    workflow_runs: [{ check_suite_id: 55, name: 'CI', event: 'pull_request' }],
  },
}

const VIEW = ['pr', 'view', '7', '-R', 'acme/widgets', '--json', 'headRefOid,files,statusCheckRollup']
const CHECKS = ['pr', 'checks', '7', '-R', 'acme/widgets']

/** How the gateway fixture treats one path; unlisted paths are answered from GitHub. */
type Behaviour = 'snapshot' | 'refuse' | 'hang' | { staleSeconds: number }

interface Gateway {
  url: string
  reads: string[]
  close: () => void
}

function answerRead(res: http.ServerResponse, readPath: string, behaviour: Behaviour | undefined): void {
  if (behaviour === 'hang') return
  if (behaviour === 'refuse') {
    res.end(JSON.stringify({ ok: false, error: { message: 'not a whitelisted read route', exitCode: 77 } }))
    return
  }
  const ageMs = typeof behaviour === 'object' ? behaviour.staleSeconds * 1000 : 0
  const data = {
    status: 200,
    body: behaviour === 'snapshot' ? { number: 7, title: 'from the snapshot' } : FIXTURES[readPath],
    at: new Date(Date.now() - ageMs).toISOString(),
    stale: ageMs > 0,
    source: behaviour === 'snapshot' ? 'snapshot' : 'github',
  }
  res.end(JSON.stringify({ ok: true, data }))
}

async function startGateway(behaviours: Record<string, Behaviour> = {}, all?: Behaviour): Promise<Gateway> {
  const reads: string[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()))
    req.on('end', () => {
      if (req.url?.endsWith('/shepherd.ghBudget')) {
        res.end(JSON.stringify({ ok: true, data: { cooldowns: [] } }))
        return
      }
      const { path: readPath } = JSON.parse(raw) as { path: string }
      reads.push(readPath)
      answerRead(res, readPath, all ?? behaviours[readPath])
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/rpc/shepherd.ghBudget`,
    reads,
    close: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}

let dir: string
let env: Record<string, string>
let gateway: Gateway | undefined

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-gh-shim-gw-'))
  const fakeDir = path.join(dir, 'fake')
  fs.mkdirSync(fakeDir)
  fs.writeFileSync(path.join(fakeDir, 'gh'), FAKE_GH, { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'fixtures.json'), JSON.stringify(FIXTURES))
  const shimDir = writeGhShim(path.join(dir, 'shim'), process.execPath, MAIN, path.join(dir, 'keys'))
  env = {
    PATH: [shimDir, fakeDir, '/usr/bin', '/bin'].join(':'),
    FAKE_GH_FIXTURES: path.join(dir, 'fixtures.json'),
    FAKE_GH_LOG: path.join(dir, 'calls.jsonl'),
    XDG_STATE_HOME: path.join(dir, 'state'),
    AGENT_CHAT_NAME: 'agent-under-test',
    [GH_BUDGET_URL_ENV]: CLOSED_GATEWAY,
  }
})

afterEach(() => {
  gateway?.close()
  gateway = undefined
  fs.rmSync(dir, { recursive: true, force: true })
})

async function useGateway(behaviours: Record<string, Behaviour> = {}, all?: Behaviour): Promise<Gateway> {
  gateway = await startGateway(behaviours, all)
  env[GH_BUDGET_URL_ENV] = gateway.url
  return gateway
}

/** Async, so the gateway fixture in this process can answer while the shim waits. */
function gh(...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { cwd: dir, env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', reject)
    child.on('close', status => resolve({ status, stdout, stderr }))
  })
}

const realCalls = (): string[][] =>
  fs.existsSync(env.FAKE_GH_LOG!)
    ? fs
        .readFileSync(env.FAKE_GH_LOG!, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as string[])
    : []

const restCall = (apiPath: string): string[] => ['api', apiPath, '-i']
const ghCallsLogged = (): boolean => fs.existsSync(path.join(dir, 'state', 'gh-calls'))

function recordCooldown(lanes: readonly string[]): void {
  const until = Date.now() + 120_000
  const state = Object.fromEntries(lanes.map(lane => [lane, { until, class: 'secondary', strikes: 0 }]))
  fs.mkdirSync(path.join(dir, 'state', 'gh-budget'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'state', 'gh-budget', 'cooldown.json'), JSON.stringify(state))
}

describe('gh shim reading through the Shepherd gateway', () => {
  it('answers from the gateway with no real gh call, printing what the direct reads print', async () => {
    const direct = await gh(...VIEW)
    fs.rmSync(env.FAKE_GH_LOG!)
    fs.rmSync(path.join(dir, 'state'), { recursive: true, force: true })
    await useGateway()

    const result = await gh(...VIEW)

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(direct.stdout)
    expect(JSON.parse(result.stdout).headRefOid).toBe(SHA)
    expect(realCalls()).toEqual([])
    expect(ghCallsLogged()).toBe(false)
  })

  it('reads every path directly when the gateway is closed', async () => {
    const result = await gh(...VIEW)

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).headRefOid).toBe(SHA)
    expect(realCalls()).toEqual([
      restCall(`${REPO}/pulls/7`),
      restCall(`${REPO}/pulls/7/files?per_page=100`),
      restCall(`${REPO}/commits/${SHA}/check-runs?per_page=100`),
      restCall(`${REPO}/commits/${SHA}/status?per_page=100`),
      restCall(`${REPO}/actions/runs?head_sha=${SHA}&per_page=100`),
    ])
    expect(ghCallsLogged()).toBe(true)
  })

  it('reads a snapshot-sourced pull directly, since the snapshot is not GitHub JSON', async () => {
    await useGateway({ [`${REPO}/pulls/7`]: 'snapshot' })

    const result = await gh('pr', 'view', '7', '-R', 'acme/widgets', '--json', 'headRefOid')

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ headRefOid: SHA })
    expect(realCalls()).toEqual([restCall(`${REPO}/pulls/7`)])
  })

  it('sends only a refused path direct and keeps asking the gateway for the rest', async () => {
    const gw = await useGateway({ [`${REPO}/pulls/7`]: 'refuse' })

    const result = await gh(...VIEW)

    expect(result.status).toBe(0)
    expect(realCalls()).toEqual([restCall(`${REPO}/pulls/7`)])
    expect(gw.reads).toHaveLength(5)
  })

  it('never asks the gateway for a path holding the {owner}/{repo} placeholder', async () => {
    const gw = await useGateway()

    const result = await gh('pr', 'view', '7', '--json', 'headRefOid')

    expect(result.status).toBe(0)
    expect(gw.reads).toEqual([])
    expect(realCalls()).toEqual([restCall('repos/{owner}/{repo}/pulls/7')])
  })

  it('stops asking a gateway that never replies after one try', async () => {
    const gw = await useGateway({}, 'hang')

    const result = await gh(...CHECKS)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('std / verify')
    expect(gw.reads).toHaveLength(1)
    expect(realCalls()).toHaveLength(4)
  })

  it('prints the age of a stale gateway answer on stderr and leaves stdout as it was', async () => {
    const fresh = await gh(...VIEW)
    await useGateway({ [`${REPO}/pulls/7`]: { staleSeconds: 42 } })

    const result = await gh(...VIEW)

    expect(result.status).toBe(0)
    expect(result.stderr).toContain('gh-budget: stale 42s\n')
    expect(result.stdout).toBe(fresh.stdout)
  })
})

describe('gh shim gateway reads during a cooldown', () => {
  it('answers from the gateway while both lanes cool, with no real gh call', async () => {
    recordCooldown(['rest', 'graphql'])
    await useGateway()

    const result = await gh(...VIEW)

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).headRefOid).toBe(SHA)
    expect(realCalls()).toEqual([])
  })

  it('sends no direct REST read while REST cools and the gateway is closed, passing the command through', async () => {
    recordCooldown(['rest'])

    const result = await gh(...VIEW)

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`real-gh ${VIEW.join(' ')}\n`)
    expect(realCalls()).toEqual([VIEW])
  })
})
