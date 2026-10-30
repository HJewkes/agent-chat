import path from 'node:path'
import { EXIT_WITH_PID_VAR } from '../broker/parent-watch.js'
import { createRunRoot, LEGACY_BASE, removeRunRoot, runBase, sweepDeadRuns } from './helpers/run-root.js'

const ROOT_VAR = 'TEST_HOME_ROOT'

export default function setup(): () => void {
  const base = runBase()
  // A run killed before its teardown leaves its root; runs before CC-1673 left theirs in /tmp.
  sweepDeadRuns([base, LEGACY_BASE])
  const root = createRunRoot(base)
  process.env[ROOT_VAR] = root
  // The workers inherit these, so every os.tmpdir() mkdtemp in a spec lands under the one dir removed below (CC-900).
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) process.env[key] = root
  // A pnpm a spec spawns would otherwise link its project into a shared `<mount>/.pnpm-store`.
  process.env.npm_config_store_dir = path.join(root, 'pnpm-store')
  // A tick with no injected owner-queue dir would otherwise file into the developer's real console spool (CC-864).
  const consoleState = path.join(root, 'titan-console-state')
  process.env.TITAN_CONSOLE_STATE = consoleState
  process.env.TITAN_CONSOLE_INBOX_DIR = path.join(consoleState, 'inbox', 'deposits')
  // Every broker a test starts exits within seconds of this run dying, not reparented to launchd (CC-435).
  process.env[EXIT_WITH_PID_VAR] = String(process.pid)
  return () => {
    removeRunRoot(root)
  }
}
