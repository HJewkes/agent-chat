import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EXIT_WITH_PID_VAR } from '../broker/parent-watch.js'

const ROOT_VAR = 'TEST_HOME_ROOT'

export default function setup(): () => void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-test-home-run-'))
  process.env[ROOT_VAR] = root
  // Every broker a test starts exits within seconds of this run dying, not reparented to launchd (CC-435).
  process.env[EXIT_WITH_PID_VAR] = String(process.pid)
  return () => fs.rmSync(root, { recursive: true, force: true })
}
