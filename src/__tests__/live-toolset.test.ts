import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildLaunchPlan } from '../agents/launch-plan.js'
import { BUILTIN_PROFILES } from '../agents/profiles.js'
import { findTranscript } from '../agents/transcript.js'
import type { AgentProfile } from '../agents/types.js'

/**
 * Does a profile's toolset actually confine a REAL spawned agent?
 *
 * WHY THIS CANNOT BE A UNIT TEST, and the trap it exists to avoid: a snapshot
 * asserting `--disallowed-tools` appears in the argv would have passed on the
 * broken code too. The bug was never in the argv — it was in what the flag MEANS.
 * `--allowed-tools` grants permission and does not remove a tool, so an explorer
 * declaring only Read/Grep/Glob still ran `git log` off a `Bash(*)` sitting in the
 * user's settings.json. Only running `claude` for real can tell the two apart.
 *
 * AND WHY THE POSITIVE CONTROL IS NOT OPTIONAL. The confined arm passes trivially
 * on a machine whose settings never granted Bash in the first place — it would
 * report success while testing nothing. The control arm runs the identical plan
 * with the deny list removed; if Bash does not succeed there, this environment
 * cannot observe the regression and the suite says so rather than passing.
 *
 * AN AGENT'S OWN ACCOUNT OF ITS PERMISSIONS IS NOT EVIDENCE. The probe that found
 * this gap ran Bash successfully and then reported it had been blocked, believing
 * its brief over a tool_result in its own context. So this reads `tool_use` and
 * `tool_result` frames out of Claude Code's transcript and never the prose.
 *
 * Opt-in: needs a real `claude` on PATH and spawns actual sessions.
 *   AGENT_CHAT_LIVE=1 npx vitest run live-toolset
 */

const LIVE = process.env.AGENT_CHAT_LIVE === '1'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const explorer = BUILTIN_PROFILES.find(p => p.name === 'explorer') as AgentProfile

const MARKER = 'hello-from-bash'

/**
 * Neutral, and deliberately not explorer's own prelude: "do not attempt to change
 * anything" would have the model decline on its own judgement, and a refusal by
 * politeness proves nothing about whether the tool was there to call.
 */
const PROBE_PRELUDE = 'Answer with actions, not caveats. If a tool is available, call it.'

const BRIEF = `Run this exact shell command and report its output: echo ${MARKER}`

interface ProbeResult {
  /** A Bash tool_use frame that came back with is_error unset or false. */
  bashSucceeded: boolean
  /** Distinguishes "denied" from "claude never got off the ground". */
  transcript: string
  turns: number
}

/** Every `message.content` block in the transcript, whatever record type carried it. */
function* blocks(file: string): Generator<Record<string, unknown>> {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    let record: { message?: { content?: unknown } }
    try {
      record = JSON.parse(line)
    } catch {
      continue // a partially flushed final line is normal on a live tail
    }
    const content = record.message?.content
    if (Array.isArray(content))
      for (const block of content) if (block && typeof block === 'object') yield block
  }
}

function readProbe(file: string): Pick<ProbeResult, 'bashSucceeded' | 'turns'> {
  const bashCalls = new Set<string>()
  const succeeded = new Set<string>()
  let turns = 0

  for (const block of blocks(file)) {
    const kind = block.type
    if (kind === 'text') turns += 1
    if (kind === 'tool_use' && block.name === 'Bash') bashCalls.add(String(block.id))
    if (kind === 'tool_result' && block.is_error !== true) succeeded.add(String(block.tool_use_id))
  }

  return { bashSucceeded: [...bashCalls].some(id => succeeded.has(id)), turns }
}

async function probe(confined: boolean): Promise<ProbeResult> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-live-'))
  dirs.push(cwd)
  const mcpConfigPath = path.join(cwd, 'mcp.json')
  fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: {} }))

  const sessionId = crypto.randomUUID()
  const { disallowedTools: denied, ...unconfined } = explorer
  const profile: AgentProfile = {
    ...unconfined,
    promptPrelude: PROBE_PRELUDE,
    ...(confined && denied ? { disallowedTools: denied } : {}),
  }
  const plan = buildLaunchPlan({
    agentId: 'aglive01',
    sessionId,
    name: 'toolprobe',
    profile,
    brief: BRIEF,
    cwd,
    surface: 'headless',
    mcpConfigPath,
  })

  await new Promise<void>(resolve => {
    // Piped rather than the headless surface's `ignore`: this parent stays alive
    // to drain them, so the CC-24 hang does not apply and a failed launch leaves
    // a readable reason behind.
    const child = spawn(plan.bin, plan.args, { cwd: plan.cwd, env: { ...process.env, ...plan.env } })
    child.stdout.resume()
    child.stderr.resume()
    child.stdin.end(plan.stdin ?? '')
    child.on('close', () => resolve())
    child.on('error', () => resolve())
  })

  const found = findTranscript(cwd, sessionId)
  if (!found.exists) return { bashSucceeded: false, transcript: found.path, turns: 0 }
  return { ...readProbe(found.path), transcript: found.path }
}

describe.skipIf(!LIVE)('a live spawn, against a real claude', () => {
  it('runs Bash when nothing denies it — the control that proves this test can fail', async () => {
    const result = await probe(false)

    expect(result.turns, `agent never took a turn; transcript ${result.transcript}`).toBeGreaterThan(0)
    expect(
      result.bashSucceeded,
      'the control arm did not run Bash, so this environment grants no Bash to begin with and ' +
        'cannot observe the regression. Confirm the machine settings allow Bash before trusting a pass.',
    ).toBe(true)
  }, 240_000)

  it('cannot run Bash under the explorer profile, whatever the user settings allow', async () => {
    const result = await probe(true)

    expect(result.turns, `agent never took a turn; transcript ${result.transcript}`).toBeGreaterThan(0)
    expect(result.bashSucceeded, `a confined explorer ran Bash; transcript ${result.transcript}`).toBe(false)
  }, 240_000)
})
