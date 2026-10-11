import { describe, expect, it } from 'vitest'
import { resumeSurface } from '../cli/verbs/seats.js'

const seat = (frontmatter: string): string => `---\nprefix: TC\npool: personal\n${frontmatter}---\n\n# seat\n`

describe('watchdog resume surface (CC-951)', () => {
  // Catches: reading the legacy surface: without the blocker, which sent a linux resume to iTerm,
  // a surface_refused, and a headless fallback.
  it('resumes a seat declared on iterm-window in a tmux window on a linux broker', () => {
    const file = seat('surface: iterm-window\n')

    const chosen = resumeSurface(file, undefined, 'basement', 'linux')

    expect(chosen).toEqual({
      surface: 'tmux-window',
      from: 'linux default; seat file iterm-window cannot run here',
    })
  })

  it('keeps the same seat on iterm-window on a mac broker', () => {
    const file = seat('surface: iterm-window\n')

    expect(resumeSurface(file, undefined, 'mac', 'darwin')).toEqual({
      surface: 'iterm-window',
      from: 'seat file',
    })
  })

  it("takes the broker host's surfaces: entry over the legacy surface:", () => {
    const file = seat('surface: iterm-window\nsurfaces:\n  basement: headless\n  mac: iterm-tab\n')

    expect(resumeSurface(file, undefined, 'basement', 'linux')).toEqual({
      surface: 'headless',
      from: 'seat file',
    })
    expect(resumeSurface(file, undefined, 'mac', 'darwin')).toEqual({
      surface: 'iterm-tab',
      from: 'seat file',
    })
  })

  // Catches: a recorded headless fallback outranking the seat file and pinning the seat headless.
  it('ignores the agent record when the seat file declares a surface', () => {
    const file = seat('surface: iterm-window\n')

    expect(resumeSurface(file, 'headless', 'basement', 'linux').surface).toBe('tmux-window')
  })

  it('maps a recorded iTerm surface to the platform default when the seat file declares none', () => {
    expect(resumeSurface(seat(''), 'iterm-tab', 'basement', 'linux')).toEqual({
      surface: 'tmux-window',
      from: 'linux default; agent record iterm-tab cannot run here',
    })
    expect(resumeSurface(undefined, 'tmux-window', 'basement', 'linux')).toEqual({
      surface: 'tmux-window',
      from: 'agent record',
    })
  })

  it('stays headless when neither the seat file nor the agent record names a surface', () => {
    expect(resumeSurface(seat(''), undefined, 'basement', 'linux')).toEqual({
      surface: 'headless',
      from: 'none declared',
    })
  })
})
