import fs from 'node:fs'
import path from 'node:path'
import { profilesDir } from '../paths.js'
import { ISOLATION_NAMES, SURFACE_NAMES } from '../protocol.js'
import type { AgentProfile } from './types.js'

/**
 * The four builtins, layered under anything in `~/.agent-chat/profiles/*.json`.
 *
 * Writers default to a VISIBLE surface, and that is a permissions decision
 * rather than an aesthetic one. A visible agent that hits a permission prompt
 * has a human-answerable dialog sitting right there in its pane; a headless one
 * does not, and cannot be unblocked by anyone. The asymmetry is severe enough to
 * drive the default: spawn writers visible unless there is a reason not to.
 */
export const BUILTIN_PROFILES: readonly AgentProfile[] = [
  {
    name: 'explorer',
    description: 'Read-only search and reconnaissance. Nothing it does can prompt.',
    model: 'sonnet',
    allowedTools: ['Read', 'Grep', 'Glob'],
    isolation: 'toolset-limited',
    surface: 'headless',
    promptPrelude: 'You are a read-only explorer. Report what you find; do not attempt to change anything.',
  },
  {
    name: 'reviewer',
    description: 'Reads and runs narrow checks. Bash is allowlisted, not open-ended.',
    model: 'sonnet',
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    isolation: 'toolset-limited',
    surface: 'headless',
    promptPrelude:
      'You are reviewing work you did not write. Report findings with file and line references. ' +
      'Do not fix what you find unless asked.',
  },
  {
    name: 'implementer',
    description: 'Writes code in its own worktree, in a visible pane so prompts are answerable.',
    model: 'opus',
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
    isolation: 'worktree',
    surface: 'iterm-pane',
    promptPrelude:
      'You are implementing in an isolated worktree. Keep diffs small and reviewable, and run the ' +
      "project's tests before reporting done.",
  },
  {
    // The profile that expresses what this whole system is for: a long-lived
    // agent in a visible tab, sharing the checkout, addressable by name — the
    // thing a spawn-tree topology cannot express.
    name: 'peer',
    description: 'A long-lived collaborator sharing your checkout, addressable by name.',
    model: 'opus',
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
    isolation: 'none',
    surface: 'iterm-tab',
    promptPrelude:
      'You are a peer working alongside other sessions in a shared checkout. Coordinate over ' +
      'agent-chat before editing files someone else may be holding.',
  },
]

/** Fields a profile file may not set, with why. Silently ignoring them would be worse. */
const FORBIDDEN_FIELDS: Record<string, string> = {
  permissionMode:
    'a profile widens a posture by naming tools, which is reviewable in a diff; a mode flag widens it by category, which is not',
  permission_mode: 'see permissionMode',
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(entry => typeof entry === 'string')

/**
 * Validate a parsed profile file. Returns the profile or an explanatory error —
 * never a partially-trusted object, because a profile that half-loaded would
 * grant whatever its defaults happened to be.
 */
export function parseProfile(name: string, raw: unknown): AgentProfile | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: `${name}: not a JSON object` }
  const body = raw as Record<string, unknown>

  for (const [field, why] of Object.entries(FORBIDDEN_FIELDS))
    if (field in body) return { error: `${name}: "${field}" is not allowed — ${why}` }

  if (typeof body.model !== 'string' || body.model === '') return { error: `${name}: "model" is required` }
  if (!isStringArray(body.allowedTools))
    return { error: `${name}: "allowedTools" must be an array of strings` }
  if (body.disallowedTools !== undefined && !isStringArray(body.disallowedTools))
    return { error: `${name}: "disallowedTools" must be an array of strings` }
  if (!ISOLATION_NAMES.includes(body.isolation as never))
    return { error: `${name}: "isolation" must be one of ${ISOLATION_NAMES.join(', ')}` }
  if (!SURFACE_NAMES.includes(body.surface as never))
    return { error: `${name}: "surface" must be one of ${SURFACE_NAMES.join(', ')}` }

  return {
    name,
    description: typeof body.description === 'string' ? body.description : '',
    model: body.model,
    allowedTools: body.allowedTools,
    ...(body.disallowedTools === undefined ? {} : { disallowedTools: body.disallowedTools }),
    isolation: body.isolation as AgentProfile['isolation'],
    surface: body.surface as AgentProfile['surface'],
    promptPrelude: typeof body.promptPrelude === 'string' ? body.promptPrelude : '',
    ...(typeof body.mcpServers === 'object' && body.mcpServers !== null
      ? { mcpServers: body.mcpServers as Record<string, unknown> }
      : {}),
  }
}

/**
 * Resolve a profile BY NAME ONLY. A spawn request names a profile; it never
 * carries a profile body. That single rule is what keeps a spawn request from
 * being "execute arbitrary argv" with extra steps, so there is deliberately no
 * variant of this function that takes a profile object.
 */
export function loadProfile(name: string, dir: string = profilesDir()): AgentProfile | { error: string } {
  const file = path.join(dir, `${name}.json`)
  if (fs.existsSync(file)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (err) {
      return { error: `${name}: ${file} is not valid JSON (${(err as Error).message})` }
    }
    return parseProfile(name, parsed)
  }

  const builtin = BUILTIN_PROFILES.find(p => p.name === name)
  if (builtin) return builtin
  return { error: `no profile named "${name}"; known: ${listProfileNames(dir).join(', ')}` }
}

export function listProfileNames(dir: string = profilesDir()): string[] {
  const user = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => path.basename(f, '.json'))
    : []
  return [...new Set([...BUILTIN_PROFILES.map(p => p.name), ...user])].sort()
}
