import fs from 'node:fs'
import path from 'node:path'
import { agentDir } from '../paths.js'

/**
 * The tail of a headless claude's stderr, kept where the broker can read it (CC-161).
 *
 * The broker cannot hold the pipe (see headless.ts), so the wrapper that outlives
 * it does: it drains claude's stderr, keeps a bounded tail, and leaves it here
 * when claude exits. The broker reads the file only to explain a failed launch.
 */
export const OUTPUT_TAIL_BYTES = 4096

export const outputTailPath = (agentId: string): string => path.join(agentDir(agentId), 'stderr-tail.txt')

/** Keeps the last `limit` characters however much is appended. */
export function tailKeeper(limit: number = OUTPUT_TAIL_BYTES): {
  append(chunk: string): void
  text(): string
} {
  let kept = ''
  return {
    append: chunk => {
      kept = (kept + chunk).slice(-limit)
    },
    text: () => kept,
  }
}

export function writeOutputTail(agentId: string, text: string): void {
  if (text === '') return
  fs.mkdirSync(agentDir(agentId), { recursive: true, mode: 0o700 })
  fs.writeFileSync(outputTailPath(agentId), text, { mode: 0o600 })
}

export function readOutputTail(agentId: string): string | undefined {
  try {
    return fs.readFileSync(outputTailPath(agentId), 'utf8')
  } catch {
    return undefined
  }
}

/** What claude prints when no login exists under its config dir. */
const NOT_LOGGED_IN = /not logged in|please run \/login/i

/** The login diagnosis when `output` carries claude's not-logged-in signature, else undefined. */
export function loginGap(output: string | undefined, configDir: string): string | undefined {
  if (output === undefined || !NOT_LOGGED_IN.test(output)) return undefined
  return (
    `Claude Code reported it is not logged in. Run \`claude /login\` with CLAUDE_CONFIG_DIR=${configDir} ` +
    'so the login lands in the config dir this agent uses.'
  )
}
