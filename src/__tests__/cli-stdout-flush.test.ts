import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

/** CC-1449: a verb's output went through console.log then process.exit, which cut a piped stdout at the pipe buffer. */
describe('exitAfterFlush', () => {
  it('delivers more than 64 KB through a slow pipe reader before exiting', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'flush-'))
    try {
      const commandUrl = pathToFileURL(path.resolve('dist/cli/command.js')).href
      const script = path.join(dir, 'emit.mjs')
      const lines = 'x'.repeat(199) + '\n'
      writeFileSync(
        script,
        `import { exitAfterFlush } from ${JSON.stringify(commandUrl)}
for (let i = 0; i < 1000; i++) console.log(${JSON.stringify(lines.trim())})
await exitAfterFlush(0)`,
      )
      const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore'] })
      let received = 0
      child.stdout.pause()
      await new Promise(r => setTimeout(r, 200))
      child.stdout.on('data', chunk => (received += chunk.length))
      child.stdout.resume()
      await new Promise(resolve => child.on('close', resolve))
      expect(received).toBe(200 * 1000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
