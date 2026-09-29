import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { describeJob } from '../cli/verbs/mirror.js'
import { openMirrorState } from '../mirror/run.js'
import {
  jobState,
  startJob,
  stopJob,
  type JobPaths,
  type Launchctl,
  type LaunchctlResult,
} from '../mirror/launchd.js'

const LABEL = 'dev.hjewkes.agent-chat-mirror'
const SERVICE = `gui/501/${LABEL}`

/** A launchd stand-in: records every call and answers `print` from `loaded`. */
function fakeLaunchctl(loaded: boolean): { launchctl: Launchctl; calls: string[] } {
  const calls: string[] = []
  const launchctl: Launchctl = args => {
    calls.push(args.join(' '))
    if (args[0] === 'print') {
      return loaded
        ? { code: 0, stdout: '\tstate = running\n\tpid = 777\n', stderr: '' }
        : { code: 113, stdout: '', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { launchctl, calls }
}

/** `loaded` answers `print`; `disabledLine` is what `print-disabled` lists for the label. */
function fakeStopped(loaded: boolean, state: 'disabled' | 'enabled' | null): Launchctl {
  return args => {
    if (args[0] === 'print') {
      return loaded
        ? { code: 0, stdout: '\tstate = waiting\n', stderr: '' }
        : { code: 113, stdout: '', stderr: '' }
    }
    const other = '\t\t"com.other.job" => disabled\n'
    const own = state === null ? '' : `\t\t"${LABEL}" => ${state}\n`
    return { code: 0, stdout: `disabled services = {\n${other}${own}}\n`, stderr: '' }
  }
}

let dir: string
let paths: JobPaths

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-mirror-launchd-'))
  paths = { plist: path.join(dir, 'LaunchAgents', 'job.plist'), logDir: path.join(dir, 'Logs') }
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('startJob', () => {
  it('writes the plist, then enables, bootstraps and kickstarts a job that is not loaded', () => {
    const { launchctl, calls } = fakeLaunchctl(false)
    const result = startJob(paths, '<plist/>', { launchctl, uid: 501, dryRun: false, label: LABEL })

    expect(result.ok).toBe(true)
    expect(fs.readFileSync(paths.plist, 'utf8')).toBe('<plist/>')
    expect(fs.existsSync(paths.logDir)).toBe(true)
    expect(calls).toEqual([
      `print ${SERVICE}`,
      `enable ${SERVICE}`,
      `bootstrap gui/501 ${paths.plist}`,
      `kickstart ${SERVICE}`,
    ])
  })

  it('boots out and reloads a loaded job whose plist changed', () => {
    fs.mkdirSync(path.dirname(paths.plist), { recursive: true })
    fs.writeFileSync(paths.plist, '<old/>')
    const { launchctl, calls } = fakeLaunchctl(true)
    startJob(paths, '<new/>', { launchctl, uid: 501, dryRun: false, label: LABEL })
    expect(calls.slice(1, 3)).toEqual([`bootout ${SERVICE}`, `enable ${SERVICE}`])
    expect(calls).toContain(`bootstrap gui/501 ${paths.plist}`)
  })

  it('only kickstarts a loaded job whose plist is unchanged', () => {
    fs.mkdirSync(path.dirname(paths.plist), { recursive: true })
    fs.writeFileSync(paths.plist, '<same/>')
    const { launchctl, calls } = fakeLaunchctl(true)
    startJob(paths, '<same/>', { launchctl, uid: 501, dryRun: false, label: LABEL })
    expect(calls).toEqual([`print ${SERVICE}`, `enable ${SERVICE}`, `kickstart ${SERVICE}`])
  })

  it('changes nothing on a dry run and reports what it would do', () => {
    const { launchctl, calls } = fakeLaunchctl(false)
    const result = startJob(paths, '<plist/>', { launchctl, uid: 501, dryRun: true, label: LABEL })
    expect(fs.existsSync(paths.plist)).toBe(false)
    expect(calls).toEqual([`print ${SERVICE}`])
    expect(result.lines).toContain(`write ${paths.plist}`)
    expect(result.lines).toContain(`launchctl kickstart ${SERVICE}`)
  })

  it('stops at a failed bootstrap and says why', () => {
    const calls: string[] = []
    const launchctl: Launchctl = args => {
      calls.push(args[0] ?? '')
      if (args[0] === 'print') return { code: 113, stdout: '', stderr: '' }
      if (args[0] === 'bootstrap')
        return { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error\n' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const result = startJob(paths, '<plist/>', { launchctl, uid: 501, dryRun: false, label: LABEL })
    expect(result.ok).toBe(false)
    expect(result.lines.at(-1)).toBe('  exit 5: Bootstrap failed: 5: Input/output error')
    expect(calls).not.toContain('kickstart')
  })
})

describe('stopJob and jobState', () => {
  it('boots out and disables, so the job does not return at the next login', () => {
    const { launchctl, calls } = fakeLaunchctl(true)
    stopJob({ launchctl, uid: 501, dryRun: false, label: LABEL })
    expect(calls).toEqual([`print ${SERVICE}`, `bootout ${SERVICE}`, `disable ${SERVICE}`])
  })

  it('reads the pid of a running job', () => {
    expect(jobState({ launchctl: fakeLaunchctl(true).launchctl, uid: 501, label: LABEL })).toEqual({
      loaded: true,
      pid: 777,
      disabled: false,
    })
    expect(jobState({ launchctl: fakeLaunchctl(false).launchctl, uid: 501, label: LABEL })).toEqual({
      loaded: false,
      pid: null,
      disabled: false,
    })
  })

  it('reports a disabled label as disabled, whether or not it is loaded', () => {
    const state = (loaded: boolean, listed: 'disabled' | 'enabled' | null) =>
      jobState({ launchctl: fakeStopped(loaded, listed), uid: 501, label: LABEL })
    expect(state(false, 'disabled')).toEqual({ loaded: false, pid: null, disabled: true })
    expect(state(true, 'disabled').disabled).toBe(true)
  })

  it('does not call a crashed or never-started job disabled', () => {
    const state = (loaded: boolean, listed: 'disabled' | 'enabled' | null) =>
      jobState({ launchctl: fakeStopped(loaded, listed), uid: 501, label: LABEL })
    expect(state(true, 'enabled').disabled).toBe(false)
    expect(state(false, null).disabled).toBe(false)
  })
})

describe('jobState reading print-disabled (CC-155)', () => {
  /** A `print` that finds the job down, and a `print-disabled` that answers with `listing`. */
  function withListing(listing: LaunchctlResult, label = LABEL, pid: number | null = null) {
    const calls: string[] = []
    const launchctl: Launchctl = args => {
      calls.push(args[0] as string)
      if (args[0] === 'print') {
        return { code: 0, stdout: pid === null ? '\tstate = waiting\n' : `\tpid = ${pid}\n`, stderr: '' }
      }
      return listing
    }
    return { state: jobState({ launchctl, uid: 501, label }), calls }
  }
  const listing = (body: string): LaunchctlResult => ({
    code: 0,
    stdout: `disabled services = {\n${body}}\n`,
    stderr: '',
  })

  it('does not ask print-disabled about a job that is running, even if it lists the label as disabled', () => {
    const { state, calls } = withListing(listing(`\t\t"${LABEL}" => disabled\n`), LABEL, 42)

    expect(state.disabled).toBe(false)
    expect(calls).toEqual(['print'])
  })

  it('reads the legacy `=> true` form as disabled and `=> false` as enabled', () => {
    expect(withListing(listing(`\t\t"${LABEL}" => true\n`)).state.disabled).toBe(true)
    expect(withListing(listing(`\t\t"${LABEL}" => false\n`)).state.disabled).toBe(false)
  })

  it('matches the label literally, so a dot is not a wildcard', () => {
    const { state } = withListing(listing('\t\t"dev-hjewkes-agent-chat-mirror" => disabled\n'))

    expect(state.disabled).toBe(false)
  })

  it('does not mistake a longer label that starts with this one for this one', () => {
    const { state } = withListing(listing(`\t\t"${LABEL}-2" => disabled\n`))

    expect(state.disabled).toBe(false)
  })

  it('does not call a job disabled when launchctl print-disabled fails', () => {
    const failed = { code: 1, stdout: `\t\t"${LABEL}" => disabled\n`, stderr: 'boom' }

    expect(withListing(failed).state.disabled).toBe(false)
  })
})

describe('describeJob (the status line)', () => {
  it('tells a stopped job from a crashed one and from one that never loaded', () => {
    expect(describeJob({ loaded: false, pid: null, disabled: true })).toBe('stopped (disabled)')
    expect(describeJob({ loaded: true, pid: null, disabled: false })).toBe('loaded, not running')
    expect(describeJob({ loaded: false, pid: null, disabled: false })).toBe('not loaded')
    expect(describeJob({ loaded: true, pid: 9, disabled: false })).toBe('loaded, pid 9')
  })
})

describe('openMirrorState', () => {
  it('persists the cursors across a reopen, in a 0600 file', async () => {
    const file = path.join(dir, 'mirror.db')
    const first = await openMirrorState(file)
    first.state.commit({ sourceCursor: '41', syncToken: 's9' })
    first.close()

    const second = await openMirrorState(file)
    expect([second.state.sourceCursor(), second.state.syncToken()]).toEqual(['41', 's9'])
    second.close()
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })
})
