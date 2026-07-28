import { describe, expect, it } from 'vitest'
import { SURFACE_NAMES, isInteractiveSurface, type SurfaceName } from '../protocol.js'
import { SurfaceRefused, surfaceFor, type SpawnFn, type SurfaceOptions } from '../agents/surfaces/index.js'
import type { LaunchPlan } from '../agents/types.js'

const ANCHOR = 'w1t0p0:D5C6B476-BD80-4CED-BA27-A660BC1E01F3'
const UUID = 'D5C6B476-BD80-4CED-BA27-A660BC1E01F3'
const NO_ANCHOR = '@@no-anchor@@'

const plan = (over: Partial<LaunchPlan> = {}): LaunchPlan => ({
  agentId: 'ag000001',
  bin: 'claude',
  args: ['--model', 'sonnet'],
  cwd: '/tmp/work',
  env: { AGENT_CHAT_NAME: 'scout' },
  title: 'scout — audit the parser',
  surface: 'headless',
  ...over,
})

/** An iTerm2 that is up, finds the anchor, and hands back a session UUID. */
function fakeIterm(found = true) {
  const scripts: string[] = []
  const notices: string[] = []
  const run = (script: string): string => {
    scripts.push(script)
    if (script.includes('is running')) return 'true'
    if (!found && script.includes(NO_ANCHOR)) return NO_ANCHOR
    return 'NEW-SESSION-UUID'
  }
  const options: SurfaceOptions = {
    platform: 'darwin',
    runAppleScript: run,
    onNotice: message => void notices.push(message),
  }
  return { scripts, notices, options }
}

const lastScript = (scripts: string[]): string => scripts[scripts.length - 1] ?? ''

describe('surface registry', () => {
  it('resolves every declared surface name and reports interactivity', () => {
    for (const name of SURFACE_NAMES) {
      const surface = surfaceFor(name, { platform: 'darwin' })
      expect(surface.name).toBe(name)
      expect(surface.interactive).toBe(isInteractiveSurface(name))
    }
  })
})

describe('headless surface', () => {
  const capturingSpawn = () => {
    const calls: { bin: string; args: string[]; options: Record<string, unknown> }[] = []
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const spawn: SpawnFn = (bin, args, options) => {
      calls.push({ bin, args, options: options as Record<string, unknown> })
      return {
        pid: 4242,
        unref: () => undefined,
        once: (event: string, listener: (...a: never[]) => void) => {
          listeners.set(event, listener as (...a: unknown[]) => void)
          return undefined
        },
      }
    }
    /** Fire the child's exit, so the supervisor's headless path can be exercised. */
    const exit = (code: number | null, signal: string | null = null) => listeners.get('exit')?.(code, signal)
    return { calls, spawn, exit }
  }

  it('starts the agent detached, with pipes, and reports its pid', async () => {
    const { calls, spawn } = capturingSpawn()
    const handle = await surfaceFor('headless', { spawn }).launch(plan())

    expect(handle).toMatchObject({ surface: 'headless', pid: 4242 })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.options).toMatchObject({ detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  })

  it('launches the fixed run-agent command, never the brief or the agent argv', async () => {
    const { calls, spawn } = capturingSpawn()
    await surfaceFor('headless', { spawn }).launch(plan({ stdin: 'go and audit the parser' }))

    const args = calls[0]?.args ?? []
    expect(args.slice(-2)).toEqual(['run-agent', 'ag000001'])
    expect(args.join(' ')).not.toContain('audit the parser')
    expect(args).not.toContain('--model')
  })

  it('exposes the child exit the supervisor infers headless death from', async () => {
    const { spawn, exit } = capturingSpawn()
    const handle = await surfaceFor('headless', { spawn }).launch(plan())

    exit(3, null)
    await expect(handle.exited).resolves.toEqual({ code: 3, signal: null })
  })

  it('omits pid rather than reporting undefined when the child never started', async () => {
    const spawn: SpawnFn = () => ({ unref: () => undefined, once: () => undefined })
    const handle = await surfaceFor('headless', { spawn }).launch(plan())
    expect(handle.pid).toBeUndefined()
    expect(handle.surface).toBe('headless')
  })
})

describe('iterm surfaces', () => {
  it('splits the anchor session, addressed by the uuid from ITERM_SESSION_ID', async () => {
    const { scripts, options } = fakeIterm()
    const handle = await surfaceFor('iterm-pane', { ...options, anchor: ANCHOR }).launch(plan())

    expect(handle).toEqual({ surface: 'iterm-pane', paneRef: 'NEW-SESSION-UUID' })
    const script = lastScript(scripts)
    expect(script).toContain(`is "${UUID}"`)
    expect(script).toContain('split vertically with default profile')
    // The lesson from iterm-panes.sh: focus must never decide where a pane lands.
    expect(script).not.toContain('current window')
  })

  /**
   * The layout this replaces: every agent split the ANCHOR, so the coordinator's
   * pane halved on each spawn. Measured live at three agents — anchor and both
   * agents sat at cols=62, a row of equal columns with nothing predominant.
   */
  it('stacks a later agent under the column instead of splitting the anchor again', async () => {
    const { scripts, options } = fakeIterm()

    await surfaceFor('iterm-pane', {
      ...options,
      anchor: ANCHOR,
      columnAfter: 'FIRST-AGENT-PANE',
    }).launch(plan())

    const script = lastScript(scripts)
    expect(script).toContain('is "FIRST-AGENT-PANE"')
    expect(script).toContain('split horizontally with default profile')
    // Still resolved by uuid, never by focus — the column must not change that.
    expect(script).not.toContain('current window')
  })

  it('starts a fresh column when the previous agent pane has been closed', async () => {
    // The script keeps BOTH branches and picks at runtime, so a column session
    // that no longer exists falls back to splitting the anchor rather than failing.
    const { scripts, options } = fakeIterm()

    await surfaceFor('iterm-pane', { ...options, anchor: ANCHOR, columnAfter: 'GONE' }).launch(plan())

    const script = lastScript(scripts)
    expect(script).toContain('if columnSession is not missing value then')
    expect(script).toContain('split vertically with default profile')
  })

  it('ignores a column for a tab, which is not a split at all', async () => {
    const { scripts, options } = fakeIterm()

    await surfaceFor('iterm-tab', { ...options, anchor: ANCHOR, columnAfter: 'FIRST-AGENT-PANE' }).launch(
      plan(),
    )

    expect(lastScript(scripts)).toContain('create tab with default profile')
    expect(lastScript(scripts)).not.toContain('split horizontally')
  })

  it('opens a tab in the anchor window rather than splitting it', async () => {
    const { scripts, options } = fakeIterm()
    const handle = await surfaceFor('iterm-tab', { ...options, anchor: ANCHOR }).launch(plan())

    expect(handle.surface).toBe('iterm-tab')
    expect(lastScript(scripts)).toContain('create tab with default profile')
    expect(lastScript(scripts)).not.toContain('split vertically')
  })

  it('never titles the pane itself, since iTerm overwrites set name', async () => {
    const { scripts, options } = fakeIterm()
    await surfaceFor('iterm-pane', { ...options, anchor: ANCHOR }).launch(plan())

    expect(lastScript(scripts)).not.toContain('set name')
    expect(lastScript(scripts)).not.toContain('audit the parser')
  })

  it('carries only the fixed run-agent command into AppleScript', async () => {
    const { scripts, options } = fakeIterm()
    await surfaceFor('iterm-pane', { ...options, anchor: ANCHOR }).launch(
      plan({ title: 'scout — "quoted" \\ title' }),
    )

    const script = lastScript(scripts)
    expect(script).toContain('run-agent')
    expect(script).toContain('ag000001')
    expect(script).not.toContain('quoted')
  })

  it('falls back to a window when there is no anchor, without a notice', async () => {
    const { scripts, notices, options } = fakeIterm()
    const handle = await surfaceFor('iterm-pane', options).launch(plan())

    expect(handle).toEqual({ surface: 'iterm-window', paneRef: 'NEW-SESSION-UUID' })
    expect(lastScript(scripts)).toContain('create window with default profile')
    expect(notices).toEqual([])
  })

  it('falls back to a window with a notice when the anchor pane has closed', async () => {
    const { scripts, notices, options } = fakeIterm(false)
    const handle = await surfaceFor('iterm-pane', { ...options, anchor: ANCHOR }).launch(plan())

    expect(handle).toEqual({ surface: 'iterm-window', paneRef: 'NEW-SESSION-UUID' })
    expect(lastScript(scripts)).toContain('create window with default profile')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain(UUID)
  })

  it('ignores an anchor for iterm-window, which needs none', async () => {
    const { scripts, notices, options } = fakeIterm(false)
    const handle = await surfaceFor('iterm-window', { ...options, anchor: ANCHOR }).launch(plan())

    expect(handle.surface).toBe('iterm-window')
    expect(notices).toEqual([])
    expect(scripts.some(script => script.includes(UUID))).toBe(false)
  })

  it('refuses off macOS, naming headless as the alternative', async () => {
    const { options } = fakeIterm()
    const surface = surfaceFor('iterm-pane', { ...options, platform: 'linux', anchor: ANCHOR })

    await expect(surface.launch(plan())).rejects.toThrow(SurfaceRefused)
    await expect(surface.launch(plan())).rejects.toThrow(/headless/)
  })

  it('refuses when iTerm2 is not running, rather than launching it', async () => {
    const scripts: string[] = []
    const runAppleScript = (script: string): string => {
      scripts.push(script)
      return 'false'
    }
    const surface = surfaceFor('iterm-pane', { platform: 'darwin', runAppleScript, anchor: ANCHOR })

    await expect(surface.launch(plan())).rejects.toThrow(/not running[\s\S]*headless/)
    expect(scripts).toHaveLength(1)
  })

  it('refuses when the running check itself fails', async () => {
    const runAppleScript = (): string => {
      throw new Error('osascript: command not found')
    }
    const surface = surfaceFor('iterm-window', { platform: 'darwin', runAppleScript })

    await expect(surface.launch(plan())).rejects.toThrow(SurfaceRefused)
  })
})

describe('anchor parsing', () => {
  const anchors: [string, boolean][] = [
    [ANCHOR, true],
    [UUID, true],
    ['', false],
    ['w1t0p0:', false],
  ]

  it.each(anchors)('treats %j as an anchor: %s', async (anchor, usable) => {
    const { scripts, options } = fakeIterm()
    const name: SurfaceName = 'iterm-pane'
    const handle = await surfaceFor(name, { ...options, anchor }).launch(plan())

    expect(handle.surface).toBe(usable ? name : 'iterm-window')
    expect(lastScript(scripts).includes(UUID)).toBe(usable)
  })
})
