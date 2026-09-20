import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SHIM = path.join(
  import.meta.dirname,
  '..',
  '..',
  'plugins',
  'agent-chat',
  'bin',
  'agent-chat-launch.sh',
)

/** Enough for bash and `env` to resolve, and nothing that holds a node. */
const PATH_WITHOUT_NODE = '/usr/bin:/bin'

let stateDir: string
let entry: string

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-shim-'))
  entry = path.join(stateDir, 'entry.js')
  fs.writeFileSync(entry, "process.stdout.write('ran:' + process.argv.slice(2).join(','))\n")
})

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true })
})

const runShim = (env: Record<string, string>) =>
  spawnSync('/bin/bash', [SHIM, 'mcp'], {
    encoding: 'utf8',
    env: { HOME: stateDir, AGENT_CHAT_HOME: stateDir, AGENT_CHAT_ENTRY: entry, ...env },
  })

describe('agent-chat-launch.sh when the session has no node on PATH', () => {
  it('starts the server from the node recorded in the state dir', () => {
    fs.writeFileSync(path.join(stateDir, 'node-path'), `${process.execPath}\n`)

    const result = runShim({ PATH: PATH_WITHOUT_NODE })

    expect(result.stderr).toBe('')
    expect(result.stdout).toBe('ran:mcp')
  })

  it('prefers AGENT_CHAT_NODE over a recorded path that does not exist', () => {
    fs.writeFileSync(path.join(stateDir, 'node-path'), '/nonexistent/node\n')

    const result = runShim({ PATH: PATH_WITHOUT_NODE, AGENT_CHAT_NODE: process.execPath })

    expect(result.stdout).toBe('ran:mcp')
  })

  it('still uses node from PATH when it is there', () => {
    const result = runShim({ PATH: `${path.dirname(process.execPath)}:${PATH_WITHOUT_NODE}` })

    expect(result.stdout).toBe('ran:mcp')
  })
})
