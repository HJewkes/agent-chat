import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { dashboardDir } from '../paths.js'

/**
 * Serving the built dashboard from the broker rather than from a second port.
 *
 * The build is `vite-plugin-singlefile`, so `dist/dashboard` is normally one
 * self-contained `index.html` with everything inlined. Sibling assets are still
 * handled, because a build that stops inlining should not 404 silently.
 *
 * `dist/` is gitignored and the dashboard build is a separate script, so the
 * unbuilt case is not an edge case — it is what a fresh checkout looks like.
 * That path returns a page that says so, and says how to fix it, rather than a
 * blank 404 that reads as "the dashboard is broken".
 */

export interface DashboardOptions {
  /** Injected so tests can point at a fixture directory instead of `dist/`. */
  dir?: () => string
  /**
   * The `/api/*` secret, handed to the page that needs it (docs §6.5).
   *
   * A getter for the same reason `port` is one in `http.ts`: the value belongs to
   * the daemon and is not known when the routes are built. Null leaves the HTML
   * untouched, which is what `vite dev` and the unbuilt-placeholder path want.
   */
  token?: () => string | null
}

export function dashboardRoutes(options: DashboardOptions = {}): Hono {
  const dir = options.dir ?? dashboardDir
  const token = options.token ?? (() => null)
  const ui = new Hono()

  ui.get('/*', c => {
    const root = dir()
    const requested = assetPath(root, c.req.path)
    if (requested !== null && fs.existsSync(requested) && fs.statSync(requested).isFile())
      return c.body(fs.readFileSync(requested), 200, { 'Content-Type': contentType(requested) })

    // SPA fallback: any path under /ui that is not a file is a client-side
    // route, and the app resolves it once it has booted.
    const index = path.join(root, 'index.html')
    if (fs.existsSync(index)) return c.html(withToken(fs.readFileSync(index, 'utf8'), token()))

    return c.html(placeholderPage(root), 200)
  })

  return ui
}

/**
 * Hand the page the token by rewriting the HTML on the way out.
 *
 * This is the mechanism the whole scheme rests on: the file is `0600`, so THIS
 * process can read it and another local OS account cannot, and serving it inside
 * the document is how the privilege crosses into the browser. There is no other
 * channel — a `fetch` for the token would need the token.
 *
 * Injected at the TOP of `<head>`, before the bundle: the app reads
 * `window.__AGENT_CHAT_TOKEN__` during module evaluation, so a script placed
 * after it would run too late and every request would 403.
 *
 * The value is JSON-encoded and its `<` escaped, because a token containing
 * `</script>` would otherwise end the tag early. Ours is hex and cannot, but the
 * escape belongs next to the injection rather than in the generator's docstring.
 */
function withToken(html: string, token: string | null): string {
  if (token === null) return html
  const literal = JSON.stringify(token).replace(/</g, '\\u003c')
  const tag = `<script>window.__AGENT_CHAT_TOKEN__=${literal}</script>`
  return html.includes('<head>') ? html.replace('<head>', `<head>${tag}`) : `${tag}${html}`
}

/**
 * The path under `root` a request maps to, or null if it escapes.
 *
 * The traversal guard is not theatre: the server reads files as the user who
 * owns `~/.agent-chat`, and this port is reachable by any local account.
 */
function assetPath(root: string, urlPath: string): string | null {
  const relative = urlPath.replace(/^\/ui\/?/, '')
  if (relative === '') return null
  const resolved = path.resolve(root, relative)
  const bounded = path.resolve(root) + path.sep
  return resolved.startsWith(bounded) ? resolved : null
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
}

const contentType = (file: string): string =>
  CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'

/**
 * Deliberately dependency-free and inline: the whole point of this page is to
 * work when nothing has been built.
 */
function placeholderPage(root: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>agent-chat — dashboard not built</title>
    <style>
      :root { color-scheme: light dark; }
      body { font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; margin: 0;
             display: grid; place-items: center; min-height: 100vh; }
      main { max-width: 34rem; padding: 2rem; }
      h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
      code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: .9em; }
      pre { padding: .75rem 1rem; border-radius: 6px; overflow-x: auto;
            background: rgba(127,127,127,.14); }
      ul { padding-left: 1.2rem; }
      p.note { opacity: .7; font-size: .9em; }
    </style>
  </head>
  <body>
    <main>
      <h1>The dashboard has not been built yet</h1>
      <p>The broker is running and its API is live — only the UI bundle is missing.</p>
      <pre>npm run build</pre>
      <p>Expected at <code>${escapeHtml(path.join(root, 'index.html'))}</code>.</p>
      <p>The API is serving now:</p>
      <ul>
        <li><code><a href="/health">/health</a></code></li>
        <li><code><a href="/api/queue">/api/queue</a></code></li>
        <li><code><a href="/api/sessions">/api/sessions</a></code></li>
        <li><code><a href="/api/history">/api/history</a></code></li>
        <li><code>/events</code> — SSE tail of the event log</li>
      </ul>
      <p class="note">Messaging never depends on this page. The unix socket is the
      service; the HTTP port is an accessory.</p>
    </main>
  </body>
</html>
`
}

const escapeHtml = (raw: string): string =>
  raw.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch)
