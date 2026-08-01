import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// `__dirname` is unavailable under "type": "module", which this package is.
const here = path.dirname(fileURLToPath(import.meta.url))

/** The broker's default port (docs Part 3 §3). Dev-server proxying only. */
const BROKER_ORIGIN = process.env['AGENT_CHAT_ORIGIN'] ?? 'http://127.0.0.1:7600'

/**
 * Dashboard-only Vite config, kept beside the dashboard rather than at the repo
 * root — the layout docs/agent-teams.md Part 3 §4.1 specifies.
 *
 * The output is ONE self-contained `dist/dashboard/index.html`, which is what
 * lets the broker serve `/ui` as a static file with no asset routing at all.
 */
export default defineConfig({
  root: here,
  plugins: [react(), viteSingleFile()],
  resolve: {
    alias: { 'react-native': 'react-native-web' },
    extensions: ['.web.tsx', '.web.ts', '.tsx', '.ts', '.web.js', '.js'],
  },
  /**
   * `vite dev` only. In production the dashboard is served BY the broker, so
   * every request is same-origin and there is nothing to proxy; from the dev
   * server the page is on 5173 and the broker on 7600, and without this the
   * fetches are cross-origin and blocked. Proxying rather than enabling CORS on
   * the broker keeps the loopback surface as narrow as §6.5 wants it.
   *
   * EVERY KEY IS AN ANCHORED REGEX, and that is not style. A plain `'/api'` key
   * is a PREFIX match, so it also captures `/api.ts` — this directory's own
   * module — and forwards it to the broker, which answers 503. The page then
   * fails to load one module in the middle of its import graph and renders
   * nothing at all, with no console error to explain why. Found by looking at
   * a blank page; keep the anchors.
   */
  server: {
    proxy: {
      '^/api/': BROKER_ORIGIN,
      '^/health$': BROKER_ORIGIN,
      // SSE needs the connection held open rather than buffered.
      '^/events$': { target: BROKER_ORIGIN, changeOrigin: true, ws: false },
    },
  },
  build: {
    outDir: path.resolve(here, '..', '..', 'dist', 'dashboard'),
    emptyOutDir: true,
    target: 'es2020',
  },
})
