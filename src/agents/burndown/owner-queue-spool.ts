import os from 'node:os'
import path from 'node:path'
import type { OwnerItem } from '@titan-design/owner-queue'
import { readAnswer, readSpool, writeDeposit } from '@titan-design/owner-queue/spool'
import type { OwnerQueuePort } from './seat-tick.js'

const expandHome = (value: string, home: string): string =>
  value === '~' ? home : value.startsWith('~/') ? path.join(home, value.slice(2)) : value

/**
 * The deposit spool the titan console reads: `TITAN_CONSOLE_INBOX_DIR`, else `inbox/deposits` under
 * `TITAN_CONSOLE_STATE` (default `~/.local/state/titan-console`). The same resolution as the console's config, so
 * a deposit lands where its reader looks.
 */
export function ownerQueueSpoolDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const inbox = env.TITAN_CONSOLE_INBOX_DIR
  if (inbox) return expandHome(inbox, home)
  const state = expandHome(env.TITAN_CONSOLE_STATE ?? '~/.local/state/titan-console', home)
  return path.join(state, 'inbox', 'deposits')
}

/**
 * An item is open until an answer file is filed beside it; `readSpool` reports every deposit as open, and the
 * package has no other resolution record. A malformed answer file counts as unanswered, so the tick never files a
 * duplicate over it.
 */
async function unanswered(dir: string, item: OwnerItem): Promise<boolean> {
  try {
    return (await readAnswer(dir, item.id)) === undefined
  } catch {
    return true
  }
}

export function spoolOwnerQueue(dir: string): OwnerQueuePort {
  return {
    async open() {
      const { items } = await readSpool(dir)
      const open = await Promise.all(
        items.map(async item => ((await unanswered(dir, item)) ? item : undefined)),
      )
      return open.filter((item): item is OwnerItem => item !== undefined)
    },
    async deposit(deposit) {
      await writeDeposit(dir, deposit)
    },
  }
}
