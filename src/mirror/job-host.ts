import { systemLaunchctl, type JobControl, type JobState, type Launchctl } from './launchd.js'
import { systemSystemctl, type Systemctl, type UnitControl } from './systemd.js'
import { systemdUserUnitDir } from '../paths.js'

/**
 * Where a scheduled job is installed (CC-816): launchd on darwin, systemd --user on Linux.
 * Every installer branches on `platform` here, so a darwin test drives the Linux path.
 */
export interface JobHost {
  platform: NodeJS.Platform
  launchctl: Launchctl
  systemctl: Systemctl
  uid: number
  unitDir: string
  dryRun: boolean
}

export const systemHost = (dryRun = false): JobHost => ({
  platform: process.platform,
  launchctl: systemLaunchctl,
  systemctl: systemSystemctl,
  uid: process.getuid?.() ?? 0,
  unitDir: systemdUserUnitDir(),
  dryRun,
})

export const usesSystemd = (host: JobHost): boolean => host.platform === 'linux'

export const launchdControl = (host: JobHost, label: string): JobControl => ({
  launchctl: host.launchctl,
  uid: host.uid,
  dryRun: host.dryRun,
  label,
})

export const unitControl = (host: JobHost): UnitControl => ({
  systemctl: host.systemctl,
  dryRun: host.dryRun,
  unitDir: host.unitDir,
})

export const describeLaunchd = (job: JobState): string =>
  job.loaded ? `loaded${job.pid === null ? ', not running' : `, pid ${job.pid}`}` : 'not loaded'
