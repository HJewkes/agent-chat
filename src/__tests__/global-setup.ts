import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT_VAR = 'TEST_HOME_ROOT'

export default function setup(): () => void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-test-home-run-'))
  process.env[ROOT_VAR] = root
  return () => fs.rmSync(root, { recursive: true, force: true })
}
