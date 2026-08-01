import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  ErrorResponse,
  HealthPayload,
  HistoryResponse,
  QueueResponse,
  SessionsResponse,
  TranscriptResponse,
  VerdictResponse,
} from '../api-contract.js'
import { TOKEN_HEADER } from '../api-contract.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { buildHttpApp } from '../broker/http.js'
import { projectSlug } from '../agents/transcript.js'
import { dashboardDir } from '../paths.js'
import { Registry } from '../broker/registry.js'
import { HUMAN } from '../protocol.js'

/**
 * The HTTP surface, driven through `app.fetch()` with no port bound.
 *
 * That is the whole reason `buildHttpApp` is a pure factory: every route,
 * including the auth middleware and the SSE stream, is exercisable as an
 * ordinary in-process unit test with no daemon, no socket and nothing to clean
 * up but a temp database.
 */

const tmpDirs: string[] = []
const PORT = 7600

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

function makeCore(): BrokerCore {
  const dir = tmpDir('agent-chat-http-')
  return new BrokerCore(() => undefined, {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
  })
}

const fakeConn = (): Conn => ({}) as unknown as net.Socket

const app = (core: BrokerCore, options: Partial<Parameters<typeof buildHttpApp>[0]> = {}) =>
  buildHttpApp({ core, port: () => PORT, ...options })

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('GET /health', () => {
  it('reports the bound port, the socket and live counts', async () => {
    const core = makeCore()
    core.append({ kind: 'question', actor: 'alpha', target: HUMAN, body: 'blocked on what?' })

    const res = await app(core).fetch(new Request('http://127.0.0.1/health'))
    const body = (await res.json()) as HealthPayload

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.port).toBe(PORT)
    expect(body.pid).toBe(process.pid)
    expect(body.queue_open).toBe(1)
    expect(body.socket).toMatch(/chat\.sock$/)
  })

  it('reports port null when the bind was refused, rather than the port we wanted', async () => {
    const res = await app(makeCore(), { port: () => null }).fetch(new Request('http://127.0.0.1/health'))
    expect(((await res.json()) as HealthPayload).port).toBeNull()
  })
})

describe('GET /api/queue', () => {
  it('returns open items and omits ones already resolved', async () => {
    const core = makeCore()
    const open = core.append({ kind: 'question', actor: 'alpha', target: HUMAN, body: 'still open' })
    const closed = core.append({ kind: 'question', actor: 'beta', target: HUMAN, body: 'answered' })
    core.dismiss(closed.msgId)

    const res = await app(core).fetch(new Request('http://127.0.0.1/api/queue'))
    const body = (await res.json()) as QueueResponse

    expect(body.items.map(item => item.msgId)).toEqual([open.msgId])
  })
})

describe('GET /api/sessions', () => {
  it('lists the in-memory registry alongside broker uptime', async () => {
    const core = makeCore()
    core.registry.register(fakeConn(), { name: 'alpha', workingOn: 'CC-51', cwd: '/tmp', pid: 1 })

    const res = await app(core).fetch(new Request('http://127.0.0.1/api/sessions'))
    const body = (await res.json()) as SessionsResponse

    expect(body.sessions.map(s => s.name)).toEqual(['alpha'])
    expect(body.brokerUptimeMs).toBeGreaterThanOrEqual(0)
  })

  /**
   * The join that makes `/api/transcript` reachable from the roster. It rides on
   * `observed` rather than `declared` because the MCP subprocess reads it from
   * its own environment — a session must not be able to name someone else's
   * transcript by claiming their id.
   */
  it('surfaces the Claude Code session id under observed, so a transcript can be addressed', async () => {
    const core = makeCore()
    core.registry.register(fakeConn(), {
      name: 'alpha',
      workingOn: 'CC-51',
      cwd: '/tmp',
      pid: 1,
      sessionId: 'sess-abc',
    })

    const res = await app(core).fetch(new Request('http://127.0.0.1/api/sessions'))
    const body = (await res.json()) as SessionsResponse

    expect(body.sessions[0]?.observed?.claudeSessionId).toBe('sess-abc')
  })

  it('omits observed entirely when there is nothing observed to report', async () => {
    const core = makeCore()
    core.registry.register(fakeConn(), { name: 'alpha', workingOn: 'x', cwd: '/tmp', pid: 1 })

    const res = await app(core).fetch(new Request('http://127.0.0.1/api/sessions'))
    expect(((await res.json()) as SessionsResponse).sessions[0]?.observed).toBeUndefined()
  })

  /**
   * A restart empties the registry and clients take up to ~9s to reconnect, so
   * an empty list is not evidence that everyone died. `brokerUptimeMs` is what
   * lets a reader tell those two states apart, and it must be present even when
   * there is nothing to list.
   */
  it('still reports uptime when no session is attached', async () => {
    const res = await app(makeCore()).fetch(new Request('http://127.0.0.1/api/sessions'))
    const body = (await res.json()) as SessionsResponse
    expect(body.sessions).toEqual([])
    expect(typeof body.brokerUptimeMs).toBe('number')
  })
})

describe('GET /api/history', () => {
  it('defaults to a bounded page and honours ?limit=', async () => {
    const core = makeCore()
    for (let i = 0; i < 5; i += 1)
      core.append({ kind: 'notice', actor: 'alpha', target: HUMAN, body: `row ${i}` })

    const all = (await (
      await app(core).fetch(new Request('http://127.0.0.1/api/history'))
    ).json()) as HistoryResponse
    const two = (await (
      await app(core).fetch(new Request('http://127.0.0.1/api/history?limit=2'))
    ).json()) as HistoryResponse

    expect(all.items).toHaveLength(5)
    expect(two.items).toHaveLength(2)
    expect(two.items.at(-1)?.text).toBe('row 4')
  })

  it('ignores a nonsense limit instead of returning nothing', async () => {
    const core = makeCore()
    core.append({ kind: 'notice', actor: 'alpha', target: HUMAN, body: 'one' })

    const res = await app(core).fetch(new Request('http://127.0.0.1/api/history?limit=banana'))
    expect(((await res.json()) as HistoryResponse).items).toHaveLength(1)
  })
})

describe('GET /api/transcript', () => {
  const SESSION = 'test-session-001'
  const CWD = '/Users/test/project'

  /** Plant the sample transcript where `findTranscript` looks for it. */
  function plantTranscript(): void {
    const root = tmpDir('agent-chat-claude-')
    const dir = path.join(root, 'projects', projectSlug(CWD))
    fs.mkdirSync(dir, { recursive: true })
    const fixture = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'fixtures',
      'sample-transcript.jsonl',
    )
    fs.copyFileSync(fixture, path.join(dir, `${SESSION}.jsonl`))
    process.env.CLAUDE_CONFIG_DIR = root
  }

  afterEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR
  })

  it('folds the session transcript into analytics', async () => {
    plantTranscript()
    const res = await app(makeCore()).fetch(
      new Request(`http://127.0.0.1/api/transcript?sessionId=${SESSION}&cwd=${encodeURIComponent(CWD)}`),
    )
    const body = (await res.json()) as TranscriptResponse

    expect(res.status).toBe(200)
    expect(body.exists).toBe(true)
    expect(body.analytics?.sessionId).toBe(SESSION)
    expect(body.analytics?.userTurns).toBeGreaterThan(0)
  })

  /**
   * Three of `SessionAnalytics`'s fields are Maps and `JSON.stringify` turns a
   * Map into `{}` — a 200 with a well-formed body that has silently lost them.
   */
  it('serialises the Map-valued fields instead of emitting empty objects', async () => {
    plantTranscript()
    const res = await app(makeCore()).fetch(
      new Request(`http://127.0.0.1/api/transcript?sessionId=${SESSION}`),
    )
    const body = (await res.json()) as TranscriptResponse

    expect(body.analytics?.modelCounts).toEqual({
      'claude-opus-4-6': expect.any(Number) as unknown as number,
    })
    // filesTouched is a Map of Sets: both levels have to survive.
    for (const files of Object.values(body.analytics?.filesTouched ?? {}))
      expect(Array.isArray(files)).toBe(true)
  })

  it('finds the transcript by session id alone when no cwd is given', async () => {
    plantTranscript()
    const res = await app(makeCore()).fetch(
      new Request(`http://127.0.0.1/api/transcript?sessionId=${SESSION}`),
    )
    expect(((await res.json()) as TranscriptResponse).exists).toBe(true)
  })

  it('reports a missing transcript as a normal state, with the path it looked at', async () => {
    process.env.CLAUDE_CONFIG_DIR = tmpDir('agent-chat-claude-empty-')
    const res = await app(makeCore()).fetch(
      new Request('http://127.0.0.1/api/transcript?sessionId=nope&cwd=/tmp'),
    )
    const body = (await res.json()) as TranscriptResponse

    expect(res.status).toBe(404)
    expect(body).toMatchObject({ sessionId: 'nope', exists: false, analytics: null })
    expect(body.path).toContain('nope.jsonl')
  })

  it('rejects a request with no sessionId', async () => {
    const res = await app(makeCore()).fetch(new Request('http://127.0.0.1/api/transcript'))
    expect(res.status).toBe(400)
    expect(((await res.json()) as ErrorResponse).error).toContain('sessionId')
  })
})

describe('write routes', () => {
  const post = (core: BrokerCore, route: string, body: unknown) =>
    app(core).fetch(
      new Request(`http://127.0.0.1${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )

  it('answers an open item and closes it, so the queue no longer lists it', async () => {
    const core = makeCore()
    const item = core.append({ kind: 'question', actor: 'alpha', target: HUMAN, body: 'ship it?' })

    const res = await post(core, '/api/answer', { msgId: item.msgId, text: 'yes, ship it' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as VerdictResponse).ok).toBe(true)

    expect(core.events.humanQueue().map(i => i.msgId)).not.toContain(item.msgId)
    expect(core.events.history(10).some(e => e.kind === 'answer' && e.text === 'yes, ship it')).toBe(true)
  })

  it('dismisses an open item', async () => {
    const core = makeCore()
    const item = core.append({ kind: 'question', actor: 'alpha', target: HUMAN, body: 'still?' })

    const res = await post(core, '/api/dismiss', { msgId: item.msgId })
    expect(((await res.json()) as VerdictResponse).ok).toBe(true)
    expect(core.events.humanQueue()).toHaveLength(0)
  })

  /**
   * The concurrency contract from docs §5.1, asserted rather than described: the
   * second verdict loses, and it loses as a 200 with `ok:false`. A 4xx here would
   * push the dashboard into its error branch for the single most ordinary
   * outcome in the design — someone answered from a terminal a moment ago.
   */
  it('reports a second verdict as a 200 with ok:false, not as an error status', async () => {
    const core = makeCore()
    const item = core.append({ kind: 'question', actor: 'alpha', target: HUMAN, body: 'q' })
    core.answer(item.msgId, 'answered from the CLI')

    const res = await post(core, '/api/answer', { msgId: item.msgId, text: 'answered from the browser' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as VerdictResponse
    expect(body.ok).toBe(false)
    expect(body.reason).toContain('not an open item')
  })

  it.each([
    ['/api/answer', {}],
    ['/api/answer', { msgId: 'abc' }],
    ['/api/answer', { msgId: 'abc', text: '   ' }],
    ['/api/dismiss', {}],
  ])('400s on a malformed %s body (%o), which is a client bug rather than a race', async (route, body) => {
    const res = await post(makeCore(), route, body)
    expect(res.status).toBe(400)
  })

  /**
   * PERMANENT, not "not yet". Permission verdicts are out of scope for every
   * surface here: the relay is observe-only by construction and a dashboard
   * write path would be a backdoor around that. This assertion is the guard that
   * makes adding one a test failure rather than a review comment.
   */
  it('does not serve POST /api/approve, and never will', async () => {
    const res = await app(makeCore()).fetch(new Request('http://127.0.0.1/api/approve', { method: 'POST' }))
    expect(res.status).toBe(404)
  })

  it('requires the token on the write routes too, not only on the reads', async () => {
    const core = makeCore()
    const item = core.append({ kind: 'question', actor: 'alpha', target: HUMAN, body: 'q' })
    const res = await app(core, { token: 's3cret' }).fetch(
      new Request('http://127.0.0.1/api/dismiss', {
        method: 'POST',
        body: JSON.stringify({ msgId: item.msgId }),
      }),
    )

    expect(res.status).toBe(403)
    expect(core.events.humanQueue()).toHaveLength(1)
  })
})

describe('ANY /mcp', () => {
  it('404s with an explanation rather than blank, so a reader is told why', async () => {
    const res = await app(makeCore()).fetch(new Request('http://127.0.0.1/mcp', { method: 'POST' }))
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('stdio')
  })
})

describe('auth', () => {
  it('rejects an Origin that is not our own loopback port', async () => {
    const res = await app(makeCore()).fetch(
      new Request('http://127.0.0.1/api/queue', { headers: { Origin: 'http://evil.example' } }),
    )
    expect(res.status).toBe(403)
  })

  it('rejects loopback on a different port — a different origin is a different origin', async () => {
    const res = await app(makeCore()).fetch(
      new Request('http://127.0.0.1/api/queue', { headers: { Origin: 'http://127.0.0.1:3000' } }),
    )
    expect(res.status).toBe(403)
  })

  it('allows our own origin', async () => {
    const res = await app(makeCore()).fetch(
      new Request('http://127.0.0.1/api/queue', { headers: { Origin: `http://127.0.0.1:${PORT}` } }),
    )
    expect(res.status).toBe(200)
  })

  it('allows a request with no Origin at all, which is what curl and the CLI send', async () => {
    const res = await app(makeCore()).fetch(new Request('http://127.0.0.1/api/queue'))
    expect(res.status).toBe(200)
  })

  it('requires the token on /api/* once one is configured', async () => {
    const core = makeCore()
    const withToken = app(core, { token: 's3cret' })

    expect((await withToken.fetch(new Request('http://127.0.0.1/api/queue'))).status).toBe(403)
    expect(
      (
        await withToken.fetch(
          new Request('http://127.0.0.1/api/queue', { headers: { [TOKEN_HEADER]: 's3cret' } }),
        )
      ).status,
    ).toBe(200)
  })

  it('leaves /health reachable without the token, since that is what a probe asks first', async () => {
    const res = await app(makeCore(), { token: 's3cret' }).fetch(new Request('http://127.0.0.1/health'))
    expect(res.status).toBe(200)
  })
})

describe('GET /ui', () => {
  /**
   * Regression: `dashboardDir()` resolved to `<repo>/dashboard` while the build
   * emits `<repo>/dist/dashboard`, so a built bundle sat on disk while `/ui`
   * served the placeholder and `doctor` reported it missing.
   */
  it('probes the directory the build actually writes to', () => {
    expect(dashboardDir().endsWith(path.join('dist', 'dashboard'))).toBe(true)
  })

  it('serves a placeholder that names the build command when the bundle is absent', async () => {
    const empty = tmpDir('agent-chat-ui-')
    const res = await app(makeCore(), { dashboard: { dir: () => empty } }).fetch(
      new Request('http://127.0.0.1/ui'),
    )

    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('npm run build')
    expect(res.headers.get('Content-Type')).toContain('text/html')
  })

  it('serves the built index.html when it exists', async () => {
    const dir = tmpDir('agent-chat-ui-')
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>built</title>')

    const res = await app(makeCore(), { dashboard: { dir: () => dir } }).fetch(
      new Request('http://127.0.0.1/ui'),
    )
    expect(await res.text()).toContain('built')
  })

  it('falls back to index.html for a client-side route', async () => {
    const dir = tmpDir('agent-chat-ui-')
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>built</title>')

    const res = await app(makeCore(), { dashboard: { dir: () => dir } }).fetch(
      new Request('http://127.0.0.1/ui/sessions/alpha'),
    )
    expect(await res.text()).toContain('built')
  })

  it('serves a sibling asset with its own content type', async () => {
    const dir = tmpDir('agent-chat-ui-')
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html>')
    fs.writeFileSync(path.join(dir, 'app.css'), 'body{}')

    const res = await app(makeCore(), { dashboard: { dir: () => dir } }).fetch(
      new Request('http://127.0.0.1/ui/app.css'),
    )
    expect(res.headers.get('Content-Type')).toContain('text/css')
    expect(await res.text()).toBe('body{}')
  })

  /** This port is reachable by any local OS account; the read runs as us. */
  it('does not serve a path that escapes the dashboard directory', async () => {
    const dir = tmpDir('agent-chat-ui-')
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>built</title>')
    fs.writeFileSync(path.join(path.dirname(dir), 'secret.txt'), 'do not serve me')

    const res = await app(makeCore(), { dashboard: { dir: () => dir } }).fetch(
      new Request(`http://127.0.0.1/ui/..%2F${path.basename(path.dirname(dir))}/secret.txt`),
    )
    expect(await res.text()).not.toContain('do not serve me')
  })

  /**
   * The whole token scheme rests on this: the file is 0600, so the broker can
   * read it and another local account cannot, and the served document is the ONLY
   * channel by which the browser learns it — a fetch for the token would need the
   * token. If this injection stops happening, every /api/* call 403s.
   */
  it('injects the token into the served index.html, which is how the browser gets it', async () => {
    const dir = tmpDir('agent-chat-ui-')
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head></head><body></body></html>')

    const res = await app(makeCore(), { dashboard: { dir: () => dir, token: () => 's3cret' } }).fetch(
      new Request('http://127.0.0.1/ui'),
    )
    const html = await res.text()

    expect(html).toContain('window.__AGENT_CHAT_TOKEN__="s3cret"')
    // Before the bundle, not after it: the app reads the global during module
    // evaluation, so a script placed later would run too late to be seen.
    expect(html.indexOf('__AGENT_CHAT_TOKEN__')).toBeLessThan(html.indexOf('<body>'))
  })

  it('leaves the HTML untouched when there is no token, which is the vite-dev case', async () => {
    const dir = tmpDir('agent-chat-ui-')
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head></head></html>')

    const res = await app(makeCore(), { dashboard: { dir: () => dir } }).fetch(
      new Request('http://127.0.0.1/ui'),
    )
    expect(await res.text()).not.toContain('__AGENT_CHAT_TOKEN__')
  })
})

describe('GET /events', () => {
  it('answers with an SSE content type and no buffering', async () => {
    const res = await app(makeCore()).fetch(new Request('http://127.0.0.1/events'))
    expect(res.headers.get('Content-Type')).toContain('text/event-stream')
    expect(res.headers.get('Cache-Control')).toContain('no-cache')
    await res.body?.cancel()
  })

  it('replays from ?since for a client that is not an EventSource', async () => {
    const core = makeCore()
    const first = core.append({ kind: 'notice', actor: 'alpha', target: HUMAN, body: 'one' })
    core.append({ kind: 'notice', actor: 'alpha', target: HUMAN, body: 'two' })

    const res = await app(core).fetch(new Request(`http://127.0.0.1/events?since=${first.id}`))
    const reader = res.body!.getReader()
    const text = new TextDecoder().decode((await reader.read()).value)
    await reader.cancel()

    expect(text).toContain(`id: ${first.id + 1}`)
    expect(text).toContain('"body":"two"')
    expect(text).not.toContain('"body":"one"')
  })

  it('honours Last-Event-ID, which is what a reconnecting browser sends', async () => {
    const core = makeCore()
    const first = core.append({ kind: 'notice', actor: 'alpha', target: HUMAN, body: 'one' })
    core.append({ kind: 'notice', actor: 'alpha', target: HUMAN, body: 'two' })

    const res = await app(core).fetch(
      new Request('http://127.0.0.1/events', { headers: { 'Last-Event-ID': String(first.id) } }),
    )
    const reader = res.body!.getReader()
    const text = new TextDecoder().decode((await reader.read()).value)
    await reader.cancel()

    expect(text).toContain('"body":"two"')
    expect(text).not.toContain('"body":"one"')
  })

  /** The end-to-end version of the single write path: append once, stream once. */
  it('streams a row appended through core.append after the stream opened', async () => {
    const core = makeCore()
    const res = await app(core).fetch(new Request('http://127.0.0.1/events'))
    const reader = res.body!.getReader()

    const written = core.append({ kind: 'question', actor: 'beta', target: HUMAN, body: 'live one' })

    const text = new TextDecoder().decode((await reader.read()).value)
    await reader.cancel()

    expect(text).toContain(`id: ${written.id}`)
    expect(text).toContain('event: question')
    expect(text).toContain('"body":"live one"')
  })

  /**
   * CC-59. The tail carries the same queue, session and message activity as
   * `/api/*`, and a loopback TCP port is reachable by every local OS account, so
   * an unauthenticated read here defeats the token entirely.
   */
  it('rejects an unauthenticated tail once a token is configured', async () => {
    const res = await app(makeCore(), { token: 's3cret' }).fetch(new Request('http://127.0.0.1/events'))

    expect(res.status).toBe(403)
    expect(res.headers.get('Content-Type')).not.toContain('text/event-stream')
    expect(((await res.json()) as ErrorResponse).error).toContain('token')
  })

  it('rejects a tail presenting the wrong token', async () => {
    const res = await app(makeCore(), { token: 's3cret' }).fetch(
      new Request('http://127.0.0.1/events?token=guess'),
    )

    expect(res.status).toBe(403)
  })

  /** `EventSource` cannot set headers, so the query string is the only channel it has. */
  it('streams for a client that presents the token in the query, as EventSource must', async () => {
    const core = makeCore()
    const res = await app(core, { token: 's3cret' }).fetch(
      new Request('http://127.0.0.1/events?token=s3cret'),
    )
    expect(res.status).toBe(200)

    const reader = res.body!.getReader()
    const written = core.append({ kind: 'question', actor: 'beta', target: HUMAN, body: 'authed' })
    const text = new TextDecoder().decode((await reader.read()).value)
    await reader.cancel()

    expect(text).toContain(`id: ${written.id}`)
    expect(text).toContain('"body":"authed"')
  })

  /** Non-browser readers — curl, the CLI, tests — can still use the header. */
  it('streams for a client that presents the token in the header', async () => {
    const res = await app(makeCore(), { token: 's3cret' }).fetch(
      new Request('http://127.0.0.1/events', { headers: { [TOKEN_HEADER]: 's3cret' } }),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/event-stream')
    await res.body?.cancel()
  })
})
