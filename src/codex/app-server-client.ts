// Adapter for @titan-design/agent's codex-app-server (TP-3750); deleted when a release exporting it lands.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

/**
 * The slice of the S4a client `codex run` needs, with the package's names and
 * error classes, so the swap to the release is an import change. One addition:
 * `pid`, which the supervisor needs to find the spool of its own Codex.
 */

export type CodexUserInput = { type: 'text'; text: string }

export interface CodexAppServerOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  executablePath?: string | undefined
  /** Replaces `["app-server"]`, for `-c` overrides or a stand-in server. */
  args?: readonly string[]
}

export interface CodexThreadOptions {
  cwd?: string
  approvalPolicy?: string
}

export interface CodexTurnStartParams {
  threadId: string
  input: readonly CodexUserInput[]
}

export interface CodexTurnSteerParams extends CodexTurnStartParams {
  expectedTurnId: string
}

export interface CodexProcessExit {
  exitCode: number | null
  signal: NodeJS.Signals | null
}

export type CodexAppServerEvent =
  | { kind: 'turn_started'; threadId: string; turnId: string }
  | { kind: 'turn_completed'; threadId: string; turnId: string }
  | ({ kind: 'exit' } & CodexProcessExit)

export interface CodexAppServer {
  readonly pid: number | undefined
  readonly exited: Promise<CodexProcessExit>
  threadStart(options?: CodexThreadOptions): Promise<{ threadId: string }>
  threadResume(threadId: string, options?: CodexThreadOptions): Promise<{ threadId: string }>
  turnStart(params: CodexTurnStartParams): Promise<{ turnId: string }>
  /** Rejects with CodexSteerPreconditionError when no turn, or another turn, is active. */
  turnSteer(params: CodexTurnSteerParams): Promise<{ turnId: string }>
  onEvent(listener: (event: CodexAppServerEvent) => void): () => void
  close(signal?: NodeJS.Signals): Promise<CodexProcessExit>
}

export class CodexAppServerRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
  ) {
    super(`${method}: ${message} (${code})`)
    this.name = 'CodexAppServerRpcError'
  }
}

/** The turn ended, or a different one is active, before the steer arrived; fall back to turnStart. */
export class CodexSteerPreconditionError extends CodexAppServerRpcError {
  override name = 'CodexSteerPreconditionError'
}

export class CodexAppServerExitedError extends Error {
  constructor(readonly method: string) {
    super(`${method}: codex app-server exited`)
    this.name = 'CodexAppServerExitedError'
  }
}

const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
// Observed from codex-cli 0.162.1: "no active turn to steer" and "expected active turn id `…` …".
const STEER_PRECONDITION = /^(no active turn to steer|expected active turn id)/

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const field = (value: unknown, key: string): Json =>
  isRecord(value) && isRecord(value[key]) ? value[key] : {}

function text(value: Json, key: string, method: string): string {
  const found = value[key]
  if (typeof found !== 'string') throw new CodexAppServerRpcError(method, 0, `result has no string ${key}`)
  return found
}

function parse(line: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(line)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function rpcError(method: string, error: unknown): CodexAppServerRpcError {
  const fields = isRecord(error) ? error : {}
  const code = typeof fields.code === 'number' ? fields.code : 0
  const message = typeof fields.message === 'string' ? fields.message : 'unknown error'
  const precondition = method === 'turn/steer' && code === INVALID_REQUEST && STEER_PRECONDITION.test(message)
  return new (precondition ? CodexSteerPreconditionError : CodexAppServerRpcError)(method, code, message)
}

function eventOf(method: string, params: unknown): CodexAppServerEvent | undefined {
  const threadId = isRecord(params) ? params.threadId : undefined
  const turnId = field(params, 'turn').id
  if (typeof threadId !== 'string' || typeof turnId !== 'string') return undefined
  if (method === 'turn/started') return { kind: 'turn_started', threadId, turnId }
  if (method === 'turn/completed') return { kind: 'turn_completed', threadId, turnId }
  return undefined
}

class AppServerClient {
  private nextId = 1
  private readonly pending = new Map<
    number,
    { method: string; resolve(v: unknown): void; reject(e: Error): void }
  >()
  private readonly listeners = new Set<(event: CodexAppServerEvent) => void>()
  private done = false
  readonly exited: Promise<CodexProcessExit>

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdin.on('error', () => undefined)
    child.stderr.pipe(process.stderr)
    createInterface({ input: child.stdout }).on('line', line => this.receive(line))
    this.exited = new Promise(resolve => {
      child.once('error', () => undefined)
      child.once('close', (exitCode, signal) => resolve(this.settle({ exitCode, signal })))
    })
  }

  surface(): CodexAppServer {
    const thread = async (method: string, params: Json) => ({
      threadId: text(field(await this.request(method, params), 'thread'), 'id', method),
    })
    return {
      pid: this.child.pid,
      exited: this.exited,
      threadStart: options => thread('thread/start', { ...options }),
      threadResume: (threadId, options) => thread('thread/resume', { ...options, threadId }),
      turnStart: async params => ({
        turnId: text(field(await this.request('turn/start', params), 'turn'), 'id', 'turn/start'),
      }),
      turnSteer: async params => {
        const result = await this.request('turn/steer', params)
        return { turnId: text(isRecord(result) ? result : {}, 'turnId', 'turn/steer') }
      },
      onEvent: listener => {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
      close: signal => {
        if (!this.done) this.child.kill(signal ?? 'SIGTERM')
        return this.exited
      },
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.done) return Promise.reject(new CodexAppServerExitedError(method))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject })
      this.write({ id, method, params })
    })
  }

  write(message: Json): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }

  private receive(line: string): void {
    const message = parse(line)
    if (!message) return
    if (typeof message.method === 'string') {
      // Approval and elicitation requests: decline so Codex never waits on us.
      if (typeof message.id === 'string' || typeof message.id === 'number') {
        this.write({
          id: message.id,
          error: { code: METHOD_NOT_FOUND, message: `${message.method} is not handled` },
        })
        return
      }
      const event = eventOf(message.method, message.params)
      if (event) this.emit(event)
      return
    }
    const call = typeof message.id === 'number' ? this.pending.get(message.id) : undefined
    if (!call) return
    this.pending.delete(message.id as number)
    if (message.error !== undefined) call.reject(rpcError(call.method, message.error))
    else call.resolve(message.result)
  }

  private emit(event: CodexAppServerEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }

  private settle(exit: CodexProcessExit): CodexProcessExit {
    this.done = true
    for (const call of this.pending.values()) call.reject(new CodexAppServerExitedError(call.method))
    this.pending.clear()
    this.emit({ kind: 'exit', ...exit })
    return exit
  }
}

export async function startCodexAppServer(options: CodexAppServerOptions): Promise<CodexAppServer> {
  const child = spawn(options.executablePath ?? 'codex', options.args ?? ['app-server'], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const client = new AppServerClient(child)
  try {
    await client.request('initialize', { clientInfo: { name: 'agent-chat', version: '0' } })
    client.write({ method: 'initialized' })
    return client.surface()
  } catch (error) {
    child.kill('SIGKILL')
    throw error
  }
}
