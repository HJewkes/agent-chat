import { describe, expect, it } from 'vitest'
import { chooseSurface, platformDefaultSurface, surfaceBlockerFor } from '../agents/surface-resolution.js'
import { seatSurfaceFor } from '../agents/seats/charter.js'

const seatFile = (front: string): string => `---\nprefix: TC\npool: personal\n${front}\n---\n# seat\n`

const legacyMacSeat = seatFile('surface: iterm-window')
const perMachineSeat = seatFile(
  ['surface: iterm-window', 'surfaces:', '  basement: tmux-window', '  mac: iterm-tab'].join('\n'),
)

describe('surfaceBlockerFor', () => {
  it('blocks every iTerm surface off macOS and names the host OS', () => {
    for (const surface of ['iterm-pane', 'iterm-tab', 'iterm-window'] as const) {
      expect(surfaceBlockerFor(surface, 'linux')).toMatch(/macOS.*linux/)
    }
  })

  it('lets macOS run iTerm surfaces', () => {
    expect(surfaceBlockerFor('iterm-pane', 'darwin')).toBeUndefined()
  })

  it('lets linux run a tmux window', () => {
    expect(surfaceBlockerFor('tmux-window', 'linux')).toBeUndefined()
  })

  it('never blocks headless', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      expect(surfaceBlockerFor('headless', platform)).toBeUndefined()
    }
  })
})

describe('platformDefaultSurface', () => {
  it('puts linux in tmux, macOS in an iTerm tab, and anything else headless', () => {
    expect(platformDefaultSurface('linux')).toBe('tmux-window')
    expect(platformDefaultSurface('darwin')).toBe('iterm-tab')
    expect(platformDefaultSurface('win32')).toBe('headless')
  })
})

describe('chooseSurface', () => {
  it('on linux, a seat declaring only iterm-window gets the tmux default', () => {
    const choice = chooseSurface({
      seatSurface: seatSurfaceFor(legacyMacSeat, 'basement'),
      platform: 'linux',
    })

    expect(choice).toEqual({ ok: true, surface: 'tmux-window', from: 'platform' })
  })

  it('on macOS, the same seat keeps its iterm-window', () => {
    const choice = chooseSurface({ seatSurface: seatSurfaceFor(legacyMacSeat, 'mac'), platform: 'darwin' })

    expect(choice).toEqual({ ok: true, surface: 'iterm-window', from: 'seat' })
  })

  it('refuses an explicit request the host cannot run instead of falling back', () => {
    const choice = chooseSurface({ requested: 'iterm-window', seatSurface: 'tmux-window', platform: 'linux' })

    expect(choice.ok).toBe(false)
    expect(choice.ok ? '' : choice.reason).toMatch(/macOS/)
  })

  it('honours a runnable explicit request over the seat entry', () => {
    const choice = chooseSurface({ requested: 'headless', seatSurface: 'tmux-window', platform: 'linux' })

    expect(choice).toEqual({ ok: true, surface: 'headless', from: 'requested' })
  })

  it('keeps a recorded headless session headless when the seat names nothing runnable', () => {
    const choice = chooseSurface({ seatSurface: 'iterm-window', recorded: 'headless', platform: 'linux' })

    expect(choice).toEqual({ ok: true, surface: 'headless', from: 'recorded' })
  })

  it('prefers the seat entry over the recorded surface', () => {
    const choice = chooseSurface({ seatSurface: 'iterm-tab', recorded: 'iterm-pane', platform: 'darwin' })

    expect(choice).toEqual({ ok: true, surface: 'iterm-tab', from: 'seat' })
  })
})

describe('seatSurfaceFor', () => {
  it('picks the surfaces: entry for each machine', () => {
    expect(seatSurfaceFor(perMachineSeat, 'basement')).toBe('tmux-window')
    expect(seatSurfaceFor(perMachineSeat, 'mac')).toBe('iterm-tab')
  })

  it('matches the machine name case-insensitively', () => {
    expect(seatSurfaceFor(perMachineSeat, 'Basement')).toBe('tmux-window')
  })

  it('falls back to the legacy surface: for a machine the block does not name', () => {
    expect(seatSurfaceFor(perMachineSeat, 'laptop')).toBe('iterm-window')
  })

  it('ignores an entry that is not a surface name', () => {
    const seat = seatFile(['surfaces:', '  basement: bogus'].join('\n'))

    expect(seatSurfaceFor(seat, 'basement')).toBeUndefined()
  })

  it('reads quoted entries and hostnames with dots', () => {
    const seat = seatFile(['surfaces:', "  hosts-mbp.local: 'headless'"].join('\n'))

    expect(seatSurfaceFor(seat, 'hosts-mbp.local')).toBe('headless')
  })

  it('reads nothing from an absent seat file', () => {
    expect(seatSurfaceFor(undefined, 'basement')).toBeUndefined()
  })

  it('on linux, a per-machine entry wins over the platform default', () => {
    const choice = chooseSurface({
      seatSurface: seatSurfaceFor(seatFile('surfaces:\n  basement: headless'), 'basement'),
      platform: 'linux',
    })

    expect(choice).toEqual({ ok: true, surface: 'headless', from: 'seat' })
  })
})
