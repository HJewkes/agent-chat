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
 *
 * THE DENY LISTS ARE WHAT CONFINE A READ-ONLY PROFILE — `allowedTools` does not.
 * `--allowed-tools` GRANTS permission; it does not remove a tool. A spawned agent
 * still inherits `~/.claude/settings.json` and the project's settings, so a
 * `Bash(*)` sitting in either one hands a shell to an "explorer" whose profile
 * names only Read, Grep and Glob. Observed, not inferred: an explorer-profile
 * agent ran `git log` and got real output back. Only `--disallowed-tools`
 * actually takes the tool away.
 *
 * KNOWN COST OF DOING IT THIS WAY, so nobody has to rediscover it: these lists
 * are ENUMERATED, not derived from (known tools − allowedTools). A tool Claude
 * Code gains later is therefore ALLOWED BY OMISSION on these profiles until
 * someone adds it here. That was chosen deliberately over deriving the complement
 * — the derivation needs a list of every tool that exists, which we would then own
 * and have to keep true. Add new mutating tools to these lists.
 *
 * `HUMAN_ONLY_CLI_DENY` below is the same idea aimed at a narrower target: the
 * `agent-chat` CLI verbs that act with the human's own authority (`endorse`,
 * `dismiss`, `send`, `answer` — see `broker/socket.ts`'s `isHuman`). CC-22's
 * adversarial review (2026-07-30) found a `Bash`-capable spawned agent could
 * self-approve its own endorsement by simply shelling out to `agent-chat
 * endorse <id>`. Denying the pattern here is CONFIGURATION, not a guarantee —
 * it stops the straightforward case (a profile-granted `Bash` running the
 * command as written) and nothing more: a differently-invoked form (`node
 * dist/cli.js endorse`, an absolute path, `npx agent-chat endorse`) is a
 * different literal string and will not match; a raw socket write bypasses the
 * CLI, and therefore this list, entirely. Real defense in depth, not a fix —
 * `broker/socket.ts`'s `isHuman` states the same limit from the broker side.
 */
const HUMAN_ONLY_CLI_DENY = [
  'Bash(agent-chat endorse:*)',
  'Bash(agent-chat dismiss:*)',
  'Bash(agent-chat send:*)',
  'Bash(agent-chat answer:*)',
]

/**
 * CC-47: the operator's global CLAUDE.md requires every turn that ends without
 * a pending tool result to end with AskUserQuestion. A spawned agent inherits
 * that file like any other session, so the turn right after it goes idle —
 * first contact or any later one — gets forced into asking itself an
 * unanswerable question and sits blocked until a human clicks through it in
 * its pane. Headless profiles can't even be prompted, so there it hangs
 * forever with no human able to see why. Denying the tool outright is a
 * config-level fix, not a CLAUDE.md edit: the rule still applies, it just has
 * no tool left to satisfy it with, so the agent ends the turn on plain text
 * instead of blocking.
 */
const NO_SELF_QUESTION = ['AskUserQuestion']

export const BUILTIN_PROFILES: readonly AgentProfile[] = [
  {
    name: 'explorer',
    description: 'Read-only search and reconnaissance. Nothing it does can prompt.',
    model: 'sonnet',
    allowedTools: ['Read', 'Grep', 'Glob'],
    disallowedTools: ['Bash', 'Write', 'Edit', ...NO_SELF_QUESTION],
    isolation: 'toolset-limited',
    surface: 'headless',
    promptPrelude: 'You are a read-only explorer. Report what you find; do not attempt to change anything.',
  },
  {
    name: 'reviewer',
    description: 'Reads and runs narrow checks. Bash is allowlisted, not open-ended.',
    model: 'sonnet',
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    // Bash SURVIVES here on purpose — a reviewer that cannot run the tests is an
    // explorer with a different prelude. It is confined at the file boundary
    // instead: it may run commands, it may not edit what it is reviewing.
    disallowedTools: ['Write', 'Edit', ...HUMAN_ONLY_CLI_DENY, ...NO_SELF_QUESTION],
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
    disallowedTools: [...HUMAN_ONLY_CLI_DENY, ...NO_SELF_QUESTION],
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
    disallowedTools: [...HUMAN_ONLY_CLI_DENY, ...NO_SELF_QUESTION],
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
