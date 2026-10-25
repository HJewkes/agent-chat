import fs from 'node:fs'
import path from 'node:path'
import { GH_GROUPS } from '../gh-write/gh-groups.js'
import { AGENT_ID_ENV } from '../launch-identity.js'
import { callShape } from './call-shape.js'
import { GH_KEY_ROOT_ENV } from './install.js'
import { isKnownRead } from './read-shape.js'
import { GH_WRITE_TICKET_ENV, verifyTicket } from './ticket.js'
import { readGhWriteKey } from './write-key.js'

/**
 * CC-1644: the shim runs a gh command only when it is a known read, or carries a ticket that
 * `agent-chat gh-write` minted for this exact argv after its scan passed. The key root comes from
 * the literal the shim script bakes on its exec line, so env set by the agent cannot move it.
 */

export const REFUSED = 'gh-shim: refused (write)'

const FIX =
  'this gh command is not a known read and was not sent by gh-write, so it did not run. ' +
  'Post it with: agent-chat gh-write -- <args>. See docs/leak-guard.md.'

const WORD = /^[a-z][a-z-]{0,23}$/
const METHOD = /^[A-Z]{1,10}$/
const SEGMENT = /^[A-Za-z0-9_.{}-]{1,64}$/

function ticketHolds(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  ticket: string | undefined,
  now: number,
): boolean {
  const root = env[GH_KEY_ROOT_ENV]
  const agentId = env[AGENT_ID_ENV]
  if (ticket === undefined || root === undefined || agentId === undefined) return false
  const key = readGhWriteKey(root, agentId)
  return key !== null && verifyTicket(key, agentId, [...argv], ticket, now)
}

/** The command's group, verb or method and route template; any word that may be free text logs as `?`. */
export function refusalShape(argv: readonly string[]): string {
  const [group = '', verb = ''] = argv
  if (!GH_GROUPS.has(group)) return '?'
  const shape = callShape(argv)
  if (group !== 'api' || shape === undefined) return `${group} ${WORD.test(verb) ? verb : '?'}`
  const route = shape.route.split('/').map(part => (SEGMENT.test(part) ? part : '?'))
  return `api ${METHOD.test(shape.method) ? shape.method : '?'} ${route.join('/')}`
}

/** A name or a path's basename, when it cannot be free text; otherwise `?`. */
const NAME = /^[A-Za-z0-9_.+-]{1,64}$/
const safeName = (word: string | undefined): string =>
  word !== undefined && NAME.test(path.basename(word)) ? path.basename(word) : '?'

/** The calling process's argv from `/proc`; undefined where there is none (macOS), so the field is left out. */
export function procParentArgv(ppid: number = process.ppid): readonly string[] | undefined {
  try {
    return fs.readFileSync(`/proc/${ppid}/cmdline`, 'utf8').split('\0')
  } catch {
    return undefined
  }
}

/** Who ran the command: the agent's name and the basenames of the parent's first two argv words, never text. */
export function callerFields(env: NodeJS.ProcessEnv, parent: readonly string[] | undefined): string {
  const caller = `caller=${safeName(env.AGENT_CHAT_NAME)}`
  return parent === undefined ? caller : `${caller} parent=${safeName(parent[0])} ${safeName(parent[1])}`
}

function logLine(file: string, line: string): void {
  try {
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // The decision stands without its log line.
  }
}

/**
 * CC-1644 staged rollout: in `log` a call the gate would refuse still runs, and leaves a
 * `would-refuse` line naming its caller; `enforce` refuses it. A source constant, never env or a
 * file, so no agent can switch it: going to `enforce` is its own reviewed one-line change.
 */
export type GateMode = 'log' | 'enforce'
export const GATE_MODE: GateMode = 'log'

export const WOULD_REFUSE = 'gh-shim: would-refuse (write)'

export interface GateIo {
  env: NodeJS.ProcessEnv
  now: number
  logFile: string
  stderr: (text: string) => void
  mode: GateMode
  parentArgv: () => readonly string[] | undefined
}

/**
 * Takes the ticket out of the env, so neither the real gh nor anything it starts sees it, and gives
 * the refusal's exit code, or undefined when the command may run.
 */
export function gateWrite(argv: readonly string[], io: GateIo): number | undefined {
  const ticket = io.env[GH_WRITE_TICKET_ENV]
  delete io.env[GH_WRITE_TICKET_ENV]
  if (isKnownRead(argv) || ticketHolds(argv, io.env, ticket, io.now)) return undefined
  const fields = `${refusalShape(argv)} ${callerFields(io.env, io.parentArgv())}`
  if (io.mode === 'log') {
    logLine(io.logFile, `${WOULD_REFUSE}: ${fields}`)
    return undefined
  }
  logLine(io.logFile, `${REFUSED}: ${fields}`)
  io.stderr(`${REFUSED}: ${FIX}\n`)
  return 1
}
