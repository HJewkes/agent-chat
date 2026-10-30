import fs from 'node:fs'

/**
 * CC-1265: filesystem headroom as one shared admission input. A /tmp that ran out of
 * inodes broke every agent on the machine while the memory guard read all clear, so
 * the spawn gate and the seat stop both read these, each against its own limits.
 *
 * A resource is a union member, so a later budget (gh calls) joins as one more member
 * and one more reader. A reading that fails never breaches: a broken reader would
 * otherwise stop every seat on the machine.
 */

export type HeadroomResource = 'tmp_inodes' | 'tmp_bytes' | 'disk_bytes'

export type HeadroomReading = { usedPercent: number } | { error: string }

export type HeadroomReadings = Record<HeadroomResource, HeadroomReading>

/** Used percent at or above which the resource holds; `null` disables it. */
export type HeadroomLimits = Record<HeadroomResource, { percent: number | null; configKey: string }>

export interface HeadroomBreach {
  resource: HeadroomResource
  usedPercent: number
  limit: number
  configKey: string
}

export interface StatfsLike {
  blocks: number
  bfree: number
  bavail: number
  files: number
  ffree: number
}

export type Statfs = (path: string) => StatfsLike

export const TMP_PATH = '/tmp'

/** On macOS `/` is the sealed system snapshot, so its used bytes miss user data. */
export const diskRootPath = (platform: NodeJS.Platform): string =>
  platform === 'darwin' ? '/System/Volumes/Data' : '/'

const ceilPercent = (used: number, total: number): number => Math.ceil((used * 100) / total)

/** Used percent as `df` reports it: reserved blocks count as neither used nor available. */
export function parseStatfs(stats: StatfsLike): { bytes: HeadroomReading; inodes: HeadroomReading } {
  const usedBlocks = stats.blocks - stats.bfree
  const blockTotal = usedBlocks + stats.bavail
  return {
    bytes: blockTotal > 0 ? { usedPercent: ceilPercent(usedBlocks, blockTotal) } : { error: 'no blocks' },
    inodes:
      stats.files > 0
        ? { usedPercent: ceilPercent(stats.files - stats.ffree, stats.files) }
        : { error: 'no inode cap' },
  }
}

function statPath(statfs: Statfs, path: string): ReturnType<typeof parseStatfs> {
  try {
    return parseStatfs(statfs(path))
  } catch (err) {
    const error = `statfs ${path}: ${err instanceof Error ? err.message : String(err)}`
    return { bytes: { error }, inodes: { error } }
  }
}

export function readHostHeadroom(
  statfs: Statfs = fs.statfsSync,
  platform: NodeJS.Platform = process.platform,
): HeadroomReadings {
  const tmp = statPath(statfs, TMP_PATH)
  const disk = statPath(statfs, diskRootPath(platform))
  return { tmp_inodes: tmp.inodes, tmp_bytes: tmp.bytes, disk_bytes: disk.bytes }
}

export const HEADROOM_RESOURCES: readonly HeadroomResource[] = ['tmp_inodes', 'tmp_bytes', 'disk_bytes']

/** Platform-free labels for a one-line reading, where the disk path would only add width. */
export const HEADROOM_SHORT_LABELS: Record<HeadroomResource, string> = {
  tmp_inodes: `${TMP_PATH} inodes`,
  tmp_bytes: `${TMP_PATH} bytes`,
  disk_bytes: 'disk',
}

export function headroomBreaches(readings: HeadroomReadings, limits: HeadroomLimits): HeadroomBreach[] {
  return HEADROOM_RESOURCES.flatMap(resource => {
    const reading = readings[resource]
    const { percent, configKey } = limits[resource]
    if (!('usedPercent' in reading) || percent === null || reading.usedPercent < percent) return []
    return [{ resource, usedPercent: reading.usedPercent, limit: percent, configKey }]
  })
}

export function resourceLabel(
  resource: HeadroomResource,
  platform: NodeJS.Platform = process.platform,
): string {
  if (resource === 'tmp_inodes') return `${TMP_PATH} inodes`
  if (resource === 'tmp_bytes') return `${TMP_PATH} bytes`
  return `disk bytes (${diskRootPath(platform)})`
}

export const describeBreach = (b: HeadroomBreach, platform: NodeJS.Platform = process.platform): string =>
  `${resourceLabel(b.resource, platform)} ${b.usedPercent}% used (limit ${b.limit}%, config ${b.configKey})`
