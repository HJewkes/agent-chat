import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GhCallLine } from '../gh-calls/log.js'
import { parseIncluded } from '../gh-shim/call-log.js'
import { callShape } from '../gh-shim/call-shape.js'
import { writeGhShim } from '../gh-shim/install.js'
import { GH_BUDGET_URL_ENV } from '../gh-shim/rate-limit.js'
import { expectSpawned } from './helpers/spawn-result.js'

/**
 * TP-1172 b: every real-gh call the shim makes, answered or passed through, appends one gh-calls
 * line, and what the caller sees on stdout and stderr is what it saw before.
 *
 * Driven through the built `dist/gh-shim/main.js` with a fake gh that answers each argv from a
 * fixture map. The log is read from the day file under a temporary XDG_STATE_HOME.
 */

const MAIN = path.join(import.meta.dirname, '..', '..', 'dist', 'gh-shim', 'main.js')
const REPO = 'repos/acme/widgets'

/** Answers `argv.join(' ')` from the fixture map with its stdout, stderr and exit code. */
const FAKE_GH = `#!${process.execPath}
const fs = require('node:fs')
const key = process.argv.slice(2).join(' ')
const fixture = JSON.parse(fs.readFileSync(process.env.FAKE_GH_FIXTURES, 'utf8'))[key]
if (fixture === undefined) { process.stderr.write('no fixture: ' + key + '\\n'); process.exit(9) }
process.stdout.write(fixture.stdout ?? '')
process.stderr.write(fixture.stderr ?? '')
process.exit(fixture.code ?? 0)
`

interface Fixture {
  stdout?: string
  stderr?: string
  code?: number
}

const PULL = { number: 7, title: 'Add widget' }

const included = (status: string, headers: Record<string, string>, body: string): string =>
  [`HTTP/2.0 ${status}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', body].join('\r\n')

let dir: string
let env: Record<string, string>

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-gh-shim-log-'))
  const fakeDir = path.join(dir, 'fake')
  fs.mkdirSync(fakeDir)
  fs.writeFileSync(path.join(fakeDir, 'gh'), FAKE_GH, { mode: 0o755 })
  const shimDir = writeGhShim(path.join(dir, 'shim'), process.execPath, MAIN, path.join(dir, 'keys'))
  env = {
    PATH: [shimDir, fakeDir, '/usr/bin', '/bin'].join(':'),
    FAKE_GH_FIXTURES: path.join(dir, 'fixtures.json'),
    XDG_STATE_HOME: path.join(dir, 'state'),
    // Port 1 refuses at once, so a live Shepherd serve's ghBudget never gates these reads.
    [GH_BUDGET_URL_ENV]: 'http://127.0.0.1:1/rpc/shepherd.ghBudget',
    AGENT_CHAT_NAME: 'tc-test-agent',
  }
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function gh(fixtures: Record<string, Fixture>, ...args: string[]) {
  fs.writeFileSync(env.FAKE_GH_FIXTURES!, JSON.stringify(fixtures))
  return expectSpawned(spawnSync('gh', args, { cwd: dir, env, encoding: 'utf8' }), `gh ${args.join(' ')}`)
}

function logged(): GhCallLine[] {
  const logDir = path.join(dir, 'state', 'gh-calls')
  if (!fs.existsSync(logDir)) return []
  return fs
    .readdirSync(logDir)
    .flatMap(name => fs.readFileSync(path.join(logDir, name), 'utf8').trim().split('\n'))
    .map(line => JSON.parse(line) as GhCallLine)
}

const VIEW = ['pr', 'view', '7', '--repo', 'acme/widgets', '--json', 'number,title']
const VIEW_KEY = `api ${REPO}/pulls/7 -i`

describe('gh shim logging the reads it answers from REST', () => {
  it('logs one line with the rate-limit headers and prints exactly what the body alone gave', () => {
    const headers = {
      'X-Ratelimit-Remaining': '4210',
      'X-Ratelimit-Resource': 'core',
      'X-Ratelimit-Used': '790',
    }
    const bodyOnly = gh({ [VIEW_KEY]: { stdout: JSON.stringify(PULL) } }, ...VIEW)
    fs.rmSync(path.join(dir, 'state'), { recursive: true, force: true })

    const result = gh({ [VIEW_KEY]: { stdout: included('200 OK', headers, JSON.stringify(PULL)) } }, ...VIEW)

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(bodyOnly.stdout)
    expect(JSON.parse(result.stdout)).toEqual(PULL)
    expect(logged()).toEqual([
      expect.objectContaining({
        v: 1,
        caller: 'tc-test-agent',
        api: 'rest',
        method: 'GET',
        route: 'repos/{o}/{r}/pulls/{n}',
        status: 200,
        remaining: 4210,
        resource: 'core',
        used: 790,
      }),
    ])
  })

  it('logs a refused read before falling back to the real gh, classified and without its text', () => {
    const refusal = 'gh: You have exceeded a secondary rate limit. (HTTP 403)\n'
    const fixtures = {
      [VIEW_KEY]: {
        stdout: included('403 Forbidden', { 'X-Ratelimit-Remaining': '4999', 'Retry-After': '60' }, '{}'),
        stderr: refusal,
        code: 1,
      },
      [VIEW.join(' ')]: { stdout: 'from the real gh\n' },
    }

    const result = gh(fixtures, ...VIEW)

    expect(result.stdout).toBe('from the real gh\n')
    const lines = logged()
    expect(lines.map(line => [line.method, line.route, line.status])).toEqual([
      ['GET', 'repos/{o}/{r}/pulls/{n}', 403],
      ['CLI', 'pr view', 'ok'],
    ])
    expect(lines[0]).toMatchObject({ remaining: 4999, retryAfter: 60, limit: 'secondary' })
    expect(JSON.stringify(lines)).not.toContain('exceeded')
  })
})

describe('gh shim logging the commands it passes through', () => {
  it('re-emits an -i call byte for byte and logs its status and headers', () => {
    const stdout = included(
      '200 OK',
      { 'X-Ratelimit-Remaining': '12', 'X-Ratelimit-Resource': 'core', 'X-Ratelimit-Reset': '1760000000' },
      '[{"filename":"a.ts"}]',
    )
    const args = ['api', '-i', `${REPO}/pulls/755/files?per_page=100`]

    const result = gh({ [args.join(' ')]: { stdout, stderr: 'a warning\n' } }, ...args)

    expect(result.stdout).toBe(stdout)
    expect(result.stderr).toBe('a warning\n')
    expect(logged()).toEqual([
      expect.objectContaining({
        route: 'repos/{o}/{r}/pulls/{n}/files',
        status: 200,
        remaining: 12,
        resource: 'core',
        reset: 1760000000,
      }),
    ])
  })

  it('reads the status of a call without -i from gh’s error text and keeps its exit code', () => {
    const args = ['api', 'repos/acme/widgets/pulls/7']
    const stderr = 'gh: API rate limit exceeded for user (HTTP 403)\n'

    const result = gh({ [args.join(' ')]: { stderr, code: 1 } }, ...args)

    expect(result.status).toBe(1)
    expect(result.stderr).toBe(stderr)
    expect(logged()).toEqual([
      expect.objectContaining({
        api: 'rest',
        method: 'GET',
        route: 'repos/{o}/{r}/pulls/{n}',
        status: 403,
        limit: 'primary',
      }),
    ])
  })

  it('names the caller shim when AGENT_CHAT_NAME is unset, and logs nothing for a local command', () => {
    delete env.AGENT_CHAT_NAME
    gh({ '--version': { stdout: 'gh version 2\n' } }, '--version')
    const result = gh(
      { 'repo view acme/widgets': { stdout: 'acme/widgets\n' } },
      'repo',
      'view',
      'acme/widgets',
    )

    expect(result.stdout).toBe('acme/widgets\n')
    expect(logged()).toEqual([
      expect.objectContaining({
        caller: 'shim',
        api: 'graphql',
        method: 'CLI',
        route: 'repo view',
        status: 'ok',
      }),
    ])
  })
})

describe('reading a gh call', () => {
  it('separates headers from the body at the first blank line', () => {
    const parsed = parseIncluded(included('404 Not Found', { 'X-Ratelimit-Remaining': '3' }, '{"a":1}'))

    expect(parsed?.status).toBe(404)
    expect(parsed?.headers.get('x-ratelimit-remaining')).toBe('3')
    expect(parsed?.body).toBe('{"a":1}')
  })

  it('takes the method and endpoint from gh api flags in any position', () => {
    expect(callShape(['api', '-X', 'PATCH', `${REPO}/pulls/3`, '-f', 'title=x'])).toMatchObject({
      api: 'rest',
      method: 'PATCH',
      route: 'repos/{o}/{r}/pulls/{n}',
    })
    expect(callShape(['api', '--jq', '.x', `${REPO}/issues/4/comments`, '-F', 'body=@-'])).toMatchObject({
      method: 'POST',
      route: 'repos/{o}/{r}/issues/{n}/comments',
      include: false,
    })
    expect(callShape(['run', 'view', '12', '--log-failed'])).toMatchObject({ api: 'rest', route: 'run view' })
    expect(callShape(['pr', 'merge', '--help'])).toBeUndefined()
  })
})
