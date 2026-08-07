import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runChecks, worstStatus, type Check } from '../broker/doctor.js'
import { buildProgram } from '../cli/index.js'
import { tailLines } from '../cli/service.js'

/**
 * Step 3 of the service plan restructures the CLI into commander groups. These
 * tests assert the SHAPE of the command tree rather than running any verb: the
 * verbs all talk to a broker, but what the restructure can silently break is
 * argv — a renamed command is a broken process-launch contract with no compile
 * error anywhere.
 */

const find = (program: Command, name: string): Command | undefined =>
  program.commands.find(c => c.name() === name)

const names = (program: Command): string[] => program.commands.map(c => c.name())

describe('command tree', () => {
  const program = buildProgram()

  it('keeps the daily verdict verbs top-level', () => {
    for (const verb of ['inbox', 'answer', 'dismiss', 'endorse']) {
      expect(names(program)).toContain(verb)
    }
  })

  it('groups service operations under one noun', () => {
    const service = find(program, 'service')
    expect(service).toBeDefined()
    expect(names(service as Command).sort()).toEqual(
      ['open', 'logs', 'restart', 'start', 'status', 'stop'].sort(),
    )
  })

  it('regroups the diagnostic verbs under debug', () => {
    const debug = find(program, 'debug')
    // `claims` belongs here for the same reason `ps` does: claims are otherwise
    // visible only to agents through chat_list, which leaves a human diagnosing
    // a refusal with nothing to look at (CC-56).
    expect(names(debug as Command).sort()).toEqual(['claims', 'history', 'log', 'ps', 'send'].sort())
  })

  it('puts doctor at the top level, not under service', () => {
    expect(names(program)).toContain('doctor')
    expect(names(find(program, 'service') as Command)).not.toContain('doctor')
  })

  it('takes a port and a foreground flag on service start', () => {
    const start = find(find(program, 'service') as Command, 'start')
    const flags = (start as Command).options.map(o => o.long)
    expect(flags).toContain('--port')
    expect(flags).toContain('--foreground')
  })

  it('defaults service logs to 50 lines, with no --follow', () => {
    const logs = find(find(program, 'service') as Command, 'logs')
    const lines = (logs as Command).options.find(o => o.long === '--lines')
    expect(lines?.defaultValue).toBe(50)
    expect((logs as Command).options.map(o => o.long)).not.toContain('--follow')
  })
})

/**
 * `broker-client.ts` spawns `[cliEntry(), 'broker']` and `plugin.json` passes
 * `args: ["mcp"]`. Neither string is checked by the compiler, so this test is
 * the only thing standing between a tidy-up rename and a CLI that can no longer
 * start a broker or serve MCP.
 */
describe('process-launch contracts', () => {
  const program = buildProgram()

  it('keeps broker and mcp as hidden top-level commands', () => {
    for (const verb of ['broker', 'mcp']) {
      const command = find(program, verb)
      expect(command, `${verb} must still exist`).toBeDefined()
      expect(command?.name()).toBe(verb)
      // Hidden, not removed: they are launch contracts, not user-facing verbs.
      expect(
        program
          .createHelp()
          .visibleCommands(program)
          .map(c => c.name()),
      ).not.toContain(verb)
    }
  })

  it('keeps the pre-restructure flat verbs working as hidden aliases', () => {
    const visible = program
      .createHelp()
      .visibleCommands(program)
      .map(c => c.name())
    for (const verb of ['ps', 'history', 'log', 'send', 'run-agent']) {
      expect(names(program), `${verb} must still parse`).toContain(verb)
      expect(visible, `${verb} should no longer be advertised`).not.toContain(verb)
    }
  })
})

describe('tailLines', () => {
  it('returns the last n lines and ignores a trailing newline', () => {
    expect(tailLines('a\nb\nc\n', 2)).toEqual(['b', 'c'])
  })

  it('returns everything when there are fewer lines than asked for', () => {
    expect(tailLines('a\nb\n', 50)).toEqual(['a', 'b'])
  })
})

describe('doctor', () => {
  let dir: string
  const previousHome = process.env.AGENT_CHAT_HOME

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-'))
    process.env.AGENT_CHAT_HOME = dir
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.AGENT_CHAT_HOME
    else process.env.AGENT_CHAT_HOME = previousHome
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const by = (checks: Check[], name: string): Check => checks.find(c => c.name === name) as Check

  it('passes the checks a clean state dir can satisfy', async () => {
    const checks = await runChecks()
    expect(by(checks, 'node').status).toBe('ok')
    expect(by(checks, 'state dir').status).toBe('ok')
    expect(by(checks, 'socket path').status).toBe('ok')
  })

  it('warns rather than fails when there is no broker and no database yet', async () => {
    const checks = await runChecks()
    // A fresh install is not a broken install: the broker auto-starts on first
    // use and creates events.db then.
    expect(by(checks, 'events.db').status).toBe('warn')
    expect(by(checks, 'broker socket').status).toBe('warn')
  })

  it('fails the socket path check when the state dir blows the 104-byte cap', async () => {
    process.env.AGENT_CHAT_HOME = path.join(dir, 'x'.repeat(120))
    const checks = await runChecks()
    expect(by(checks, 'socket path').status).toBe('fail')
  })

  it('reports the worst status, not the last one', () => {
    const checks: Check[] = [
      { name: 'a', status: 'ok', detail: '' },
      { name: 'b', status: 'fail', detail: '' },
      { name: 'c', status: 'warn', detail: '' },
    ]
    expect(worstStatus(checks)).toBe('fail')
    expect(worstStatus(checks.slice(0, 1))).toBe('ok')
    expect(worstStatus(checks.slice(2))).toBe('warn')
  })
})
