import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HUMAN_ROOT, IntegrityLedger } from '../broker/integrity-ledger.js'
import { hookSettingsPath, OFF_BROKER, writeLaunchFiles } from '../agents/launch-files.js'
import { buildLaunchPlan } from '../agents/launch-plan.js'

/**
 * TP-4256 A3: a launch write takes the ledger's admission or the named `OFF_BROKER`, and an
 * `OFF_BROKER` write carries no integrity hook. Paths and ids are synthetic.
 */

const tmpDirs: string[] = []
const saved = { home: process.env.HOME }

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-admission-'))
  tmpDirs.push(dir)
  return dir
}

beforeEach(() => {
  process.env.AGENT_CHAT_HOME = tmpDir()
  process.env.CLAUDE_CONFIG_DIR = tmpDir()
  process.env.HOME = tmpDir()
})

afterEach(() => {
  process.env.HOME = saved.home
  delete process.env.AGENT_CHAT_HOME
  delete process.env.CLAUDE_CONFIG_DIR
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const plan = () =>
  buildLaunchPlan({
    agentId: 'agoff001',
    sessionId: 'sess-off',
    name: 'remote',
    profile: {
      name: 'explorer',
      description: '',
      model: '',
      allowedTools: [],
      isolation: 'none',
      surface: 'headless',
      promptPrelude: '',
    },
    adopted: false,
    brief: 'synthetic',
    cwd: tmpDir(),
    cwdHoldsUserSettings: false,
    surface: 'headless',
    mcpConfigPath: '/synthetic/mcp.json',
    hookSettingsPath: hookSettingsPath('agoff001'),
  })

const settings = (): string => fs.readFileSync(hookSettingsPath('agoff001'), 'utf8')

describe('an off-broker launch write', () => {
  it('differs from an admitted one only by the nonce-bearing hooks', () => {
    writeLaunchFiles(plan(), {}, undefined, OFF_BROKER)
    const off = settings()
    const { nonce } = new IntegrityLedger().admit({ agentId: 'agoff001', parent: HUMAN_ROOT }, admission =>
      writeLaunchFiles(plan(), {}, undefined, admission),
    )
    const admitted = JSON.parse(settings()) as { hooks: { PostToolUse: unknown[] } }
    const posttool = admitted.hooks.PostToolUse.pop()

    expect(JSON.stringify(posttool)).toContain(`leak-guard posttool --integrity '${nonce}'`)
    expect(off).not.toContain('--integrity')
    expect(off).toBe(JSON.stringify(admitted, null, 2).replace(` --integrity '${nonce}'`, ''))
  })

  it('cannot be written without an admission or OFF_BROKER', () => {
    // @ts-expect-error: the admission is required, so a new call site cannot skip the ledger
    const unadmitted = () => writeLaunchFiles(plan(), {}, undefined)

    expect(unadmitted).toBeTypeOf('function')
  })
})
