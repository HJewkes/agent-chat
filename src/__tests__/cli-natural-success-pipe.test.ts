import { spawn } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

it('drains a successful report to a real pipe and leaves late callbacks runnable', async () => {
  const command = pathToFileURL(path.resolve('dist/cli/command.js')).href
  const bytes = 8 * 1024 * 1024
  const script = [
    "import { Command } from 'commander';",
    "import { z } from 'zod';",
    'const { addVerb, defineVerb, Report } = await import(' + JSON.stringify(command) + ');',
    'const program = new Command();',
    'const verb = defineVerb({',
    "name: 'fixture.pipe', args: z.object({}), result: Report,",
    "run: async () => ({ ok: true, lines: ['X'.repeat(" + bytes + ')] }),',
    '});',
    "setTimeout(() => process.stderr.write('late-callback\\n'), 0);",
    'addVerb(program, verb, { exitOnSuccess: false });',
    "await program.parseAsync(['node', 'fixture', 'pipe']);",
  ].join('\n')
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: {},
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdoutBytes = 0
  let stderr = ''
  child.stdout.pause()
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.length
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const resume = setTimeout(() => child.stdout.resume(), 100)
  const timeout = setTimeout(() => child.kill('SIGKILL'), 4000)
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    },
  ).finally(() => {
    clearTimeout(resume)
    clearTimeout(timeout)
  })
  expect(exit).toEqual({ code: 0, signal: null })
  expect(stdoutBytes).toBe(bytes + 1)
  expect(stderr).toBe('late-callback\n')
})
