#!/usr/bin/env node
// The S4a stand-in for `codex app-server` (titan-platform packages/agent/src/fixtures), stdio JSON-RPC.
// Flags:
//   --steers-to-complete <n>  a started turn stays active until it has taken n steers (default 0)
//   --exit-on <method>        exit without answering when this request arrives
//   --exit-code <n>           code for --exit-on (default 3)
//   --fail-on <method>        answer this request with an internal error (-32603)
//   --log <path>              append every received line there
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const flags = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (!arg.startsWith('--')) return pairs
    const next = all[i + 1]
    return [...pairs, [arg.slice(2), next === undefined || next.startsWith('--') ? 'true' : next]]
  }, []),
)
const steersToComplete = Number(flags['steers-to-complete'] ?? 0)
const threadId = '01a15a00-0000-7000-8000-000000000001'
let turnCount = 0
let activeTurn
let steers = 0

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)
const notify = (method, params) => send({ method, params })
const reply = (id, result) => send({ id, result })
const fail = (id, message) => send({ id, error: { code: -32600, message } })

function completeTurn() {
  const id = activeTurn
  activeTurn = undefined
  steers = 0
  notify('turn/completed', { threadId, turn: { id, status: 'completed', items: [] } })
}

const handlers = {
  initialize: id =>
    reply(id, {
      userAgent: 'fake/0.162.1',
      codexHome: '/fake/home',
      platformFamily: 'unix',
      platformOs: 'linux',
    }),
  'thread/start': id => reply(id, { thread: { id: threadId }, model: 'fake-model', cwd: '/fake/cwd' }),
  'thread/resume': (id, params) =>
    reply(id, { thread: { id: params.threadId }, model: 'fake-model', cwd: '/fake/cwd' }),
  'turn/start': id => {
    activeTurn = `turn-${++turnCount}`
    reply(id, { turn: { id: activeTurn, status: 'inProgress', items: [] } })
    notify('turn/started', { threadId, turn: { id: activeTurn, status: 'inProgress', items: [] } })
    if (steersToComplete === 0) completeTurn()
  },
  'turn/steer': (id, params) => {
    if (!activeTurn) return fail(id, 'no active turn to steer')
    if (params.expectedTurnId !== activeTurn)
      return fail(id, `expected active turn id \`${params.expectedTurnId}\` but found \`${activeTurn}\``)
    reply(id, { turnId: activeTurn })
    if (++steers >= steersToComplete) completeTurn()
  },
}

createInterface({ input: process.stdin }).on('line', line => {
  if (flags.log) appendFileSync(flags.log, `${line}\n`)
  const message = JSON.parse(line)
  if (message.method === undefined || message.id === undefined) return
  if (message.method === flags['exit-on']) process.exit(Number(flags['exit-code'] ?? 3))
  if (message.method === flags['fail-on'])
    return send({ id: message.id, error: { code: -32603, message: 'internal error' } })
  const handler = handlers[message.method]
  if (handler) handler(message.id, message.params ?? {})
  else send({ id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } })
})
