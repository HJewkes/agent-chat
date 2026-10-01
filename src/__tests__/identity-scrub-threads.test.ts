import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isMainThread } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'

/**
 * CC-429: the suite runs on worker threads, where process.env is a per-worker copy. This proves
 * setup-env.ts still keeps the developer's session identity out of every spawned child.
 *
 * The outer test starts a nested vitest on this file with a fake identity in its environment,
 * the way a developer's own Claude Code session would. In that run the probe below spawns
 * children and records what they saw. The outer test then checks the record, and checks that
 * global-setup.ts removed the run root once the nested vitest finished.
 */

const PROBE_OUT = 'IDENTITY_SCRUB_PROBE_OUT'
const REPO = path.resolve(import.meta.dirname, '../..')
const VITEST = path.join(REPO, 'node_modules/vitest/vitest.mjs')
const IDENTITY = {
  CLAUDE_CODE_SESSION_ID: 'developer-session-0000',
  AGENT_CHAT_HOME: '/developer/live/agent-chat-home',
  AGENT_CHAT_PORT: '1',
}
const IDENTITY_KEYS = Object.keys(IDENTITY)

interface ProbeRecord {
  isMainThread: boolean
  runRoot: string | undefined
  home: string | undefined
  inherited: Record<string, string | undefined>
  spread: Record<string, string | undefined>
}

const childEnv = (env?: NodeJS.ProcessEnv): Record<string, string | undefined> => {
  const script = `process.stdout.write(JSON.stringify(process.env))`
  const out = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env }).stdout
  return JSON.parse(out) as Record<string, string | undefined>
}

const probeOut = process.env[PROBE_OUT]

describe.runIf(probeOut)('identity probe, run only inside the nested vitest', () => {
  it('records what spawned children see', () => {
    const record: ProbeRecord = {
      isMainThread,
      runRoot: process.env.TEST_HOME_ROOT,
      home: process.env.AGENT_CHAT_HOME,
      inherited: childEnv(),
      spread: childEnv({ ...process.env }),
    }
    fs.writeFileSync(probeOut!, JSON.stringify(record))
  })
})

const nestedEnv = (out: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...IDENTITY, [PROBE_OUT]: out }
  for (const key of Object.keys(env)) if (key.startsWith('VITEST')) delete env[key]
  return env
}

describe.skipIf(probeOut)('the identity scrub on the threads pool', () => {
  it('keeps the developer session out of every child a worker thread spawns', () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'identity-scrub-')), 'probe.json')
    const args = [VITEST, 'run', '--project', 'threads', '--maxWorkers', '1', 'identity-scrub-threads']
    const run = spawnSync(process.execPath, args, { cwd: REPO, env: nestedEnv(out), encoding: 'utf8' })

    expect(run.status, run.stdout + run.stderr).toBe(0)
    const record = JSON.parse(fs.readFileSync(out, 'utf8')) as ProbeRecord
    expect(record.isMainThread).toBe(false)
    for (const seen of [record.inherited, record.spread]) {
      for (const key of IDENTITY_KEYS) expect(seen[key], key).not.toBe(IDENTITY[key as keyof typeof IDENTITY])
      expect(seen.AGENT_CHAT_HOME).toBe(record.home)
    }
    expect(record.home!.startsWith(record.runRoot! + path.sep)).toBe(true)
    expect(fs.existsSync(record.runRoot!)).toBe(false)
  }, 60000)
})
