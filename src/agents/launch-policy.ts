import os from 'node:os'
import path from 'node:path'
import type { SurfaceName } from '../protocol.js'
import { roleOf } from './profiles.js'
import { canonicalPath } from './spawn-cwd.js'
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

/**
 * Whether `project` and `local` at this cwd ARE an account's user settings.
 *
 * Claude Code reads the project file from `<cwd>/.claude/settings.json`. At the
 * home directory that is the default account's user file, and at the parent of
 * any config dir it can be that account's. Observed on claude 2.1.288 with
 * `--setting-sources project,local --allowed-tools Read`: an unlisted `touch`
 * ran from the home directory and was denied from a worktree.
 */
export function cwdHoldsUserSettings(cwd: string, configDir?: string, home: string = os.homedir()): boolean {
  const real = canonicalPath(cwd)
  const roots = [home, ...(configDir === undefined ? [] : [path.dirname(configDir)])]
  return roots.some(root => canonicalPath(root) === real)
}

/**
 * Undefined means no `--setting-sources` flag, so Claude Code loads every source.
 * A list that leaves `user` out loads no file at all from a cwd that holds user
 * settings, since every other source there is the user file under another name.
 */
export function settingSourcesFor(
  profile: AgentProfile,
  atUserSettings = false,
): readonly SettingSource[] | undefined {
  const sources =
    profile.settingSources ?? (roleOf(profile) === 'worker' ? WORKER_SETTING_SOURCES : undefined)
  return atUserSettings && sources !== undefined && !sources.includes('user') ? [] : sources
}

/**
 * A headless worker has no pane to answer a prompt for a tool from a server its
 * profile never named, so it loads only the generated `--mcp-config`.
 */
export const strictMcpFor = (profile: AgentProfile, surface: SurfaceName = profile.surface): boolean =>
  profile.strictMcpConfig ?? (roleOf(profile) === 'worker' && surface === 'headless')
