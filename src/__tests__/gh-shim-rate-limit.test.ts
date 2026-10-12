import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeGhShim } from '../gh-shim/install.js'
import { GH_BUDGET_URL_ENV } from '../gh-shim/rate-limit.js'
import { expectSpawned } from './helpers/spawn-result.js'

/**
 * CC-1162: a rate-limited passthrough call starts a shared cooldown, and while it lasts the shim's
 * reads make no real-gh call and `gh api rate_limit` reports the lane spent.
 *
 * Driven through the built `dist/gh-shim/main.js` with a fake gh that answers from a fixture map and
 * appends every argv it receives to a call log. No network: the gateway is a loopback fixture or a
 * port that refuses.
 */

const MAIN = path.join(import.meta.dirname, '..', '..', 'dist', 'gh-shim', 'main.js')
const CLOSED_GATEWAY = 'http://127.0.0.1:1/rpc/shepherd.ghBudget'

const FAKE_GH = `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n')
const fixture = JSON.parse(fs.readFileSync(process.env.FAKE_GH_FIXTURES, 'utf8'))[args.join(' ')]
if (fixture === undefined) { process.stderr.write('no fixture: ' + args.join(' ') + '\\n'); process.exit(9) }
process.stdout.write(fixture.stdout ?? '')
process.stderr.write(fixture.stderr ?? '')
process.exit(fixture.code ?? 0)
`

interface Fixture {
  stdout?: string
  stderr?: string
  code?: number
}

const COMMENTS = ['api', 'repos/acme/widgets/issues/7/comments']
const ISSUE = ['api', 'repos/acme/widgets/issues/7']
const GRAPHQL = ['api', 'graphql', '-f', 'query={viewer{login}}']
const COMMENT_WRITE = ['api', '-X', 'POST', 'repos/acme/widgets/issues/7/comments', '-f', 'body=hi']

const SECONDARY_403: Fixture = {
  stderr: 'gh: You have exceeded a secondary rate limit. (HTTP 403)\n',
  code: 1,
}
const REAL_RATE_LIMIT = JSON.stringify({
  resources: {
    core: { limit: 5000, used: 0, remaining: 5000, reset: 1 },
    graphql: { limit: 5000, used: 0, remaining: 5000, reset: 1 },
  },
  rate: { limit: 5000, used: 0, remaining: 5000, reset: 1 },
})
const FIXTURES: Record<string, Fixture> = {
  [COMMENTS.join(' ')]: SECONDARY_403,
  [ISSUE.join(' ')]: { stdout: '{"number":7}\n' },
  [GRAPHQL.join(' ')]: { stdout: '{"data":{"viewer":{"login":"someone"}}}\n' },
  [COMMENT_WRITE.join(' ')]: { stdout: '{"id":1}\n' },
  // The real endpoint under the secondary limit: plenty of core quota left. The shim reads it with -i;
  // the bare form is what a shim deciding from /rate_limit would print.
  'api rate_limit -i': {
    stdout: ['HTTP/2.0 200 OK', 'X-Ratelimit-Resource: core', '', REAL_RATE_LIMIT].join('\r\n'),
  },
  'api rate_limit': { stdout: `${REAL_RATE_LIMIT}\n` },
}

let dir: string
let env: Record<string, string>

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-gh-shim-rl-'))
  const fakeDir = path.join(dir, 'fake')
  fs.mkdirSync(fakeDir)
  fs.writeFileSync(path.join(fakeDir, 'gh'), FAKE_GH, { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'fixtures.json'), JSON.stringify(FIXTURES))
  const shimDir = writeGhShim(path.join(dir, 'shim'), process.execPath, MAIN)
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
  fs.rmSync(dir, { recursive: true, force: true })
})

const gh = (...args: string[]) =>
  expectSpawned(spawnSync('gh', args, { cwd: dir, env, encoding: 'utf8' }), `gh ${args.join(' ')}`)

/** Async, so a gateway fixture served from this process can answer while the shim waits. */
function ghAsync(...args: string[]): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { cwd: dir, env })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', reject)
    child.on('close', status => resolve({ status, stderr }))
  })
}

const realCalls = (): string[][] => {
  const log = env.FAKE_GH_LOG!
  if (!fs.existsSync(log)) return []
  return fs
    .readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as string[])
}

const restCooldownEnd = (): number => {
  const state = JSON.parse(
    fs.readFileSync(path.join(dir, 'state', 'gh-budget', 'cooldown.json'), 'utf8'),
  ) as {
    rest: { until: number }
  }
  return state.rest.until
}

describe('gh shim shared cooldown', () => {
  it('stops sending reads once a passthrough read hit the secondary limit', () => {
    const refused = gh(...COMMENTS)

    const next = gh(...ISSUE)

    expect(refused.status).toBe(1)
    expect(refused.stderr).toBe(SECONDARY_403.stderr)
    expect(realCalls()).toEqual([COMMENTS])
    expect(next.status).toBe(1)
    expect(next.stdout).toBe('')
    expect(next.stderr).toMatch(
      /GitHub rest calls are cooling down after a secondary rate limit \(observed\)/,
    )
  })

  it('stops sending reads while the ghBudget gateway reports a cooldown', async () => {
    const until = Date.now() + 120_000
    const envelope = { ok: true, data: { cooldowns: [{ lane: 'rest', until, class: 'secondary' }] } }
    const server = http.createServer((_req, res) => res.end(JSON.stringify(envelope)))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    env[GH_BUDGET_URL_ENV] =
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/rpc/shepherd.ghBudget`

    try {
      const result = await ghAsync(...ISSUE)

      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/cooling down after a secondary rate limit \(gateway\)/)
      expect(realCalls()).toEqual([])
    } finally {
      server.close()
    }
  })

  it('answers rate_limit with core spent until the cooldown ends, whatever /rate_limit says', () => {
    gh(...COMMENTS)

    const result = gh('api', 'rate_limit')

    const body = JSON.parse(result.stdout) as {
      resources: Record<string, { remaining: number; reset: number }>
      rate: { remaining: number; reset: number }
    }
    const reset = Math.ceil(restCooldownEnd() / 1000)
    expect(result.status).toBe(0)
    expect(body.resources.core).toEqual({ limit: 5000, used: 5000, remaining: 0, reset })
    expect(body.rate).toEqual({ limit: 5000, used: 5000, remaining: 0, reset })
    expect(body.resources.graphql?.remaining).toBe(5000)
  })

  it('leaves the GraphQL lane open during a REST cooldown', () => {
    gh(...COMMENTS)

    const result = gh(...GRAPHQL)

    expect(result.status).toBe(0)
    expect(realCalls()).toEqual([COMMENTS, GRAPHQL])
  })

  it('still sends a write during a cooldown, since gh-write waits rather than failing', () => {
    gh(...COMMENTS)

    const result = gh(...COMMENT_WRITE)

    expect(result.status).toBe(0)
    expect(realCalls()).toEqual([COMMENTS, COMMENT_WRITE])
  })

  it('treats a gateway that is down as no cooldown', () => {
    const result = gh(...ISSUE)

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('{"number":7}\n')
    expect(realCalls()).toEqual([ISSUE])
  })
})
