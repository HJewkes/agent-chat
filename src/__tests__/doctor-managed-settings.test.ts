import { describe, expect, it } from 'vitest'
import { checkChannelAllowlist, managedSettingsPath } from '../broker/doctor.js'

const listed = JSON.stringify({
  allowedChannelPlugins: [{ marketplace: 'agent-chat-local', plugin: 'agent-chat' }],
})

/** A filesystem where only `file` exists, and records every path asked for. */
const fsWith = (file: string | undefined) => {
  const asked: string[] = []
  const read = (p: string): string => {
    asked.push(p)
    if (p === file) return listed
    throw new Error('ENOENT')
  }
  return { asked, read }
}

describe('channel allowlist managed-settings path', () => {
  it('reads the Application Support file on darwin', () => {
    const path = '/Library/Application Support/ClaudeCode/managed-settings.json'
    const { read } = fsWith(path)
    expect(managedSettingsPath('darwin')).toBe(path)
    expect(checkChannelAllowlist('darwin', read).status).toBe('ok')
  })

  it('reads /etc/claude-code on linux and never the macOS path', () => {
    const path = '/etc/claude-code/managed-settings.json'
    const { read, asked } = fsWith(path)
    expect(checkChannelAllowlist('linux', read)).toMatchObject({ status: 'ok', detail: `listed in ${path}` })
    expect(asked).not.toContain('/Library/Application Support/ClaudeCode/managed-settings.json')
  })

  it('skips instead of failing on win32', () => {
    const { read, asked } = fsWith(undefined)
    const check = checkChannelAllowlist('win32', read)
    expect(check.status).toBe('warn')
    expect(check.detail).toMatch(/^skipped/)
    expect(asked.every(p => p.endsWith('settings.json') && !p.includes('managed'))).toBe(true)
  })

  it('still fails on linux when nothing lists the plugin', () => {
    expect(checkChannelAllowlist('linux', fsWith(undefined).read).status).toBe('fail')
  })
})
