import { describe, expect, it } from 'vitest'
import {
  describeBreach,
  headroomBreaches,
  parseStatfs,
  readHostHeadroom,
  type HeadroomLimits,
  type HeadroomReadings,
  type StatfsLike,
} from '../agents/host-headroom.js'

/** CC-1265: /tmp and disk-root headroom from injected statfs readings. */

const STATS: StatfsLike = { blocks: 1000, bfree: 500, bavail: 500, files: 1000, ffree: 500 }

const LIMITS: HeadroomLimits = {
  tmp_inodes: { percent: 70, configKey: 'machineTmpInodesPercent' },
  tmp_bytes: { percent: 85, configKey: 'machineTmpBytesPercent' },
  disk_bytes: { percent: 90, configKey: 'machineDiskBytesPercent' },
}

const readings = (tmpInodes: number, tmpBytes = 10, diskBytes = 10): HeadroomReadings => ({
  tmp_inodes: { usedPercent: tmpInodes },
  tmp_bytes: { usedPercent: tmpBytes },
  disk_bytes: { usedPercent: diskBytes },
})

describe('parsing a statfs reading', () => {
  it('rounds inode use up to a whole percent, as df does', () => {
    const tmpfs = { ...STATS, files: 1048576, ffree: 314573 }

    expect(parseStatfs(tmpfs).inodes).toEqual({ usedPercent: 70 })
  })

  it('leaves reserved blocks out of the byte total, matching df', () => {
    const reserved = { ...STATS, blocks: 1000, bfree: 200, bavail: 150 }

    expect(parseStatfs(reserved).bytes).toEqual({ usedPercent: 85 })
  })

  it('reports a filesystem with no inode cap as an error, not 0%', () => {
    expect(parseStatfs({ ...STATS, files: 0, ffree: 0 }).inodes).toHaveProperty('error')
  })

  it('reports a filesystem with no blocks as an error', () => {
    expect(parseStatfs({ ...STATS, blocks: 0, bfree: 0, bavail: 0 }).bytes).toHaveProperty('error')
  })
})

describe('reading host headroom', () => {
  it('fails only the resources of a path whose statfs throws', () => {
    const statfs = (path: string): StatfsLike => {
      if (path === '/tmp') throw new Error('EACCES')
      return STATS
    }

    const result = readHostHeadroom(statfs, 'linux')

    expect(result.tmp_inodes).toEqual({ error: 'statfs /tmp: EACCES' })
    expect(result.tmp_bytes).toEqual({ error: 'statfs /tmp: EACCES' })
    expect(result.disk_bytes).toEqual({ usedPercent: 50 })
  })

  it('reads the disk root at / on Linux and at the data volume on darwin', () => {
    const paths: string[] = []
    const statfs = (path: string): StatfsLike => (paths.push(path), STATS)

    readHostHeadroom(statfs, 'linux')
    readHostHeadroom(statfs, 'darwin')

    expect(paths).toEqual(['/tmp', '/', '/tmp', '/System/Volumes/Data'])
  })
})

describe('headroom breaches', () => {
  it('holds a resource at its limit and not one below it', () => {
    expect(headroomBreaches(readings(69, 84, 89), LIMITS)).toEqual([])
    expect(headroomBreaches(readings(70, 85, 90), LIMITS).map(b => b.resource)).toEqual([
      'tmp_inodes',
      'tmp_bytes',
      'disk_bytes',
    ])
  })

  it('never breaches a disabled limit', () => {
    const disabled = { ...LIMITS, tmp_inodes: { percent: null, configKey: 'machineTmpInodesPercent' } }

    expect(headroomBreaches(readings(100), disabled)).toEqual([])
  })

  it('never breaches on a failed reading', () => {
    const failed = { ...readings(10), tmp_inodes: { error: 'statfs /tmp: EIO' } }

    expect(headroomBreaches(failed, LIMITS)).toEqual([])
  })

  it('describes a breach by resource, reading, limit and config key', () => {
    const [breach] = headroomBreaches(readings(72), LIMITS)

    expect(describeBreach(breach!, 'linux')).toBe(
      '/tmp inodes 72% used (limit 70%, config machineTmpInodesPercent)',
    )
  })

  it('names the darwin data volume in a disk breach', () => {
    const [breach] = headroomBreaches(readings(10, 10, 95), LIMITS)

    expect(describeBreach(breach!, 'darwin')).toBe(
      'disk bytes (/System/Volumes/Data) 95% used (limit 90%, config machineDiskBytesPercent)',
    )
  })
})
