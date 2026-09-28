import fs from 'node:fs'
import path from 'node:path'
import { home } from '../paths.js'
import type { BatchItem } from './batch.js'

/** What the numbers in the last printed batch meant; answers resolve through this and nothing else. */
export interface Snapshot {
  batch: string
  items: Pick<BatchItem, 'n' | 'msgId' | 'section'>[]
}

export const snapshotPath = (): string => path.join(home(), 'inbox-batch.json')

export function writeSnapshot(snapshot: Snapshot): void {
  fs.mkdirSync(home(), { recursive: true })
  const tmp = `${snapshotPath()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, snapshotPath())
}

export function readSnapshot(): Snapshot | undefined {
  try {
    return JSON.parse(fs.readFileSync(snapshotPath(), 'utf8')) as Snapshot
  } catch {
    return undefined
  }
}
