import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EXIT_WITH_PID_VAR } from '../broker/parent-watch.js'

const ROOT_VAR = 'TEST_HOME_ROOT'

/** `/tmp` over a long darwin `$TMPDIR`, which would push a unix socket path past its length limit. */
const shortTmp = (): string => os.tmpdir()

export default function setup(): () => void {
  const root = fs.mkdtempSync(path.join(shortTmp(), 'agent-chat-test-run-'))
  process.env[ROOT_VAR] = root
  // The workers inherit these, so every os.tmpdir() mkdtemp in a spec lands under the one dir removed below (CC-900).
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) process.env[key] = root
  // A pnpm a spec spawns would otherwise link its project into a shared `<mount>/.pnpm-store`.
  process.env.npm_config_store_dir = path.join(root, 'pnpm-store')
  // Every broker a test starts exits within seconds of this run dying, not reparented to launchd (CC-435).
  process.env[EXIT_WITH_PID_VAR] = String(process.pid)
  return () => fs.rmSync(root, { recursive: true, force: true })
}
