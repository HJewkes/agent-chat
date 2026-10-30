#!/usr/bin/env node
// CC-1525 (S6, PG-15): proves against the real `codex` binary that a peer message wakes or
// steers a supervised thread. A mock Responses server stands in for the model, and a scratch
// HOME, CODEX_HOME and AGENT_CHAT_HOME keep the live broker out of it. Run after `npm run build`:
//   AGENT_CHAT_LIVE=1 node scripts/codex-listen-live.mjs
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

if (process.env.AGENT_CHAT_LIVE !== '1') {
  console.log('skipped: set AGENT_CHAT_LIVE=1 to run the live Codex probe')
  process.exit(0)
}

const nonce = randomBytes(4).toString('hex')
const scratch = `/tmp/cx-probe-${nonce}`
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const children = new Set()
const results = []

function check(name, pass, evidence) {
  results.push(pass)
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`)
  for (const line of evidence) console.log(`  ${line}`)
}

async function until(probe, ms, what) {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`)
    await sleep(100)
  }
}

const freePort = () =>
  new Promise(resolve => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })

function scrubbedEnv(port) {
  const live = /^(AGENT_CHAT_|CLAUDE|CODEX_)/
  const kept = Object.entries(process.env).filter(([key]) => !live.test(key))
  return {
    ...Object.fromEntries(kept),
    HOME: scratch,
    AGENT_CHAT_HOME: path.join(scratch, 'b'),
    AGENT_CHAT_PORT: String(port),
    AGENT_CHAT_EXIT_WITH_PID: String(process.pid),
  }
}

function startChild(args, env, cwd = scratch) {
  const child = spawn(process.execPath, [cli, ...args], { env, cwd, detached: true, stdio: 'pipe' })
  child.stderrText = ''
  child.stderr.on('data', chunk => (child.stderrText += chunk))
  child.closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  children.add(child)
  return child
}

const sse = (type, fields) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
const toolCall = cmd => ({
  type: 'function_call',
  call_id: `call-${randomBytes(3).toString('hex')}`,
  name: 'exec_command',
  arguments: JSON.stringify({ cmd, yield_time_ms: 30_000 }),
})
const finalMessage = {
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text: 'mock final' }],
}

/** Answers each model request from `replies`, then with a final message, and logs every body. */
function startMock(port) {
  const mock = { requests: [], replies: [] }
  mock.server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      if (!req.url.endsWith('/responses')) return res.end('{"models":[]}')
      mock.requests.push({ at: Date.now(), body: JSON.parse(body) })
      const id = `resp-${mock.requests.length}`
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sse('response.created', { response: { id } }))
      res.write(sse('response.output_item.done', { item: mock.replies.shift() ?? finalMessage }))
      res.end(sse('response.completed', { response: { id, usage } }))
    })
  })
  return new Promise(resolve => mock.server.listen(port, '127.0.0.1', () => resolve(mock)))
}

const itemsWith = (request, marker) =>
  request.body.input.filter(item => JSON.stringify(item).includes(marker))
const requestsWith = (mock, marker) => mock.requests.filter(r => itemsWith(r, marker).length > 0)
const countIn = (request, marker) => JSON.stringify(request.body.input).split(marker).length - 1

/** A real MCP server speaking stdio, so every message goes out through `chat_send`. */
async function startPeer(env) {
  const child = startChild(['mcp'], { ...env, CLAUDE_CODE_SESSION_ID: 'cc1525-peer-session' })
  const waiting = new Map()
  let buffer = ''
  child.stdout.on('data', chunk => {
    buffer += chunk
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, at))
      buffer = buffer.slice(at + 1)
      waiting.get(message.id)?.(message)
    }
  })
  let nextId = 1
  const rpc = (method, params) =>
    new Promise(resolve => {
      const id = nextId++
      waiting.set(id, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'cx-peer', version: '0' },
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  const call = async (name, args) => {
    const reply = await rpc('tools/call', { name, arguments: args })
    return JSON.stringify(reply.result ?? reply.error)
  }
  await call('chat_register', { name: 'cx-peer', status: 'CC-1525 probe peer' })
  /** Retries until `to` has registered, and returns when the accepted send began. */
  const send = (to, text) =>
    until(
      async () => {
        const at = Date.now()
        const reply = await call('chat_send', { to, text })
        if (reply.includes('Error:')) throw new Error(reply)
        return reply.includes('no active session') ? undefined : at
      },
      20_000,
      `${to} on the bus`,
    )
  return { send }
}

const processTable = () =>
  execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm=,args='], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [, pid, ppid, comm, args] = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
      return { pid: Number(pid), ppid: Number(ppid), comm, args }
    })

/** supervisor -> npm wrapper -> native codex -> MCP server, read from the real process table. */
function codexChain(supervisorPid) {
  const table = processTable()
  const wrapper = table.find(p => p.ppid === supervisorPid)
  const native = wrapper && table.find(p => p.ppid === wrapper.pid)
  const mcp = native && table.find(p => p.ppid === native.pid && p.args.includes(' mcp'))
  return { wrapper, native, mcp }
}

function rolloutLines(codexHome) {
  const sessions = path.join(codexHome, 'sessions')
  if (!fs.existsSync(sessions)) return []
  return fs
    .readdirSync(sessions, { recursive: true })
    .filter(name => String(name).endsWith('.jsonl'))
    .flatMap(name => fs.readFileSync(path.join(sessions, String(name)), 'utf8').split('\n'))
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

const eventsOf = (lines, type) => lines.filter(l => l.type === 'event_msg' && l.payload?.type === type)
const userEventsWith = (lines, marker) =>
  eventsOf(lines, 'item_completed').filter(
    l => l.payload.item?.type === 'UserMessage' && JSON.stringify(l.payload).includes(marker),
  )

const hookToml = phases =>
  phases
    .map(
      ([event, phase]) => `[[hooks.${event}]]
[[hooks.${event}.hooks]]
type = "command"
command = ${JSON.stringify(`${process.execPath} ${cli} inbox-hook --host codex ${phase}`)}
timeout = 10
`,
    )
    .join('\n')

function writeCodexHome(name, mockPort, hooks) {
  const codexHome = path.join(scratch, name)
  fs.mkdirSync(codexHome, { recursive: true })
  const base = `model = "mock-model"
model_provider = "mock"
sandbox_mode = "workspace-write"
check_for_update_on_startup = false

[model_providers.mock]
name = "mock"
base_url = "http://127.0.0.1:${mockPort}/v1"
wire_api = "responses"

`
  const hookPhases = [
    ['PostToolUse', 'post'],
    ['UserPromptSubmit', 'prompt'],
    ['Stop', 'stop'],
  ]
  fs.writeFileSync(path.join(codexHome, 'config.toml'), base + (hooks ? hookToml(hookPhases) : ''))
  return codexHome
}

/**
 * `--dangerously-bypass-hook-trust` does not reach `app-server`, so write the scratch home the
 * state an owner's approval would: each hook's key and hash, as `hooks/list` reports them.
 */
async function trustHooks(codexHome, work, env) {
  const server = spawn('codex', ['app-server'], { env: { ...env, CODEX_HOME: codexHome }, cwd: work })
  const listed = new Promise(resolve => {
    createInterface({ input: server.stdout }).on('line', line => {
      const message = JSON.parse(line)
      if (message.id === 2) resolve(message.result.data.flatMap(entry => entry.hooks))
    })
  })
  const write = message => server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  write({ id: 1, method: 'initialize', params: { clientInfo: { name: 'cx-probe', version: '0' } } })
  write({ method: 'initialized' })
  write({ id: 2, method: 'hooks/list', params: { cwds: [work] } })
  const hooks = await listed
  server.kill('SIGKILL')
  const state = hooks.map(
    hook =>
      `\n[hooks.state.${JSON.stringify(hook.key)}]\ntrusted_hash = ${JSON.stringify(hook.currentHash)}\n`,
  )
  fs.appendFileSync(path.join(codexHome, 'config.toml'), state.join(''))
}

async function startSupervisor(name, env, mockPort, hooks = false) {
  const codexHome = writeCodexHome(name, mockPort, hooks)
  const work = path.join(scratch, 'work')
  fs.mkdirSync(work, { recursive: true })
  if (hooks) await trustHooks(codexHome, work, env)
  const child = startChild(['codex', 'run', '--name', name], { ...env, CODEX_HOME: codexHome }, work)
  return { name, child, codexHome }
}

const spoolRoot = env => path.join(env.AGENT_CHAT_HOME, 'codex-hosts')
const spoolListing = (env, pid) => {
  const dir = path.join(spoolRoot(env), String(pid))
  return fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String) : ['(host dir is gone)']
}

async function idleWakeAndSpoolKey(mock, peer, env) {
  const run = await startSupervisor('cx-probe', env, mock.port)
  const marker = `CXWAKE-${nonce}`
  const sentAt = await peer.send(run.name, `${marker} from the probe peer`)
  const reached = await until(() => requestsWith(mock, marker)[0], 20_000, 'the wake marker').catch(
    () => null,
  )
  const elapsed = reached ? reached.at - sentAt : Infinity
  const items = reached ? itemsWith(reached, marker) : []
  const headed = items.some(i => i.role === 'user' && JSON.stringify(i).includes('agent-chat messages'))
  const rollout = await until(
    () => {
      const hits = userEventsWith(rolloutLines(run.codexHome), marker)
      return hits.length > 0 ? hits : undefined
    },
    5_000,
    'the rollout userMessage',
  ).catch(() => [])
  check('idle wake', elapsed <= 10_000 && headed && rollout.length > 0, [
    `marker reached the mock ${elapsed} ms after the chat_send call`,
    `input item role=${items[0]?.role} underPeerHeader=${headed}`,
    `rollout UserMessage rows with marker: ${rollout.length}`,
  ])

  const { wrapper, native, mcp } = codexChain(run.child.pid)
  const hosts = fs.existsSync(spoolRoot(env)) ? fs.readdirSync(spoolRoot(env)) : []
  const keyed = native !== undefined && hosts.includes(String(native.pid))
  const viaWrapper = wrapper?.comm !== 'codex' && wrapper?.args.startsWith('node ')
  check('spool key under the npm wrapper', keyed && viaWrapper === true && reached !== null, [
    `supervisor ${run.child.pid} -> wrapper ${wrapper?.pid} (${wrapper?.comm}) -> native ${native?.pid} (${native?.comm}) -> mcp ${mcp?.pid}`,
    `wrapper args: ${wrapper?.args
      .split(' ')
      .slice(0, 3)
      .map(word => path.basename(word))
      .join(' ')}`,
    `codex-hosts entries: ${hosts.join(',')}`,
    `supervisor drained that spool: ${reached !== null}`,
  ])
  return run
}

async function midTurnSteer(mock, peer, run) {
  const marker = `CXSTEER-${nonce}`
  const before = eventsOf(rolloutLines(run.codexHome), 'task_started').length
  const startRequest = mock.requests.length
  mock.replies.push(toolCall('sleep 20'))
  await peer.send(run.name, `CXSTART-${nonce} start the sleep`)
  await until(() => mock.requests.length > startRequest, 15_000, 'the turn holding the sleep')
  await sleep(3_000)
  await peer.send(run.name, `${marker} steered mid-sleep`)
  const carrying = await until(() => requestsWith(mock, marker)[0], 30_000, 'the steer').catch(() => null)
  await sleep(2_000)
  const index = carrying ? mock.requests.indexOf(carrying) : -1
  const nextAfterTool = index === startRequest + 1
  const output = carrying?.body.input.findLast(item => item.type === 'function_call_output')
  const text = String(output?.output ?? '')
  const heldMs = carrying ? carrying.at - mock.requests[startRequest].at : 0
  const lines = rolloutLines(run.codexHome)
  const turns = eventsOf(lines, 'task_started').length - before
  const aborted = eventsOf(lines, 'turn_aborted').length
  const clean = text.includes('Process exited with code 0') && heldMs >= 19_000
  check('mid-turn steer', nextAfterTool && clean && turns === 1 && aborted === 0, [
    `marker first in request ${index + 1}, tool-call request was ${startRequest + 1}`,
    `tool output: ${text.replace(/\s+/g, ' ').slice(0, 100)}`,
    `request gap ${heldMs} ms for sleep 20; turns started ${turns}; turn_aborted rows ${aborted}`,
  ])
}

async function noDuplicate(mock, peer, env) {
  const run = await startSupervisor('cx-probe-hooks', env, mock.port, true)
  const marker = `CXDUP-${nonce}`
  const startRequest = mock.requests.length
  mock.replies.push(toolCall('sleep 5'), toolCall('sleep 4'))
  await peer.send(run.name, `CXSTART2-${nonce} start the sleep`)
  await until(() => mock.requests.length > startRequest, 15_000, 'the hooked turn')
  // A stopped supervisor leaves the record in the spool, which is the only way the hook sees one.
  process.kill(run.child.pid, 'SIGSTOP')
  await peer.send(run.name, `${marker} the only copy`)
  const noticed = await until(
    () => mock.requests[startRequest + 1],
    15_000,
    'the request after the first tool',
  ).catch(() => null)
  process.kill(run.child.pid, 'SIGCONT')
  const carrying = await until(() => requestsWith(mock, marker)[0], 20_000, 'the steer').catch(() => null)
  await sleep(6_000)
  const last = mock.requests.at(-1)
  const notices = (noticed?.body.input ?? []).filter(
    item =>
      item.role === 'developer' &&
      /chat_inbox/.test(JSON.stringify(item)) &&
      /waiting/.test(JSON.stringify(item)),
  )
  const roles = itemsWith(last, marker).map(item => item.role ?? item.type)
  const once = countIn(last, marker) === 1 && roles.join() === 'user'
  const bodyInNotice = notices.some(item => JSON.stringify(item).includes(marker))
  check(
    'no duplicate with the S3 hooks on',
    once && notices.length > 0 && !bodyInNotice && carrying !== null,
    [
      `marker count in the final model input: ${countIn(last, marker)}, roles: ${roles.join()}`,
      `developer notices in the request after the tool: ${notices.length}`,
      `notice text: ${JSON.stringify(notices[0]?.content?.[0]?.text ?? null)?.slice(0, 160)}`,
      `notice carries the body: ${bodyInNotice}`,
    ],
  )
  return run
}

async function failurePath(mock, peer, env) {
  const run = await startSupervisor('cx-probe-fail', env, mock.port)
  const marker = `CXFAIL-${nonce}`
  await peer.send(run.name, `CXSPOOL-${nonce} make the spool dir`)
  const native = await until(() => codexChain(run.child.pid).native, 10_000, 'the native codex')
  await sleep(3_000)
  // Stopped, the app-server cannot answer, so the delivery below is in flight when it dies.
  process.kill(native.pid, 'SIGSTOP')
  await peer.send(run.name, `${marker} waits in the spool`)
  await sleep(7_000)
  const before = spoolListing(env, native.pid)
  process.kill(native.pid, 'SIGKILL')
  const exit = await Promise.race([run.child.closed, sleep(20_000).then(() => 'still running')])
  await sleep(1_000)
  const after = spoolListing(env, native.pid)
  const kept = after.some(name => name.endsWith('.json'))
  const nonZero = exit !== 'still running' && exit.code !== 0
  check('failure path', kept && nonZero, [
    `spool before the kill: ${before.join(' ')}`,
    `spool after the kill: ${after.join(' ')}`,
    `supervisor exit: ${JSON.stringify(exit)}`,
    `supervisor stderr: ${run.child.stderrText.trim().split('\n').at(-1)?.slice(0, 140)}`,
  ])
}

function signal(pid, name) {
  try {
    process.kill(pid, name)
  } catch {
    // Already gone.
  }
}

async function stopRun(run) {
  run.child.kill('SIGTERM')
  await run.child.closed
}

async function main() {
  fs.mkdirSync(scratch, { recursive: true })
  const [mockPort, brokerPort] = await Promise.all([freePort(), freePort()])
  const env = scrubbedEnv(brokerPort)
  const mock = await startMock(mockPort)
  mock.port = mockPort
  try {
    const peer = await startPeer(env)
    const run = await idleWakeAndSpoolKey(mock, peer, env)
    await midTurnSteer(mock, peer, run)
    await stopRun(run)
    await stopRun(await noDuplicate(mock, peer, env))
    await failurePath(mock, peer, env)
  } finally {
    mock.server.closeAllConnections()
    mock.server.close()
    for (const child of children) signal(-child.pid, 'SIGKILL')
    const brokerPidFile = path.join(env.AGENT_CHAT_HOME, 'broker.pid')
    if (fs.existsSync(brokerPidFile)) signal(Number(fs.readFileSync(brokerPidFile, 'utf8')), 'SIGTERM')
    await sleep(500)
    fs.rmSync(scratch, { recursive: true, force: true })
  }
  console.log(`${results.filter(Boolean).length}/${results.length} assertions passed`)
  process.exitCode = results.every(Boolean) && results.length === 5 ? 0 : 1
}

await main()
