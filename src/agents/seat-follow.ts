import os from 'node:os'
import path from 'node:path'
import { parsePools } from './seats/charter.js'
import { defaultAutonomyRoot, isWatchedSeat, readText } from './seats/io.js'
import { poolForDir, rewriteSeatAccount, writeSeatFile } from './seats/seat-account-write.js'

/** CC-892 d: a watched seat that attaches after an account move gets its seat file moved to the new account. */

interface AttachRow {
  kind: string
  ref?: string
  meta?: Record<string, string>
}

/** The slice of the broker core this watcher reads. */
export interface SeatFollowCore {
  onAppend(watch: (row: AttachRow) => void): () => void
  agents: { get(agentId: string): { name: string; configDir?: string } | undefined }
}

export interface SeatFollowOptions {
  root?: string
  home?: string
  now?: () => Date
  onError?: (err: unknown) => void
}

const pad = (n: number): string => String(n).padStart(2, '0')

const localDate = (at: Date): string => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`

function follow(core: SeatFollowCore, row: AttachRow, opts: SeatFollowOptions): void {
  const oldDir = row.meta?.account_from
  if (row.kind !== 'agent_attached' || row.ref === undefined || !oldDir) return
  const agent = core.agents.get(row.ref)
  const root = opts.root ?? defaultAutonomyRoot()
  if (agent?.configDir === undefined || !isWatchedSeat(agent.name, root)) return
  const home = opts.home ?? os.homedir()
  const file = path.join(root, 'seats', `${agent.name}.md`)
  const text = readText(file)
  const charter = readText(path.join(root, 'charter.md'))
  if (text === undefined || charter === undefined) return
  const newPool = poolForDir(parsePools(charter, home), agent.configDir)
  const next = rewriteSeatAccount(text, {
    newDir: agent.configDir,
    newPool,
    oldDir,
    date: localDate((opts.now ?? (() => new Date()))()),
    home,
  })
  if (next !== undefined) writeSeatFile(file, text, next)
}

/** Subscribes to the log; returns the unsubscribe. A failed rewrite goes to `onError` and never reaches the broker. */
export function watchSeatFollow(core: SeatFollowCore, opts: SeatFollowOptions = {}): () => void {
  return core.onAppend(row => {
    try {
      follow(core, row, opts)
    } catch (err) {
      opts.onError?.(err)
    }
  })
}
