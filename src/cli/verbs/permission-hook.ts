import { selfGrant } from '../../agents/skill-self-grant.js'
import { BrokerClient } from '../../client/broker-client.js'
import type { ClientMessage, PermissionBehavior, ServerMessage } from '../../protocol.js'

/**
 * `agent-chat permission-hook`: the PermissionRequest command hook a headless agent
 * runs (CC-144). It files the prompt in the human queue over an UNREGISTERED
 * connection, blocks until `agent-chat approve` answers, and prints the decision in
 * the shape Claude Code reads. A deadline with no answer (CC-154) prints an explicit
 * deny decision so the model sees why. Every other way of giving up still exits
 * non-zero with nothing on stdout, which `claude -p` treats as no decision and denies.
 */

type HookFrame = Extract<ClientMessage, { t: 'permission_hook' }>
type Outcome = { behavior: PermissionBehavior } | { gaveUp: string; deadline?: boolean }

/** The fields read from Claude Code's hook stdin. 2.1.280 sends no `tool_use_id`, so nothing keys on one. */
export interface HookInput {
  sessionId: string
  toolName: string
  toolInput: unknown
}

export function parseHookInput(raw: string): HookInput {
  const parsed = JSON.parse(raw) as Record<string, unknown>
  if (typeof parsed.tool_name !== 'string') throw new Error('hook input has no tool_name')
  return {
    sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : '',
    toolName: parsed.tool_name,
    toolInput: parsed.tool_input ?? {},
  }
}

/** The session the prompt is filed under: the spawn's agent-chat name, else the Claude session id. */
export function hookFrame(input: HookInput, env: NodeJS.ProcessEnv): HookFrame {
  const description = (input.toolInput as { description?: unknown } | null)?.description
  return {
    t: 'permission_hook',
    session: env.AGENT_CHAT_NAME || `claude-${input.sessionId.slice(0, 8)}`,
    toolName: input.toolName,
    toolInput: input.toolInput,
    ...(typeof description === 'string' ? { description } : {}),
  }
}

/** Exactly the stdout tp302 verified on Claude Code 2.1.280 for allow and owner-denied. */
export function hookOutput(behavior: PermissionBehavior, denyMessage?: string): string {
  const decision =
    behavior === 'allow'
      ? { behavior: 'allow' }
      : { behavior: 'deny', message: denyMessage ?? 'The owner denied this tool call in agent-chat.' }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } })
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** Files the prompt and resolves with the verdict, or with why it stopped waiting. */
export async function askHuman(frame: HookFrame, deadlineMs: number): Promise<Outcome> {
  let settle: (outcome: Outcome) => void = () => undefined
  const outcome = new Promise<Outcome>(resolve => (settle = resolve))
  let msgId: string | undefined
  let dropped = false
  const client = new BrokerClient(
    () => undefined,
    undefined,
    undefined,
    (requestId, behavior) => requestId === msgId && settle({ behavior }),
    () => {
      dropped = true
      settle({ gaveUp: 'lost the broker connection, so the broker has closed the prompt' })
    },
  )
  const timer = setTimeout(
    () => settle({ gaveUp: 'deadline reached with no answer', deadline: true }),
    deadlineMs,
  )
  const onSignal = (): void => settle({ gaveUp: 'terminated before an answer' })
  process.once('SIGTERM', onSignal).once('SIGINT', onSignal)
  try {
    await client.connect()
    const filed = (await client.request(frame, 'permission_hook_result')) as PermissionHookResult
    if (!filed.ok) return { gaveUp: `broker refused the prompt: ${filed.reason ?? 'no reason given'}` }
    msgId = filed.msgId
    const result = await outcome
    if ('gaveUp' in result && msgId && !dropped) await withdraw(client, msgId)
    return result
  } finally {
    clearTimeout(timer)
    process.off('SIGTERM', onSignal).off('SIGINT', onSignal)
    client.close()
  }
}

type PermissionHookResult = Extract<ServerMessage, { t: 'permission_hook_result' }>

/** Best effort: if this fails the socket closes anyway, and the broker withdraws on close. */
async function withdraw(client: BrokerClient, msgId: string): Promise<void> {
  await client
    .request({ t: 'permission_hook_withdrawn', msgId }, 'permission_hook_result')
    .catch(() => undefined)
}

const SELF_GRANT_RECORD_MS = 2000

/**
 * Best effort, capped at two seconds: the allow stands either way, since the
 * transcript keeps the tool call even when the event log misses the grant.
 */
export async function recordSelfGrant(
  input: HookInput,
  env: NodeJS.ProcessEnv,
  timeoutMs = SELF_GRANT_RECORD_MS,
): Promise<void> {
  const { session, toolName, toolInput } = hookFrame(input, env)
  const frame: ClientMessage = {
    t: 'permission_self_granted',
    session,
    toolName,
    toolInput,
    grant: 'repo-skills',
  }
  // Never autoStart: a record is not worth resurrecting a broker someone stopped.
  const client = new BrokerClient(() => undefined, undefined, undefined, undefined, undefined, {
    autoStart: false,
  })
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no broker answer in ${timeoutMs} ms`)), timeoutMs)
  })
  const send = async (): Promise<void> => {
    await client.connect()
    const result = (await client.request(frame, 'permission_hook_result')) as PermissionHookResult
    if (!result.ok) throw new Error(`broker refused the record: ${result.reason ?? 'no reason given'}`)
  }
  try {
    await Promise.race([send(), timeout])
  } catch (error) {
    console.error(`agent-chat permission-hook: self-grant not recorded: ${(error as Error).message}`)
  } finally {
    clearTimeout(timer)
    client.close()
  }
}

export async function permissionHook(options: { deadline: string; selfGrantSkills?: string }): Promise<void> {
  const deadlineMs = Number.parseInt(options.deadline, 10) * 1000
  if (!Number.isInteger(deadlineMs) || deadlineMs <= 0) throw new Error(`bad --deadline: ${options.deadline}`)
  const input = parseHookInput(await readStdin())
  const root = options.selfGrantSkills
  if (root !== undefined && selfGrant(root, input.toolName, input.toolInput)) {
    console.error(
      `agent-chat permission-hook: self-granted ${input.toolName} in ${root}/.claude/skills (CC-694)`,
    )
    await recordSelfGrant(input, process.env)
    process.stdout.write(hookOutput('allow'), () => process.exit(0))
    return
  }
  const outcome = await askHuman(hookFrame(input, process.env), deadlineMs)
  if ('behavior' in outcome) {
    // Exit from the write callback: stdout to a pipe is asynchronous on macOS.
    process.stdout.write(hookOutput(outcome.behavior), () => process.exit(0))
    return
  }
  console.error(`agent-chat permission-hook: ${outcome.gaveUp}; Claude Code will deny the call`)
  if (outcome.deadline) {
    const message = 'The owner did not answer in time (agent-chat permission-hook deadline).'
    process.stdout.write(hookOutput('deny', message), () => process.exit(0))
    return
  }
  process.exit(1)
}
