import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const CLI = path.resolve(import.meta.dirname, '../../dist/cli.js')
const EX_UNAVAILABLE = 69

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-down-'))
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

describe('top-level exit status', () => {
  it('exits 69 when `agent ls` finds no broker and may not start one', () => {
    const run = spawnSync(process.execPath, [CLI, 'agent', 'ls'], {
      env: { ...process.env, AGENT_CHAT_HOME: home, AGENT_CHAT_NO_AUTOSTART: '1' },
      encoding: 'utf8',
    })
    expect(run.stderr).toMatch(/^broker unavailable/)
    expect(run.status).toBe(EX_UNAVAILABLE)
  })
})
