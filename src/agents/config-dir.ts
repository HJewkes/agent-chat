import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Which Claude account a spawned agent runs on (CC-100).
 *
 * ## The bug this exists to close
 *
 * `run-agent` builds the child's environment from `agentEnv()`, which is a copy
 * of the BROKER's `process.env` — and the broker is a detached daemon autostarted
 * by whichever session happened to connect first. Whatever `CLAUDE_CONFIG_DIR`
 * that session had (usually none) is what every agent spawned for the rest of the
 * broker's life inherited, so agents spawned from a session on a dedicated
 * account silently ran on `~/.claude` instead. Four agents spawned from a
 * `workout` session wrote their transcripts under `~/.claude/projects/` and then
 * died on that account's spend limit.
 *
 * The spawning session's MCP server DOES carry its own `CLAUDE_CONFIG_DIR`. It
 * was simply never forwarded. This module is the rule for what to do with it.
 *
 * ## Precedence, as the human settled it (2026-09-15)
 *
 * 1. an explicit `config_dir` on the spawn request — the caller naming an account;
 * 2. the SPAWNER's own dir, observed from its MCP server process;
 * 3. the briefing initiative's `profile:` field, resolved the way active-work's
 *    own launcher resolves it (`$HOME/.claude-profiles/<profile>`);
 * 4. the broker's own environment, and `~/.claude` behind that.
 *
 * Step 2 above step 3 is the deliberate half. active-work's launcher does the
 * opposite — there the brief is the more specific instruction because nothing
 * else has spoken yet — but by the time a spawn reaches here a human has chosen
 * an account for the session doing the spawning, and that choice is newer and
 * more specific than the initiative's default.
 *
 * ## Why a resolved value is always returned
 *
 * The child's `CLAUDE_CONFIG_DIR` is set explicitly even when the answer is the
 * default `~/.claude`. Leaving it unset would mean "whatever the broker's env
 * says", which is the bug. Setting it makes the account a recorded fact about the
 * agent rather than an accident of the broker's history.
 */

/** Matches `CLAUDE_PROFILE_ROOT` / `DEFAULT_PROFILE_ROOT` in active-work's `launcher-profile.ts`. */
const PROFILE_ROOT_ENV = 'CLAUDE_PROFILE_ROOT'
const DEFAULT_PROFILE_ROOT = '.claude-profiles'

export type ConfigDirSource = 'explicit' | 'spawner' | 'profile' | 'broker'

export interface ConfigDirRequest {
  /** An absolute path the request named. Rejected rather than ignored when unusable. */
  explicit?: string
  /** The spawning session's own `CLAUDE_CONFIG_DIR`, as its MCP server saw it. */
  spawner?: string
  /** The briefing initiative's `profile:` field, e.g. `agents`. */
  profile?: string
  /** The broker's environment. Injected so the rule is testable without mutating the process. */
  env?: NodeJS.ProcessEnv
  home?: string
  /** Injected for the same reason. Real filesystem by default. */
  isDirectory?: (dir: string) => boolean
}

export type ConfigDirResolution =
  | { dir: string; source: ConfigDirSource; warning?: string }
  /** The request named a dir that cannot be used. A refusal, never a silent fallback. */
  | { error: string }

const realIsDirectory = (dir: string): boolean => {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/**
 * Copied semantics, not copied code: active-work reads `CLAUDE_PROFILE_ROOT` when
 * it is absolute and falls back to `$HOME/.claude-profiles`.
 */
export function profileDir(profile: string, env: NodeJS.ProcessEnv, home: string): string {
  const configured = env[PROFILE_ROOT_ENV]
  const root = configured && path.isAbsolute(configured) ? configured : path.join(home, DEFAULT_PROFILE_ROOT)
  return path.join(root, profile)
}

/**
 * Why an explicit dir is REFUSED rather than warned about and dropped.
 *
 * Every other step here has a defensible fallback, because nobody asked for
 * anything in particular. An explicit `config_dir` is a caller saying which
 * account to bill; running somewhere else instead is the exact failure CC-100 is
 * about, wearing the shape of a success. The containment rule is the one
 * `spawn-cwd.ts` already applies to `cwd`: inside the user's own home, which is
 * where every config dir on this machine lives.
 */
export function checkConfigDir(
  explicit: string,
  opts: { home?: string; isDirectory?: (dir: string) => boolean } = {},
): string | undefined {
  const home = opts.home ?? os.homedir()
  const isDirectory = opts.isDirectory ?? realIsDirectory
  if (!path.isAbsolute(explicit)) return `config_dir must be an absolute path, and "${explicit}" is not`
  const resolved = path.resolve(explicit)
  if (!resolved.startsWith(home + path.sep))
    return `config_dir must be under your home directory (${home}), and "${resolved}" is not`
  if (!isDirectory(resolved))
    return `config_dir "${resolved}" is not an existing directory — a Claude config dir has to exist already`
  return undefined
}

export function resolveConfigDir(req: ConfigDirRequest = {}): ConfigDirResolution {
  const env = req.env ?? process.env
  const home = req.home ?? os.homedir()
  const isDirectory = req.isDirectory ?? realIsDirectory

  if (req.explicit !== undefined && req.explicit !== '') {
    const problem = checkConfigDir(req.explicit, { home, isDirectory })
    return problem === undefined
      ? { dir: path.resolve(req.explicit), source: 'explicit' }
      : { error: problem }
  }

  if (req.spawner !== undefined && req.spawner !== '') return { dir: req.spawner, source: 'spawner' }

  const fallback = { dir: env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'), source: 'broker' as const }
  if (req.profile === undefined || req.profile === '') return fallback

  const dir = profileDir(req.profile, env, home)
  // A missing profile dir warns and carries on, matching active-work: the work is
  // still doable on whatever account is active, and stranding an initiative
  // behind a config problem is the worse outcome. The warning is what stops it
  // being silent, which is the whole complaint behind CC-100.
  if (!isDirectory(dir))
    return {
      ...fallback,
      warning:
        `the briefing initiative declares profile "${req.profile}" but ${dir} does not exist — ` +
        `the agent runs on ${fallback.dir} instead`,
    }
  return { dir, source: 'profile' }
}

/** The last segment, which is what a human calls the account. `~/.claude` reads as `.claude`. */
export const accountName = (dir: string): string => path.basename(dir)
