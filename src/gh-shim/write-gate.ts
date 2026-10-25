import fs from 'node:fs'
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

function logRefusal(file: string, argv: readonly string[]): void {
  try {
    fs.appendFileSync(file, `${new Date().toISOString()} ${REFUSED}: ${refusalShape(argv)}\n`)
  } catch {
    // The refusal stands without its log line.
  }
}

export interface GateIo {
  env: NodeJS.ProcessEnv
  now: number
  logFile: string
  stderr: (text: string) => void
}

/**
 * Takes the ticket out of the env, so neither the real gh nor anything it starts sees it, and gives
 * the refusal's exit code, or undefined when the command may run.
 */
export function gateWrite(argv: readonly string[], io: GateIo): number | undefined {
  const ticket = io.env[GH_WRITE_TICKET_ENV]
  delete io.env[GH_WRITE_TICKET_ENV]
  if (isKnownRead(argv) || ticketHolds(argv, io.env, ticket, io.now)) return undefined
  logRefusal(io.logFile, argv)
  io.stderr(`${REFUSED}: ${FIX}\n`)
  return 1
}
