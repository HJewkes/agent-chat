/**
 * CC-898: the variables that say which agent launch a process descends from.
 *
 * Only `run-agent`'s claude child and its descendants may carry them. The broker and everything
 * it starts (tmux, helpers) must not, or an orphan reaper keyed on them could not tell a stray
 * of a finished launch from infrastructure that merely inherited the identity of whichever
 * agent happened to auto-start the broker.
 */
export const AGENT_ID_ENV = 'AGENT_CHAT_AGENT_ID'
export const LAUNCHER_PID_ENV = 'AGENT_CHAT_LAUNCHER_PID'
export const LAUNCH_IDENTITY_ENV = [AGENT_ID_ENV, 'AGENT_CHAT_NAME', LAUNCHER_PID_ENV] as const

/** No `.`, `/` or `\`, so a valid agent name can never leave /tmp or name a parent. */
export const AGENT_NAME_PATTERN = '[a-z0-9][a-z0-9_-]{0,63}'

/**
 * CC-901: a launch's private temp dir is per-launch like its identity. Inherited by a broker an
 * agent started, it would become every later agent's TMPDIR and vanish when that agent exits.
 * CC-1184: it lives under /tmp or the on-disk root `<home>/.cache/agent-chat/tmp`.
 * CC-1266: its Claude Code harness dir, `CLAUDE_CODE_TMPDIR`, is per-launch too, under
 * `<home>/.cache/agent-chat/harness`.
 */
const LAUNCH_TMP_DIR = new RegExp(
  `^(?:/tmp|(?:/[^/]+)*/\\.cache/agent-chat/(?:tmp|harness))/ac-${AGENT_NAME_PATTERN}-[1-9]\\d{0,9}/?$`,
  'i',
)
const TMP_ENV = ['TMPDIR', 'TMP', 'TEMP', 'CLAUDE_CODE_TMPDIR'] as const

export const isLaunchTmpDir = (dir: string | undefined): boolean =>
  dir !== undefined && LAUNCH_TMP_DIR.test(dir)

export function clearLaunchTmpDirs(env: NodeJS.ProcessEnv): void {
  for (const key of TMP_ENV) if (isLaunchTmpDir(env[key])) delete env[key]
}

/**
 * TP-4347: a restart's owner token and its test seam belong to the one broker that restart
 * starts. Inherited, the token would let that broker's children outrank the lock too.
 */
export const RESTART_TOKEN_ENV = 'AGENT_CHAT_RESTART_TOKEN'
export const RESTART_GAP_ENV = 'AGENT_CHAT_TEST_RESTART_GAP_MS'
const RESTART_ENV = [RESTART_TOKEN_ENV, RESTART_GAP_ENV] as const

/** Removes the launch identity, any restart token and any launch's private temp dir from `env` in place. */
export function clearLaunchIdentity(env: NodeJS.ProcessEnv): void {
  for (const key of [...LAUNCH_IDENTITY_ENV, ...RESTART_ENV]) delete env[key]
  clearLaunchTmpDirs(env)
}

export function withoutLaunchIdentity(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env }
  clearLaunchIdentity(out)
  return out
}
