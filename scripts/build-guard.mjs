#!/usr/bin/env node
// CC-571: `npm run build` refuses in the main checkout, whose dist/ the live broker and every
// spawn run. A linked worktree has a `.git` file and restart-window's staging copy has no `.git`,
// so only a `.git` directory refuses. This prevents accidents; it is not a security boundary.
// Usage: node scripts/build-guard.mjs (npm runs it at the package root)
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** The refusal for a build at `root`, or null when the build may run. */
export function buildRefusal({ root, env, gitIsDirectory }) {
  if (env.AGENT_CHAT_BUILD_IN_MAIN === '1') return null
  if (env.CI) return null
  if (!gitIsDirectory) return null
  return (
    `agent-chat build: refusing to build in the main checkout ${root}: its dist/ is what the live ` +
    'broker and every spawn run. Build in a worktree. Rebuilding this checkout belongs to the ' +
    "owner's broker-restart window (charter cross-seat protocol 5; runbook scripts/restart-window.sh). " +
    'Inside an approved window, rerun with AGENT_CHAT_BUILD_IN_MAIN=1.'
  )
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = process.cwd()
  const refusal = buildRefusal({
    root,
    env: process.env,
    gitIsDirectory: isDirectory(path.join(root, '.git')),
  })
  if (refusal) {
    console.error(refusal)
    process.exit(1)
  }
}
