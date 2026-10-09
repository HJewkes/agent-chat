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

export function withoutLaunchIdentity(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env }
  for (const key of LAUNCH_IDENTITY_ENV) delete out[key]
  return out
}
