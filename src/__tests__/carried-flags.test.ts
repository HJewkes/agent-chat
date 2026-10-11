import { describe, expect, it } from 'vitest'
import { carriedFlagsFromArgv, hostCarriedFlags, sanitizeCarried } from '../broker/host-channels.js'

/** CC-951: the launch flags a teleport successor inherits, read from its predecessor's argv. */

const TITAN_COORD =
  'claude --model claude-opus-5-5 --remote-control --channels plugin:agent-chat@agent-chat-local ' +
  '--name titan-coord boot'

const words = (line: string): string[] => line.split(/\s+/)

describe("a predecessor's carried flags", () => {
  it("leaves agent-chat's own channel to the launch, which always adds it", () => {
    expect(carriedFlagsFromArgv(words(TITAN_COORD))).toEqual({ channels: [] })
  })

  it('carries every other channel target, the permission mode and the effort', () => {
    const argv = words(
      'claude --channels plugin:agent-chat@agent-chat-local plugin:voltras-channel@x server:relay ' +
        '--permission-mode auto --effort=high',
    )

    expect(carriedFlagsFromArgv(argv)).toEqual({
      channels: ['plugin:voltras-channel@x', 'server:relay'],
      permissionMode: 'auto',
      effort: 'high',
    })
  })

  it('carries nothing a prompt names after --', () => {
    const argv = words('claude -- --channels plugin:evil@x --permission-mode auto --effort max')

    expect(carriedFlagsFromArgv(argv)).toEqual({ channels: [] })
  })

  it('never carries a bypass, an unknown effort or a target that is not a channel', () => {
    const argv = words('claude --permission-mode bypassPermissions --effort huge --channels evil')

    expect(carriedFlagsFromArgv(argv)).toEqual({ channels: [] })
  })

  it('is undefined when the argv cannot be read, so the caller falls back rather than carrying nothing', () => {
    expect(hostCarriedFlags(4242, () => undefined)).toBeUndefined()
    expect(hostCarriedFlags(4242, () => TITAN_COORD)).toEqual({ channels: [] })
  })
})

describe("a caller's reported flags", () => {
  it('keeps only values that pass the same checks as a local read', () => {
    const raw = {
      channels: ['plugin:voltras-channel@x', '-x', 7, 'plugin:agent-chat@agent-chat-local'],
      permissionMode: 'bypassPermissions',
      effort: 'max',
    }

    expect(sanitizeCarried(raw)).toEqual({ channels: ['plugin:voltras-channel@x'], effort: 'max' })
    expect(sanitizeCarried('nope')).toBeUndefined()
  })
})
