import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { TOKEN_HEADER, type ErrorResponse } from '../api-contract.js'
import { apiRoutes } from './api-routes.js'
import type { BrokerCore } from './core.js'
import { dashboardRoutes, type DashboardOptions } from './dashboard-routes.js'
import { buildHealthPayload } from './health.js'
import { openEventStream, readCursor, SSE_HEADERS } from './sse.js'

/**
 * The HTTP surface, as a PURE factory: it builds an app and binds nothing.
 *
 * That purity is the point rather than a nicety. `app.fetch(new Request(...))`
 * exercises every route with no port, no socket and no daemon, so the tests that
 * matter most here — the SSE resume cursor and its subscribe-then-query ordering
 * — run as ordinary in-process unit tests. `daemon.ts` is the only file that
 * knows a port exists.
 *
 * Reads only, by design. See `api-routes.ts` for why the write routes are absent
 * rather than unfinished.
 */

export interface HttpAppOptions {
  core: BrokerCore
  /**
   * A getter, not a number: the bind is best-effort and its result is not known
   * until after the app exists. Null means the port was refused and we are
   * serving the socket only, which `/health` reports honestly.
   */
  port: () => number | null
  /**
   * Shared secret for `/api/*`, or null to leave the API open.
   *
   * The unix socket is `chmod 0600`, so the trust boundary is the OS account. A
   * loopback TCP port is reachable by ANY local user, which is strictly weaker,
   * and the token restores parity. `startBroker` passes `ensureToken()`; null is
   * for tests and for a bare `bindHttp` that wants no auth.
   *
   * The browser gets its copy because `dashboard-routes.ts` injects it into the
   * served `index.html` — the server reads the 0600 file, an unauthorized local
   * user cannot.
   *
   * Note honestly: this closes the multi-user gap the TCP port opens. It does
   * not change the agent threat model at all — any session with Bash can already
   * run `agent-chat answer`.
   */
  token?: string | null
  dashboard?: DashboardOptions
}

export function buildHttpApp({ core, port, token = null, dashboard = {} }: HttpAppOptions): Hono {
  const app = new Hono()

  // A browser page from anywhere else may not read this API. Absent Origin is
  // allowed: curl, EventSource in some clients, and the CLI send none, and
  // refusing those would break every non-browser reader to no benefit.
  app.use('*', async (c, next) => {
    const origin = c.req.header('Origin')
    if (origin !== undefined && !isLoopbackOrigin(origin, port())) return forbidden(c, 'origin not allowed')
    await next()
  })

  app.use('/api/*', requireToken(token))

  // The live tail is a read of the same queue, session and message activity
  // `/api/*` guards, so leaving it open let any local OS user watch everything
  // the token was supposed to gate. Same secret, same middleware — see
  // `requireToken` for why this one also accepts the token in the query.
  app.use('/events', requireToken(token, { allowQuery: true }))

  app.get('/health', c => c.json(buildHealthPayload(core, port())))

  app.route('/api', apiRoutes(core))

  app.get('/events', c => {
    const cursor = readCursor(c.req.header('Last-Event-ID'), c.req.query('since'))
    return new Response(openEventStream({ store: core.events, hub: core.hub, cursor }), {
      headers: SSE_HEADERS,
    })
  })

  app.route('/ui', dashboardRoutes(dashboard))
  app.get('/', c => c.redirect('/ui'))

  /**
   * No MCP-over-HTTP route, deliberately, and this says so instead of 404ing
   * blank. active-work serves `/mcp` and the house pattern would suggest we do
   * too — but the channel notification that carries a directed message has no
   * addressing field, so "which subprocess emits it" IS the address. Collapse to
   * one shared HTTP MCP server and there is nothing left to address with.
   */
  app.all('/mcp', c =>
    c.text(
      'agent-chat does not serve MCP over HTTP, on purpose.\n\n' +
        'The MCP layer is stdio, one subprocess per Claude Code session, because a\n' +
        'directed message is addressed by WHICH subprocess emits the channel\n' +
        'notification — the notification itself carries no addressing field. One\n' +
        'shared HTTP MCP server would leave nothing to address with, and directed\n' +
        'messaging is the product.\n\n' +
        'Register the stdio server instead: `agent-chat mcp`.\n',
      404,
    ),
  )

  return app
}

/**
 * The one token check, shared by `/api/*` and `/events` so they cannot drift
 * apart again — they were separate exactly once, and that was the CC-59 hole.
 *
 * `allowQuery` exists for `/events` alone. The browser's native `EventSource`
 * has no API for request headers at all, so `dashboard/live.ts` can only put the
 * token in the query string; header-only would mean a permanently 403ing
 * dashboard. `/api/*` is reached by `fetch`, which can set the header, so it
 * stays header-only rather than inheriting a secret that leaks into access logs
 * and `Referer`.
 */
function requireToken(token: string | null, { allowQuery = false } = {}): MiddlewareHandler {
  return async (c, next) => {
    if (token !== null && presentedToken(c, allowQuery) !== token) return forbidden(c, 'missing or bad token')
    await next()
  }
}

const presentedToken = (c: Context, allowQuery: boolean): string | undefined =>
  c.req.header(TOKEN_HEADER) ?? (allowQuery ? c.req.query('token') : undefined)

/**
 * Loopback only, and the port must match the one we bound: `http://127.0.0.1:3000`
 * is a different origin from ours and has no business here. When the port is
 * unknown (bind refused) nothing can be talking to us over TCP anyway, so any
 * loopback host is accepted rather than guessed at.
 */
function isLoopbackOrigin(origin: string, port: number | null): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:') return false
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return false
  return port === null || url.port === String(port)
}

const forbidden = (c: { json: (body: ErrorResponse, status: 403) => Response }, reason: string): Response =>
  c.json({ error: reason }, 403)
