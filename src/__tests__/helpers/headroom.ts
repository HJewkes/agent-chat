import type { HeadroomLimits, HeadroomReadings } from '../../agents/host-headroom.js'

/** CC-1265: /tmp and disk readings well under every limit, so a fixture never trips the headroom gate. */
export const CLEAR_HEADROOM: HeadroomReadings = {
  tmp_inodes: { usedPercent: 13 },
  tmp_bytes: { usedPercent: 20 },
  disk_bytes: { usedPercent: 40 },
}

/** The spawn gate's default headroom limits, as `resolveMachineLimits` builds them. */
export const SPAWN_HEADROOM_LIMITS: HeadroomLimits = {
  tmp_inodes: { percent: 70, configKey: 'machineTmpInodesPercent' },
  tmp_bytes: { percent: 85, configKey: 'machineTmpBytesPercent' },
  disk_bytes: { percent: 90, configKey: 'machineDiskBytesPercent' },
}

/** The seat machine stop's default headroom limits, as `resolveMachineStopLimits` builds them. */
export const STOP_HEADROOM_LIMITS: HeadroomLimits = {
  tmp_inodes: { percent: 80, configKey: 'machineStopTmpInodesPercent' },
  tmp_bytes: { percent: 95, configKey: 'machineStopTmpBytesPercent' },
  disk_bytes: { percent: 95, configKey: 'machineStopDiskBytesPercent' },
}
