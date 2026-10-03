import type { SurfaceName } from '../protocol.js'
import { roleOf } from './profiles.js'
import type { AgentProfile, SettingSource } from './types.js'

/**
 * What a launch loads from outside its profile, decided by role.
 *
 * A worker's profile is its whole capability set. Without `--setting-sources`
 * the account's user settings load too, and an allow rule there (`Bash(*)`, an
 * MCP wildcard) approves what the profile never named. Observed on claude
 * 2.1.288: with `--allowed-tools Read` an unlisted `curl` ran under the default
 * sources and was denied under `project,local`.
 *
 * A coordinator is a human-supervised session, so it keeps the posture the
 * human's own settings give it and no flag is emitted.
 */
export const WORKER_SETTING_SOURCES: readonly SettingSource[] = ['project', 'local']

/** Undefined means no `--setting-sources` flag, so Claude Code loads every source. */
export function settingSourcesFor(profile: AgentProfile): readonly SettingSource[] | undefined {
  if (profile.settingSources !== undefined) return profile.settingSources
  return roleOf(profile) === 'worker' ? WORKER_SETTING_SOURCES : undefined
}

/**
 * A headless worker has no pane to answer a prompt for a tool from a server its
 * profile never named, so it loads only the generated `--mcp-config`.
 */
export const strictMcpFor = (profile: AgentProfile, surface: SurfaceName = profile.surface): boolean =>
  profile.strictMcpConfig ?? (roleOf(profile) === 'worker' && surface === 'headless')
