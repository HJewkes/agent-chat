import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildProgram, run } from '../cli/index.js'
import { unknownCommand } from '../cli/unknown-command.js'

/**
 * CC-291: commander answers `--help` before it rejects an unknown command, so
 * `agent-chat gh-write --help` passed as a presence probe on a build without
 * gh-write. These run the real entry point with exit and output captured.
 */

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`)
  }
}

let stdout: string
let stderr: string

beforeEach(() => {
  stdout = ''
  stderr = ''
  vi.spyOn(process, 'exit').mockImplementation(code => {
    throw new Exit(code as number | undefined)
  })
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => ((stdout += String(chunk)), true))
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => ((stderr += String(chunk)), true))
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function exitCodeOf(...args: string[]): Promise<number | undefined> {
  try {
    await run(['node', 'agent-chat', ...args])
  } catch (err) {
    if (err instanceof Exit) return err.code
    throw err
  }
  return undefined
}

describe('an unknown command with --help', () => {
  it('exits 1 naming an unknown top-level command', async () => {
    const code = await exitCodeOf('nosuchcmd', '--help')

    expect(code).toBe(1)
    expect(stderr).toContain("unknown command 'nosuchcmd'")
  })

  it('exits 1 naming an unknown subcommand of a group', async () => {
    const code = await exitCodeOf('agent', 'nosuch', '--help')

    expect(code).toBe(1)
    expect(stderr).toContain("unknown command 'nosuch'")
  })

  it.each([['pr-ready'], ['gh-write']])('still prints help for the real %s verb', async verb => {
    const code = await exitCodeOf(verb, '--help')

    expect(code).toBe(0)
    expect(stdout).toContain(`Usage: agent-chat ${verb}`)
    expect(stderr).toBe('')
  })
})

describe('unknownCommand', () => {
  it('treats a hidden command and help as known', () => {
    const program = buildProgram()

    expect(unknownCommand(program, ['broker'])).toBeUndefined()
    expect(unknownCommand(program, ['help', 'nosuch'])).toBeUndefined()
  })

  it('stops at the first option-like arg', () => {
    expect(unknownCommand(buildProgram(), ['agent', '--json', 'nosuch'])).toBeUndefined()
  })
})
