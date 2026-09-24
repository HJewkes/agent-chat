import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openMirrorState } from '../mirror/run.js'
import { jobState, startJob, stopJob, type JobPaths, type Launchctl } from '../mirror/launchd.js'

const SERVICE = 'gui/501/dev.hjewkes.agent-chat-mirror'

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
    const result = startJob(paths, '<plist/>', { launchctl, uid: 501, dryRun: false })

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
    startJob(paths, '<new/>', { launchctl, uid: 501, dryRun: false })
    expect(calls.slice(1, 3)).toEqual([`bootout ${SERVICE}`, `enable ${SERVICE}`])
    expect(calls).toContain(`bootstrap gui/501 ${paths.plist}`)
  })

  it('only kickstarts a loaded job whose plist is unchanged', () => {
    fs.mkdirSync(path.dirname(paths.plist), { recursive: true })
    fs.writeFileSync(paths.plist, '<same/>')
    const { launchctl, calls } = fakeLaunchctl(true)
    startJob(paths, '<same/>', { launchctl, uid: 501, dryRun: false })
    expect(calls).toEqual([`print ${SERVICE}`, `enable ${SERVICE}`, `kickstart ${SERVICE}`])
  })

  it('changes nothing on a dry run and reports what it would do', () => {
    const { launchctl, calls } = fakeLaunchctl(false)
    const result = startJob(paths, '<plist/>', { launchctl, uid: 501, dryRun: true })
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
    const result = startJob(paths, '<plist/>', { launchctl, uid: 501, dryRun: false })
    expect(result.ok).toBe(false)
    expect(result.lines.at(-1)).toBe('  exit 5: Bootstrap failed: 5: Input/output error')
    expect(calls).not.toContain('kickstart')
  })
})

describe('stopJob and jobState', () => {
  it('boots out and disables, so the job does not return at the next login', () => {
    const { launchctl, calls } = fakeLaunchctl(true)
    stopJob({ launchctl, uid: 501, dryRun: false })
    expect(calls).toEqual([`print ${SERVICE}`, `bootout ${SERVICE}`, `disable ${SERVICE}`])
  })

  it('reads the pid of a running job', () => {
    expect(jobState({ launchctl: fakeLaunchctl(true).launchctl, uid: 501 })).toEqual({
      loaded: true,
      pid: 777,
    })
    expect(jobState({ launchctl: fakeLaunchctl(false).launchctl, uid: 501 })).toEqual({
      loaded: false,
      pid: null,
    })
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
