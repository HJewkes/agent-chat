import { spawn as nodeSpawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { HEADLESS_STDIO } from '../agents/surfaces/headless.js'
import { SURFACE_NAMES, isInteractiveSurface, type SurfaceName } from '../protocol.js'
import { SurfaceRefused, surfaceFor, type SpawnFn, type SurfaceOptions } from '../agents/surfaces/index.js'
import type { LaunchPlan } from '../agents/types.js'

const ANCHOR = 'w1t0p0:D5C6B476-BD80-4CED-BA27-A660BC1E01F3'
const UUID = 'D5C6B476-BD80-4CED-BA27-A660BC1E01F3'
const NO_ANCHOR = '@@no-anchor@@'
const CLOSED = '@@closed@@'
const PRESENT = '@@present@@'
const GONE = '@@gone@@'

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

/**
 * An iTerm2 that is up, finds the anchor, and hands back a session UUID.
 *
 * `stillThere` is the CC-95 half: a close now goes back and re-reads the session
 * list, so a fake that only answers the close script would describe an iTerm2
 * that never lets go of anything. Default is a session that obeys.
 */
function fakeIterm(found = true, stillThere = false) {
  const scripts: string[] = []
  const notices: string[] = []
  const run = async (script: string): Promise<string> => {
    scripts.push(script)
    if (script.includes('is running')) return 'true'
    if (script.includes(PRESENT)) return stillThere ? PRESENT : GONE
    if (!found && script.includes(NO_ANCHOR)) return NO_ANCHOR
    if (script.includes('to close')) return CLOSED
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

/** The lines that open a surface. Focus is read elsewhere in the script, to be put back, never to place. */
const placement = (script: string): string =>
  script
    .split('\n')
    .filter(line => line.includes('set spawned to'))
    .join('\n')

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

  it('starts the agent detached, discarding its streams, and reports its pid', async () => {
    const { calls, spawn } = capturingSpawn()
    const handle = await surfaceFor('headless', { spawn }).launch(plan())

    expect(handle).toMatchObject({ surface: 'headless', pid: 4242 })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.options).toMatchObject({ detached: true, stdio: ['ignore', 'ignore', 'ignore'] })
  })

  /**
   * The regression that matters, and the only one a fake spawn cannot show.
   *
   * These streams were piped with nothing reading them, so a child that produced
   * more than the ~64KB kernel pipe buffer blocked on write and hung forever while
   * still looking alive. A megabyte is comfortably past that. Under the old
   * ['pipe','pipe','pipe'] this test does not fail an assertion — it times out,
   * which is exactly what the bug did to an agent.
   */
  it('lets a child that floods both streams run to completion', async () => {
    const loud = `
      process.stdout.write('o'.repeat(1024 * 1024))
      process.stderr.write('e'.repeat(1024 * 1024))
    `
    const child = nodeSpawn(process.execPath, ['-e', loud], {
      detached: true,
      stdio: [...HEADLESS_STDIO],
    })
    child.unref()

    const exit = await new Promise<number | null>(resolve => {
      child.once('exit', code => resolve(code))
      child.once('error', () => resolve(null))
    })
    expect(exit).toBe(0)
  }, 15_000)

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

    expect(handle).toMatchObject({ surface: 'iterm-pane', paneRef: 'NEW-SESSION-UUID', ownsSurface: true })
    const script = lastScript(scripts)
    expect(script).toContain(`is "${UUID}"`)
    expect(script).toContain('split vertically with default profile')
    // The lesson from iterm-panes.sh: focus must never decide where a pane lands.
    expect(placement(script)).not.toContain('current window')
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
    expect(placement(script)).not.toContain('current window')
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

    expect(handle).toMatchObject({ surface: 'iterm-window', paneRef: 'NEW-SESSION-UUID', ownsSurface: true })
    expect(lastScript(scripts)).toContain('create window with default profile')
    expect(notices).toEqual([])
  })

  it('falls back to a window with a notice when the anchor pane has closed', async () => {
    const { scripts, notices, options } = fakeIterm(false)
    const handle = await surfaceFor('iterm-pane', { ...options, anchor: ANCHOR }).launch(plan())

    expect(handle).toMatchObject({ surface: 'iterm-window', paneRef: 'NEW-SESSION-UUID', ownsSurface: true })
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
    const runAppleScript = async (script: string): Promise<string> => {
      scripts.push(script)
      return 'false'
    }
    const surface = surfaceFor('iterm-pane', { platform: 'darwin', runAppleScript, anchor: ANCHOR })

    await expect(surface.launch(plan())).rejects.toThrow(/not running[\s\S]*headless/)
    expect(scripts).toHaveLength(1)
  })

  it('refuses when the running check itself fails', async () => {
    const runAppleScript = (): Promise<string> => Promise.reject(new Error('osascript: command not found'))
    const surface = surfaceFor('iterm-window', { platform: 'darwin', runAppleScript })

    await expect(surface.launch(plan())).rejects.toThrow(SurfaceRefused)
  })

  /**
   * The launch runs inside the broker, which is one event loop serving every
   * session on the machine. `execFileSync` here stopped it dead for as long as
   * iTerm2 took — five seconds during a burst of spawns on 2026-08-31, which is
   * longer than a sibling agent's MCP server waits for its own registration
   * before giving up. Waiting on the script must yield, not block.
   */
  it('leaves the caller free to do other work while the script runs', async () => {
    const order: string[] = []
    let release = (): void => undefined
    const held = new Promise<void>(resolve => (release = resolve))
    const surface = surfaceFor('iterm-window', {
      platform: 'darwin',
      runAppleScript: async script => {
        if (script.includes('is running')) return 'true'
        order.push('script started')
        await held
        return 'NEW-SESSION-UUID'
      },
    })

    const launching = surface.launch(plan())
    // The point of the test: this only ever runs because the launch gave the
    // event loop back while osascript was outstanding.
    while (!order.includes('script started')) await new Promise(setImmediate)
    order.push('other work ran')
    release()

    await expect(launching).resolves.toMatchObject({ paneRef: 'NEW-SESSION-UUID' })
    expect(order).toEqual(['script started', 'other work ran'])
  })
})

/**
 * CC-37. Creation and destruction were asymmetric: a pane was opened and never
 * closed, so every retired agent left a dead shell behind. The constraint that
 * shapes all of it is that only a surface the BROKER opened may be closed — an
 * anchor is a human's own pane, reachable from a bus any peer can talk to.
 */
describe('tearing a surface down', () => {
  it('marks a surface it opened, and does not mark one it only wrote into', async () => {
    const { options } = fakeIterm()
    const opened = await surfaceFor('iterm-tab', { ...options, anchor: ANCHOR }).launch(plan())
    const reused = await surfaceFor('iterm-tab', {
      ...options,
      anchor: ANCHOR,
      reuseAnchor: true,
    }).launch(plan())

    expect(opened.ownsSurface).toBe(true)
    expect(reused.ownsSurface).toBeUndefined()
  })

  it('closes the session it opened, addressed by uuid rather than by focus', async () => {
    const { scripts, options } = fakeIterm()
    const surface = surfaceFor('iterm-pane', { ...options, anchor: ANCHOR })
    const handle = await surface.launch(plan())

    await expect(surface.close(handle)).resolves.toEqual({ closed: true })
    const script = scripts.find(s => s.includes('to close')) ?? ''
    expect(script).toContain('is "NEW-SESSION-UUID"')
    expect(script).not.toContain('current window')
    // And then it went back and looked, rather than trusting the close.
    expect(lastScript(scripts)).toContain(PRESENT)
  })

  /**
   * CC-95's fourth case. `@@closed@@` says the close script ran, which is a
   * different claim from "the pane is gone" — and the two diverged in the wild:
   * a close logged `closed:true` at 06:16:03Z and its pane was still sitting at
   * `-zsh` six and a half hours later. The only answer worth logging comes from
   * a second read of the session list.
   */
  it('reports closed:false with a reason when the session survives the close', async () => {
    const { scripts, options } = fakeIterm(true, true)
    const surface = surfaceFor('iterm-pane', { ...options, anchor: ANCHOR })
    const handle = await surface.launch(plan())

    const outcome = await surface.close(handle)

    expect(outcome.closed).toBe(false)
    expect(outcome.reason).toContain('still lists session NEW-SESSION-UUID')
    expect(lastScript(scripts)).toContain('@@present@@')
  })

  it('does not report a close it could not confirm', async () => {
    let calls = 0
    const surface = surfaceFor('iterm-pane', {
      platform: 'darwin',
      runAppleScript: script => {
        calls += 1
        if (script.includes('is running')) return Promise.resolve('true')
        if (script.includes('to close')) return Promise.resolve(CLOSED)
        return Promise.reject(new Error('osascript: no answer'))
      },
    })

    const outcome = await surface.close({ surface: 'iterm-pane', paneRef: UUID, ownsSurface: true })

    expect(outcome).toEqual({
      closed: false,
      reason: `could not re-read iTerm2 to confirm session ${UUID} is gone`,
    })
    expect(calls).toBeGreaterThan(2)
  })

  it('never closes a pane it did not open, and runs no script at all to decide that', async () => {
    const { scripts, options } = fakeIterm()
    const surface = surfaceFor('iterm-pane', { ...options, anchor: ANCHOR, reuseAnchor: true })
    const handle = await surface.launch(plan())
    const before = scripts.length

    const outcome = await surface.close(handle)

    expect(outcome.closed).toBe(false)
    expect(outcome.reason).toContain('did not open this surface')
    expect(scripts).toHaveLength(before)
  })

  /** The handle of an adopted session: a pane ref the broker recorded but never created. */
  it('never closes an adopted session’s own pane', async () => {
    const { scripts, options } = fakeIterm()
    const surface = surfaceFor('iterm-pane', { ...options, anchor: ANCHOR })

    await expect(surface.close({ surface: 'iterm-pane', paneRef: UUID })).resolves.toMatchObject({
      closed: false,
    })
    expect(scripts.some(script => script.includes('to close'))).toBe(false)
  })

  it('reports nothing closed when the human already closed the pane by hand', async () => {
    const { options } = fakeIterm(false)
    const surface = surfaceFor('iterm-pane', { ...options, anchor: ANCHOR })

    const outcome = await surface.close({ surface: 'iterm-pane', paneRef: 'GONE', ownsSurface: true })

    expect(outcome.closed).toBe(false)
    expect(outcome.reason).toContain('no longer lists session GONE')
  })

  /** A shutdown must not fail because iTerm2 quit, or because this is not a Mac. */
  it('reports nothing closed rather than throwing when iTerm2 cannot be reached', async () => {
    const surface = surfaceFor('iterm-pane', {
      platform: 'darwin',
      runAppleScript: () => Promise.reject(new Error('osascript: command not found')),
    })
    const handle = { surface: 'iterm-pane' as const, paneRef: UUID, ownsSurface: true }

    await expect(surface.close(handle)).resolves.toMatchObject({ closed: false })
    await expect(surfaceFor('iterm-pane', { platform: 'linux' }).close(handle)).resolves.toMatchObject({
      closed: false,
    })
  })

  it('has nothing to close for a headless agent', async () => {
    await expect(surfaceFor('headless').close({ surface: 'headless', pid: 42 })).resolves.toMatchObject({
      closed: false,
    })
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

/**
 * Regression, found on the first real teleport rather than by a test.
 *
 * A pane is opened by AppleScript and runs in a fresh shell carrying the USER's
 * environment, not the broker's — so a relocated `AGENT_CHAT_HOME` was invisible
 * to it and `run-agent` looked for its plan under the default home and died.
 * Headless never had the bug, because it is spawned by the broker and inherits
 * it, which is exactly why nothing caught this.
 */
describe('the command a visible surface hands to a shell', () => {
  it('carries the broker’s home, so the pane finds the plan the broker wrote', async () => {
    const previous = process.env.AGENT_CHAT_HOME
    process.env.AGENT_CHAT_HOME = '/tmp/somewhere else'
    try {
      const { scripts, options } = fakeIterm()
      await surfaceFor('iterm-tab', { ...options, anchor: ANCHOR }).launch(plan())

      expect(lastScript(scripts)).toContain("AGENT_CHAT_HOME='/tmp/somewhere else'")
    } finally {
      if (previous === undefined) delete process.env.AGENT_CHAT_HOME
      else process.env.AGENT_CHAT_HOME = previous
    }
  })
})

/**
 * CC-175. A pane was opened, iTerm made it active, and the command was then typed
 * into its shell with `write text` — so the human's keystrokes joined it. Seen
 * live on 2026-09-28: the pane ran `s aAGENT_CHAT_HOME=...`, zsh answered
 * "command not found: s", and the broker waited ten minutes to call it failed.
 */
describe('a pane the broker opens (CC-175)', () => {
  const TTY = '/dev/ttys042'

  /** An iTerm2 whose new pane has a tty and some text on screen. */
  function paneIterm(contents = 'Last login: Mon\n\nzsh: command not found: s\n\n') {
    const { scripts, options } = fakeIterm()
    const base = options.runAppleScript as (script: string) => Promise<string>
    const runAppleScript = async (script: string): Promise<string> => {
      if (script.includes('return tty of s')) return (scripts.push(script), TTY)
      if (script.includes('return contents of s')) return (scripts.push(script), contents)
      return base(script)
    }
    return { scripts, options: { ...options, runAppleScript, launchCheck: { deadlineMs: 20, pollMs: 5 } } }
  }

  const never = <T>(promise: Promise<T> | undefined, ms = 60): Promise<T | 'still pending'> =>
    Promise.race([
      promise ?? new Promise<T>(() => undefined),
      new Promise<'still pending'>(r => setTimeout(() => r('still pending'), ms)),
    ])

  const openings: [string, SurfaceName, Partial<SurfaceOptions>][] = [
    ['a pane beside the anchor', 'iterm-pane', { anchor: ANCHOR }],
    ['a pane stacked in the column', 'iterm-pane', { anchor: ANCHOR, columnAfter: 'FIRST-AGENT-PANE' }],
    ['a tab', 'iterm-tab', { anchor: ANCHOR }],
    ['a window', 'iterm-window', {}],
  ]

  it.each(openings)(
    'never types the command into %s, handing it to iTerm at creation',
    async (_, name, over) => {
      const { scripts, options } = fakeIterm()
      await surfaceFor(name, { ...options, ...over }).launch(plan())

      const script = lastScript(scripts)
      expect(script).not.toContain('write text')
      expect(script).toMatch(/with default profile command "/)
      expect(script).toContain('run-agent')
    },
  )

  it('wraps the command in a login shell that keeps the pane after it exits', async () => {
    const { scripts, options } = fakeIterm()
    await surfaceFor('iterm-pane', { ...options, anchor: ANCHOR }).launch(plan())

    // Undo the AppleScript string, then iTerm's own word splitting: double-quoted words, no escapes.
    const quoted = /command "((?:[^"\\]|\\.)*)"/.exec(lastScript(scripts))?.[1] ?? ''
    const argv = [...quoted.replaceAll('\\"', '"').matchAll(/"([^"\\]*)"/g)].map(match => match[1])

    expect(argv.slice(0, 2)).toEqual(['/bin/zsh', '-lic'])
    expect(argv[2]).toMatch(
      /^AGENT_CHAT_HOME='[^']*' '[^']*node[^']*' '[^']*' 'run-agent' 'ag000001'; exec \/bin\/zsh -l$/,
    )
    expect(argv).toHaveLength(3)
  })

  it('refuses a path iTerm2 could not carry intact, rather than launching a mangled one', async () => {
    const previous = process.env.AGENT_CHAT_HOME
    process.env.AGENT_CHAT_HOME = '/tmp/a "quoted" home'
    try {
      const { options } = fakeIterm()
      await expect(surfaceFor('iterm-tab', { ...options, anchor: ANCHOR }).launch(plan())).rejects.toThrow(
        /double quote or backslash/,
      )
    } finally {
      if (previous === undefined) delete process.env.AGENT_CHAT_HOME
      else process.env.AGENT_CHAT_HOME = previous
    }
  })

  it.each(openings.slice(0, 3))(
    'gives focus back to the anchor window after opening %s',
    async (_, name, over) => {
      const { scripts, options } = fakeIterm()
      await surfaceFor(name, { ...options, ...over }).launch(plan())

      const script = lastScript(scripts)
      const opened = script.indexOf('set spawned to')
      expect(script.indexOf('set anchorTab to current tab of anchorWindow')).toBeLessThan(opened)
      expect(script.indexOf('select anchorTab')).toBeGreaterThan(opened)
      expect(script.indexOf('select anchorWindowSession')).toBeGreaterThan(opened)
      expect(script.indexOf('select priorWindow')).toBeGreaterThan(opened)
    },
  )

  it('gives focus back to the window the human was in after opening a window', async () => {
    const { scripts, options } = fakeIterm()
    await surfaceFor('iterm-window', options).launch(plan())

    const script = lastScript(scripts)
    expect(script.indexOf('set priorWindow to current window')).toBeLessThan(script.indexOf('set spawned to'))
    expect(script.indexOf('select priorWindow')).toBeGreaterThan(script.indexOf('set spawned to'))
  })

  it('clears the prompt line before typing into a reused pane, the one case that still types', async () => {
    const { scripts, options } = fakeIterm()
    await surfaceFor('iterm-tab', { ...options, anchor: ANCHOR, reuseAnchor: true }).launch(plan())

    const script = lastScript(scripts)
    const clear = script.indexOf('write text (character id 21) newline no')
    expect(clear).toBeGreaterThan(-1)
    expect(clear).toBeLessThan(script.indexOf('write text "'))
  })

  it('fails the launch within the check window, quoting the pane, when run-agent never started', async () => {
    const { options } = paneIterm()
    const probed: string[] = []
    const handle = await surfaceFor('iterm-pane', {
      ...options,
      anchor: ANCHOR,
      probeProcesses: async tty => (probed.push(tty), ['-zsh', '/bin/zsh -l']),
    }).launch(plan())

    const reason = await never(handle.launchFailed, 1000)

    expect(reason).toMatch(/run-agent ag000001 was not running in its pane/)
    expect(reason).toContain("The pane's last lines:\nLast login: Mon\nzsh: command not found: s")
    expect(probed[0]).toBe('ttys042')
  })

  it('stays quiet once run-agent is seen on the pane’s tty', async () => {
    const { options } = paneIterm()
    const handle = await surfaceFor('iterm-pane', {
      ...options,
      anchor: ANCHOR,
      probeProcesses: async () => ['-zsh', `/opt/node /x/dist/cli.js run-agent ag000001`],
    }).launch(plan())

    await expect(never(handle.launchFailed)).resolves.toBe('still pending')
  })

  it('does not count the zsh wrapper, whose -c string quotes the same words, as run-agent', async () => {
    const { options } = paneIterm()
    const handle = await surfaceFor('iterm-pane', {
      ...options,
      anchor: ANCHOR,
      probeProcesses: async () => [
        `/bin/zsh -lic AGENT_CHAT_HOME='/h' '/opt/node' 'cli.js' 'run-agent' 'ag000001'; exec /bin/zsh -l`,
      ],
    }).launch(plan())

    await expect(never(handle.launchFailed, 1000)).resolves.toMatch(/was not running/)
  })

  it('fails nothing when it cannot tell: ps erroring, or no tty it recognises', async () => {
    const erroring = await surfaceFor('iterm-pane', {
      ...paneIterm().options,
      anchor: ANCHOR,
      probeProcesses: () => Promise.reject(new Error('ps: not permitted')),
    }).launch(plan())
    const { options } = fakeIterm()
    const noTty = await surfaceFor('iterm-pane', {
      ...options,
      anchor: ANCHOR,
      launchCheck: { deadlineMs: 20, pollMs: 5 },
      probeProcesses: async () => [],
    }).launch(plan())

    await expect(never(erroring.launchFailed)).resolves.toBe('still pending')
    await expect(never(noTty.launchFailed)).resolves.toBe('still pending')
  })

  it('does not arm the check for a pane it only typed into', async () => {
    const { options } = paneIterm()
    const handle = await surfaceFor('iterm-tab', { ...options, anchor: ANCHOR, reuseAnchor: true }).launch(
      plan(),
    )

    expect(handle.launchFailed).toBeUndefined()
  })
})
