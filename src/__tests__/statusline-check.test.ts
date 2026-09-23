import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkStatuslineCache, checkStatuslineHook } from '../broker/statusline-check.js'

const NOW = 1_790_000_000_000
const MINUTE = 60_000

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-statusline-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const reading = (name: string, ageMs: number): void => {
  const file = path.join(dir, name)
  fs.writeFileSync(file, '{}')
  const at = (NOW - ageMs) / 1000
  fs.utimesSync(file, at, at)
}

describe('checkStatuslineCache', () => {
  it('fails when sessions are registered and the newest reading is older than 30 minutes', () => {
    reading('a.json', 45 * MINUTE)
    reading('b.json', 31 * MINUTE)

    const check = checkStatuslineCache({ cacheDir: dir, now: NOW, registeredSessions: 3 })

    expect(check.status).toBe('fail')
    expect(check.detail).toContain('31m old')
  })

  it('passes when any one reading is fresh', () => {
    reading('a.json', 45 * MINUTE)
    reading('b.json', 2 * MINUTE)

    expect(checkStatuslineCache({ cacheDir: dir, now: NOW, registeredSessions: 3 }).status).toBe('ok')
  })

  it('ignores the writer temp files and prune stamp when judging freshness', () => {
    reading('a.json', 45 * MINUTE)
    reading('.pruned', 0)
    reading('.b.json', 0)

    expect(checkStatuslineCache({ cacheDir: dir, now: NOW, registeredSessions: 1 }).status).toBe('fail')
  })

  it('fails when the cache directory does not exist while sessions are registered', () => {
    const check = checkStatuslineCache({
      cacheDir: path.join(dir, 'absent'),
      now: NOW,
      registeredSessions: 2,
    })

    expect(check.status).toBe('fail')
  })

  it('expects nothing when no session is registered or no broker answered', () => {
    reading('a.json', 600 * MINUTE)

    expect(checkStatuslineCache({ cacheDir: dir, now: NOW, registeredSessions: 0 }).status).toBe('ok')
    expect(checkStatuslineCache({ cacheDir: dir, now: NOW, registeredSessions: undefined }).status).toBe('ok')
  })
})

describe('checkStatuslineHook', () => {
  const settings = (command: string | undefined): string => {
    const file = path.join(dir, 'settings.json')
    fs.writeFileSync(file, JSON.stringify(command === undefined ? {} : { statusLine: { command } }))
    return file
  }

  it('passes when the status-line script calls the writer', () => {
    const script = path.join(dir, 'statusline.sh')
    fs.writeFileSync(script, 'input=$(cat)\nprintf %s "$input" | ~/.claude/scripts/session-budget-write.sh\n')

    expect(checkStatuslineHook(settings(`zsh ${script}`)).status).toBe('ok')
  })

  it('warns when a chezmoi-style rewrite dropped the writer line from the script', () => {
    const script = path.join(dir, 'statusline.sh')
    fs.writeFileSync(script, 'input=$(cat)\necho "$input" | jq .model.id\n')

    const check = checkStatuslineHook(settings(`zsh ${script}`))

    expect(check.status).toBe('warn')
    expect(check.detail).toContain(script)
  })

  it('warns when no statusLine command is configured at all', () => {
    expect(checkStatuslineHook(settings(undefined)).status).toBe('warn')
  })
})
