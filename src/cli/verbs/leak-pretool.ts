import os from 'node:os'
import { guardContext, pretoolDecision } from '../../leak-guard/pretool.js'
import { readStdin } from './permission-hook.js'

/** `agent-chat leak-guard pretool`: the PreToolUse hook every spawned agent runs (CC-270). */
export async function leakPretool(): Promise<void> {
  const out = pretoolDecision(await readStdin(), cwd => guardContext(process.env, cwd, os.homedir()))
  if (out !== '') process.stdout.write(`${out}\n`)
}
