import { Worker } from 'node:worker_threads'
import { BrokerClient } from '../../client/broker-client.js'
import { decideWithin } from '../../leak-guard/failopen.js'
import type { Records } from '../../leak-guard/integrity/record.js'
import type { ClientMessage, ServerMessage } from '../../protocol.js'

/**
 * TP-4256 A3: the hook half of the run-time check of the files a later shell sources. The hook
 * reads its records and asks the broker that minted `--integrity <nonce>`. Nothing here allows on
 * failure: an unreachable broker, a timeout, a crash and an unknown nonce all deny.
 */

export const UNREACHABLE = 'leak-guard: integrity baseline unreachable'

/** Inside the 15 s Claude Code gives the hook, and past the client's 8.85 s reconnect ladder. */
export const INTEGRITY_DEADLINE_MS = 12_000

type CheckFrame = Extract<ClientMessage, { t: 'integrity_check' }>
type CheckResult = Extract<ServerMessage, { t: 'integrity_result' }>
export type AskBroker = (frame: CheckFrame) => Promise<CheckResult>
export type CollectRecords = (session: string, env: NodeJS.ProcessEnv) => Promise<Records>

/**
 * Off the main thread: the agent can fill shell-snapshots with names and sizes of its choosing, and a
 * synchronous walk would hold the deadline below off until Claude Code's own timeout ended the hook.
 * Unref'd, since the hook exits from its write callback and a stuck native read cannot be terminated.
 */
export const collectInWorker: CollectRecords = (session, env) =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../../leak-guard/integrity/records-worker.js', import.meta.url), {
      workerData: { session, env: { ...env } },
    })
    worker.unref()
    worker.once('message', resolve)
    worker.once('error', reject)
    worker.once('exit', code => reject(new Error(`records worker exited ${code}`)))
  })

const askBroker: AskBroker = async frame => {
  const client = new BrokerClient(() => undefined, undefined, undefined, undefined, undefined, {
    autoStart: false,
  })
  try {
    await client.connect()
    return (await client.request(frame, 'integrity_result')) as CheckResult
  } finally {
    client.close()
  }
}

function sessionOf(raw: string): string {
  try {
    const id = (JSON.parse(raw) as { session_id?: unknown }).session_id
    return typeof id === 'string' ? id : ''
  } catch {
    return ''
  }
}

const RESUME = 'Inspect it; `agent-chat agent resume` starts a new launch with a fresh baseline.'

/** The deny reason for a broker answer, or '' when every record matched. */
export function denialOf(result: CheckResult): string {
  if (result.ok) return ''
  if (result.file === undefined)
    return `leak-guard: integrity check refused: ${result.reason}. A broker restart forgets every baseline. ${RESUME}`
  return (
    `leak-guard: ${result.file} changed (${result.field}) since this launch's baseline, and a later shell ` +
    `sources it, so this launch is quarantined (${result.reason}). Nothing was restored. ${RESUME}`
  )
}

/** The deny reason for this hook call, or undefined to let it through. */
export async function integrityDenial(
  nonce: string,
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
  ask: AskBroker = askBroker,
  deadlineMs: number = INTEGRITY_DEADLINE_MS,
  collect: CollectRecords = collectInWorker,
): Promise<string | undefined> {
  const session = sessionOf(raw)
  const decide = async (): Promise<string> =>
    denialOf(await ask({ t: 'integrity_check', nonce, session, records: await collect(session, env) }))
  const deadline = { ms: deadlineMs, denial: () => UNREACHABLE }
  const out = await decideWithin(
    decide,
    deadline,
    () => undefined,
    () => UNREACHABLE,
  )
  return out === '' ? undefined : out
}
