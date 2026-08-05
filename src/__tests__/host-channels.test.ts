import { describe, expect, it } from 'vitest'
import { channelStatusFromArgv, hostChannelStatus, psArgvReader } from '../broker/host-channels.js'

/**
 * CC-73. The verdict these tests protect is the one `chat_send` reports, so a
 * false `yes` is worse than a false `no`: it restores exactly the silent
 * data-loss this module exists to expose. Several cases below are therefore
 * about refusing to be talked into `yes` by a prompt.
 */
describe('channelStatusFromArgv', () => {
  it('reports no for a host launched without the flag', () => {
    expect(channelStatusFromArgv(['claude'])).toBe('no')
  })

  it('reports yes for the plugin target the launchers pass', () => {
    expect(channelStatusFromArgv(['claude', '--channels', 'plugin:agent-chat@agent-chat-local'])).toBe('yes')
  })

  it('ignores which marketplace the plugin came from', () => {
    expect(channelStatusFromArgv(['claude', '--channels', 'plugin:agent-chat@some-other-market'])).toBe('yes')
  })

  it.each([['agent-chat'], ['server:agent-chat']])('accepts the %s spelling', target => {
    expect(channelStatusFromArgv(['claude', '--channels', target])).toBe('yes')
  })

  it('accepts the development flag, which grants the same push', () => {
    expect(
      channelStatusFromArgv(['claude', '--dangerously-load-development-channels', 'server:agent-chat']),
    ).toBe('yes')
  })

  it('finds the target among several on one variadic flag', () => {
    const argv = ['claude', '--channels', 'plugin:voltras@v-local', 'plugin:agent-chat@agent-chat-local']
    expect(channelStatusFromArgv(argv)).toBe('yes')
  })

  it('reports no when the flag names only other servers', () => {
    expect(channelStatusFromArgv(['claude', '--channels', 'plugin:voltras-channel@voltras-local'])).toBe('no')
  })

  it('does not treat a later flag value as a channel target', () => {
    // The variadic run ends at `--model`, so `agent-chat` here is a model name.
    const argv = ['claude', '--channels', 'plugin:voltras@v-local', '--model', 'agent-chat']
    expect(channelStatusFromArgv(argv)).toBe('no')
  })

  it('does not treat an operand after -- as a channel target', () => {
    expect(
      channelStatusFromArgv(['claude', '--channels', 'plugin:voltras@v-local', '--', 'agent-chat']),
    ).toBe('no')
  })

  it('refuses to let a prompt past -- forge a channel', () => {
    // A prompt is normally one token, but nothing stops a caller splitting it.
    expect(channelStatusFromArgv(['claude', '--', '--channels', 'plugin:agent-chat@agent-chat-local'])).toBe(
      'no',
    )
  })

  it('does not match a server whose name merely contains the target', () => {
    expect(channelStatusFromArgv(['claude', '--channels', 'plugin:agent-chat-extra@mk'])).toBe('no')
    expect(channelStatusFromArgv(['claude', '--channels', 'not-agent-chat'])).toBe('no')
  })
})

describe('hostChannelStatus', () => {
  const reader = (line: string | undefined) => () => line

  it.each([
    ['no pid at all', undefined],
    ['a reparented process, whose parent is already gone', 1],
    ['a non-integer', Number.NaN],
  ])('reports unknown rather than no for %s', (_case, pid) => {
    expect(hostChannelStatus(pid as number | undefined, 'agent-chat', reader('irrelevant'))).toBe('unknown')
  })

  it('reports unknown when the process cannot be read', () => {
    // Gone, or owned by another user. Not evidence that channels are absent.
    expect(hostChannelStatus(4242, 'agent-chat', reader(undefined))).toBe('unknown')
  })

  it('splits a space-joined ps line into tokens', () => {
    const line = 'claude --model opus --channels plugin:agent-chat@agent-chat-local -- do the thing'
    expect(hostChannelStatus(4242, 'agent-chat', reader(line))).toBe('yes')
  })

  it('reports no for a bare claude, the case CC-73 was filed for', () => {
    expect(hostChannelStatus(4242, 'agent-chat', reader('claude'))).toBe('no')
  })

  it('reads a real process without throwing', () => {
    // Against this test runner itself: proves the ps invocation and its flags
    // are right on this platform, which a stubbed reader can never show.
    expect(psArgvReader(process.pid)).toMatch(/node|vitest/i)
    expect(hostChannelStatus(process.pid)).toBe('no')
  })
})
