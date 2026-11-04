import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BROKER_UNIT, launchBroker, userUnitPath, type LauncherDeps } from '../client/broker-launcher.js'

const HOMEDIR = '/srv/u'
const UNIT = `${HOMEDIR}/.config/systemd/user/${BROKER_UNIT}`

function deps(overrides: Partial<LauncherDeps> & { installed?: boolean } = {}): LauncherDeps {
  const { installed = true, ...rest } = overrides
  return {
    env: {},
    platform: 'linux',
    homedir: HOMEDIR,
    exists: file => installed && file === UNIT,
    startUnit: vi.fn(async () => {}),
    spawnDirect: vi.fn(),
    warn: vi.fn(),
    ...rest,
  }
}

describe('broker auto-start launcher', () => {
  it('starts the user unit, and forks nothing, when the unit is installed', async () => {
    const d = deps()

    const via = await launchBroker(d)

    expect(via).toBe('unit')
    expect(d.startUnit).toHaveBeenCalledWith(BROKER_UNIT)
    expect(d.spawnDirect).not.toHaveBeenCalled()
    expect(d.warn).not.toHaveBeenCalled()
  })

  it('forks the broker as before, with a warning naming the unit, when the unit is absent', async () => {
    const d = deps({ installed: false })

    const via = await launchBroker(d)

    expect(via).toBe('spawn')
    expect(d.startUnit).not.toHaveBeenCalled()
    expect(d.spawnDirect).toHaveBeenCalledOnce()
    expect(d.warn).toHaveBeenCalledWith(expect.stringContaining(`${UNIT} is not installed`))
  })

  it('falls back to forking, with a warning, when systemctl fails', async () => {
    const d = deps({ startUnit: vi.fn(async () => Promise.reject(new Error('no user bus'))) })

    const via = await launchBroker(d)

    expect(via).toBe('spawn')
    expect(d.spawnDirect).toHaveBeenCalledOnce()
    expect(d.warn).toHaveBeenCalledWith(expect.stringContaining('no user bus'))
  })

  it('never routes a broker for a non-default home through the unit', async () => {
    const d = deps({ env: { AGENT_CHAT_HOME: '/tmp/other-home' } })

    const via = await launchBroker(d)

    expect(via).toBe('spawn')
    expect(d.startUnit).not.toHaveBeenCalled()
    expect(d.warn).not.toHaveBeenCalled()
  })

  it('forks silently off Linux, where there is no systemd user manager', async () => {
    const d = deps({ platform: 'darwin' })

    expect(await launchBroker(d)).toBe('spawn')
    expect(d.startUnit).not.toHaveBeenCalled()
    expect(d.warn).not.toHaveBeenCalled()
  })

  it('looks for the unit under XDG_CONFIG_HOME when it is set', () => {
    expect(userUnitPath({ XDG_CONFIG_HOME: '/x/cfg' }, HOMEDIR)).toBe(`/x/cfg/systemd/user/${BROKER_UNIT}`)
  })
})

describe('checked-in restart units', () => {
  const unit = (name: string): string => fs.readFileSync(path.join('ops/systemd', name), 'utf8')

  it('runs the redeploy as a oneshot over restart-window.sh that never kills the broker it started', () => {
    const redeploy = unit('agent-chat-redeploy.service')

    expect(redeploy).toMatch(/^Type=oneshot$/m)
    expect(redeploy).toMatch(/^ExecStart=@REPO@\/scripts\/redeploy\.sh$/m)
    expect(redeploy).toMatch(/^KillMode=process$/m)
    expect(fs.readFileSync('scripts/redeploy.sh', 'utf8')).toContain('scripts/restart-window.sh')
  })

  it('names the broker unit the launcher starts, and leaves its agents alive when the broker exits', () => {
    const broker = unit(BROKER_UNIT)

    expect(broker).toMatch(/^ExecStart=@NODE@ @CLI@ broker$/m)
    expect(broker).toMatch(/^KillMode=process$/m)
  })
})
