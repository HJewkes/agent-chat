import { execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { findTranscript } from '../agents/transcript.js'

/**
 * Which mechanism lets a headless `claude -p` write `<worktree>/.claude/skills/**` (CC-694)?
 *
 * Claude Code guards `.claude/{skills,agents,commands}` with a safety check that runs after
 * the ordinary allow rules, so `--allowed-tools Write` alone still asks. In `-p` that ask
 * goes to the PermissionRequest hook, which for a spawned agent is `agent-chat
 * permission-hook` waiting on the owner (TD-461, event rows 63747 and 64185). The plan read
 * from 2.1.296 source that the owner-approved rule `Edit(./.claude/skills/**)` does not
 * clear that check, and that a hook `allow` does. This suite observes both instead.
 *
 * Three arms, each in a fresh linked worktree, each asked to Write one SKILL.md:
 * - control: `--allowed-tools Write,Edit`, no hook. Must be refused, or this machine
 *   cannot observe the gate and the suite says so rather than passing.
 * - literal rule: the control plus `Edit(./.claude/skills/**)`. Its outcome is the gate
 *   for CC-694 slices b to e, so it is asserted as observed and recorded in
 *   docs/permission-relay.md. A change here after a Claude Code bump is the signal.
 * - hook allow: the control plus a `--settings` PermissionRequest hook that prints allow.
 *
 * User settings are excluded with `--setting-sources project,local`, as a spawn's are, so
 * the account's own allow rules and hooks cannot decide any arm.
 *
 * Reads `tool_result` frames and the file on disk, never the model's prose.
 *
 * Opt-in: needs a real `claude` on PATH and spawns actual sessions.
 *   AGENT_CHAT_LIVE=1 npx vitest run live-skill-write
 */

const LIVE = process.env.AGENT_CHAT_LIVE === '1'

const REPO_SKILLS_RULE = 'Edit(./.claude/skills/**)'
const GATE_MESSAGE = "haven't granted it yet"
const ALLOW_OUTPUT = JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
})

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

type Arm = 'control' | 'literal-rule' | 'hook-allow'

interface ProbeResult {
  landed: boolean
  writeErrors: string[]
  hookFired: boolean
  turns: number
  transcript: string
}

/** A main checkout with one commit and a linked worktree cut from it; returns the worktree. */
function linkedWorktree(): string {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-skill-')))
  dirs.push(base)
  const main = path.join(base, 'main')
  const tree = path.join(base, 'tree')
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' })
  fs.mkdirSync(main)
  git(main, 'init', '-q')
  fs.writeFileSync(path.join(main, 'README.md'), 'probe\n')
  git(main, 'add', '.')
  git(main, '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', 'commit', '-qm', 'init')
  git(main, 'worktree', 'add', '-q', '-b', 'probe', tree)
  return tree
}

function hookSettings(dir: string, firedLog: string): string {
  const script = path.join(dir, 'allow-hook.sh')
  fs.writeFileSync(script, `#!/bin/sh\ncat >> '${firedLog}'\nprintf '%s' '${ALLOW_OUTPUT}'\n`, {
    mode: 0o755,
  })
  const settings = path.join(dir, 'settings.json')
  const hook = { type: 'command', command: script, timeout: 30 }
  fs.writeFileSync(
    settings,
    JSON.stringify({ hooks: { PermissionRequest: [{ matcher: '', hooks: [hook] }] } }),
  )
  return settings
}

function argsFor(arm: Arm, sessionId: string, scratch: string, firedLog: string, brief: string): string[] {
  const allowed = ['Write', 'Edit', ...(arm === 'literal-rule' ? [REPO_SKILLS_RULE] : [])]
  const mcpConfig = path.join(scratch, 'mcp.json')
  fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: {} }))
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'default',
    '--setting-sources',
    'project,local',
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfig,
    '--model',
    'sonnet',
    '--session-id',
    sessionId,
    '--allowed-tools',
    allowed.join(','),
    ...(arm === 'hook-allow' ? ['--settings', hookSettings(scratch, firedLog)] : []),
    '--',
    brief,
  ]
}

function* blocks(file: string): Generator<Record<string, unknown>> {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    let record: { message?: { content?: unknown } }
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const content = record.message?.content
    if (Array.isArray(content))
      for (const block of content) if (block && typeof block === 'object') yield block
  }
}

function writeErrors(file: string): { errors: string[]; turns: number } {
  const writes = new Set<string>()
  const errors: string[] = []
  let turns = 0
  for (const block of blocks(file)) {
    if (block.type === 'text') turns += 1
    if (block.type === 'tool_use' && (block.name === 'Write' || block.name === 'Edit'))
      writes.add(String(block.id))
    if (block.type === 'tool_result' && block.is_error === true && writes.has(String(block.tool_use_id)))
      errors.push(JSON.stringify(block.content))
  }
  return { errors, turns }
}

async function probe(arm: Arm): Promise<ProbeResult> {
  const tree = linkedWorktree()
  const scratch = path.dirname(tree)
  const firedLog = path.join(scratch, 'hook-fired.log')
  const target = path.join(tree, '.claude', 'skills', 'probe', 'SKILL.md')
  const brief =
    `Use the Write tool to create the file ${target} with the content "# probe". ` +
    'Call Write exactly once and do not retry. Do not use Bash.'
  const sessionId = crypto.randomUUID()

  await new Promise<void>(resolve => {
    const child = spawn('claude', argsFor(arm, sessionId, scratch, firedLog, brief), { cwd: tree })
    child.stdout.resume()
    child.stderr.resume()
    child.stdin.end()
    child.on('close', () => resolve())
    child.on('error', () => resolve())
  })

  const found = findTranscript(tree, sessionId)
  const { errors, turns } = found.exists ? writeErrors(found.path) : { errors: [], turns: 0 }
  return {
    landed: fs.existsSync(target),
    writeErrors: errors,
    hookFired: fs.existsSync(firedLog),
    turns,
    transcript: found.path,
  }
}

describe.skipIf(!LIVE)('a headless Write to <worktree>/.claude/skills, against a real claude', () => {
  it('is refused under --allowed-tools Write alone — the control that proves the gate is observable', async () => {
    const result = await probe('control')

    expect(result.turns, `agent never took a turn; transcript ${result.transcript}`).toBeGreaterThan(0)
    expect(result.landed, 'environment cannot observe the gate: the control arm wrote the skill').toBe(false)
    expect(result.writeErrors.join('\n')).toContain(GATE_MESSAGE)
  }, 240_000)

  it('is still refused with the approved Edit(./.claude/skills/**) rule (observed on 2.1.296)', async () => {
    const result = await probe('literal-rule')

    expect(result.turns, `agent never took a turn; transcript ${result.transcript}`).toBeGreaterThan(0)
    expect(
      result.landed,
      `the literal rule now clears the gate; CC-694 b-e are moot. ${result.transcript}`,
    ).toBe(false)
    expect(result.writeErrors.join('\n')).toContain(GATE_MESSAGE)
  }, 240_000)

  it('lands when a PermissionRequest hook answers allow', async () => {
    const result = await probe('hook-allow')

    expect(result.hookFired, `the PermissionRequest hook never ran; transcript ${result.transcript}`).toBe(
      true,
    )
    expect(result.landed, `hook allowed but no file; transcript ${result.transcript}`).toBe(true)
    expect(result.writeErrors).toEqual([])
  }, 240_000)
})
