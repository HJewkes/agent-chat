#!/usr/bin/env node
// CC-1728: records the commit dist/ was built from in dist/build-commit, so a host launcher and the
// broker can compare builds. AGENT_CHAT_BUILD_COMMIT wins (restart-window builds a git archive with
// no .git); otherwise HEAD of the checkout. Neither available: no stamp, and the build still passes.
// Usage: node scripts/build-stamp.mjs (npm runs it at the package root)
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

function commit() {
  const given = process.env.AGENT_CHAT_BUILD_COMMIT?.trim()
  if (given) return given
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

const stamp = commit()
const file = path.join(process.cwd(), 'dist', 'build-commit')
if (/^[0-9a-f]{7,40}$/.test(stamp)) fs.writeFileSync(file, `${stamp}\n`)
else {
  fs.rmSync(file, { force: true })
  console.error('agent-chat build: no commit to stamp; host launchers will report this build as unstamped')
}
