import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * CC-118 slice 5's kill -9 gate, run for real: a built broker, a real unix
 * socket, a real `kill -9` of the broker process, and a second broker that has
 * to come back over the same `events.db`.
 *
 * `scripts/ledger-kill9-check.sh` is the thing under test, not reimplemented
 * here — the shell script IS the artifact this task ships, and a test that
 * only drove the TypeScript underneath it would prove nothing about the script
 * itself ever running end to end. This file is the harness that makes it part
 * of the suite.
 *
 * Opt-in, like `live-identity.test.ts:45`: needs a built `dist/`, forks real
 * processes and kills one with SIGKILL.
 *   AGENT_CHAT_LIVE=1 npx vitest run live-ledger-kill9
 */
const LIVE = process.env.AGENT_CHAT_LIVE === '1'

const SCRIPT = path.resolve(import.meta.dirname, '../../scripts/ledger-kill9-check.sh')

describe.skipIf(!LIVE)('a broker killed with SIGKILL and restarted over the same home', () => {
  it('reattaches the agent it was holding, classifying the gap and passing integrity_check', () => {
    const output = execFileSync('bash', [SCRIPT, '7695'], {
      encoding: 'utf8',
      timeout: 120_000,
    })

    expect(output).toContain('ledger_only_since_restart')
    expect(output).toContain('pragma integrity_check -> ok')
    expect(output).toContain('ledger-kill9-check: OK')
  }, 130_000)
})
