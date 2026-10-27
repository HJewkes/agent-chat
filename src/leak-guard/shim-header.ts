import fs from 'node:fs'
import path from 'node:path'

/** Starts the second line of every script agent-chat puts on an agent's PATH. */
export const SHIM_HEADER = '# Written by agent-chat'

/** The names agent-chat shims on PATH. */
const SHIM_NAMES = ['git', 'gh'] as const

const HEAD_BYTES = 512

/**
 * CC-1653: true when `file`, through any symlink, is a script agent-chat wrote. Keyed on content, not
 * on where the file sits, so a shim under a relocated home, a mirror link or a test fixture counts too.
 * sh must read a script to run it, so a file this cannot read is not a shim.
 */
export function isAgentChatShim(file: string): boolean {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    const head = Buffer.alloc(HEAD_BYTES)
    const text = head.subarray(0, fs.readSync(fd, head, 0, HEAD_BYTES, 0)).toString('latin1')
    return text.startsWith('#!') && text.split('\n').some(line => line.startsWith(SHIM_HEADER))
  } catch {
    return false
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** A PATH entry holding an agent-chat `git` or `gh` shim. */
export const holdsAgentChatShim = (dir: string): boolean =>
  SHIM_NAMES.some(name => isAgentChatShim(path.join(dir, name)))
