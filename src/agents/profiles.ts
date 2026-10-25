import fs from 'node:fs'
import path from 'node:path'
import { profilesDir } from '../paths.js'
import { ISOLATION_NAMES, SURFACE_NAMES } from '../protocol.js'
import { PROBE_SANDBOX_RULE } from './return-contract-blocks.js'
import {
  AGENT_ROLES,
  CACHE_TTLS,
  EFFORT_LEVELS,
  HARNESSES,
  RETURN_CONTRACTS,
  SETTING_SOURCES,
  SURFACE_LIFETIMES,
  isCacheTtl,
  type AgentProfile,
  type AgentRole,
  type EffortLevel,
  type Harness,
  type ReturnContract,
  type SettingSource,
  type SurfaceLifetime,
} from './types.js'

/**
 * The five builtins, layered under anything in `~/.agent-chat/profiles/*.json`.
 *
 * All five builtins default to a VISIBLE surface (`iterm-pane`), and that is a
 * permissions decision rather than an aesthetic one. A visible agent that hits
 * a permission prompt has a human-answerable dialog sitting right there in its
 * pane; a headless one does not, and cannot be unblocked by anyone. The
 * asymmetry is severe enough to drive the default: spawn every builtin visible
 * unless there is a reason not to. `explorer`/`reviewer` used to default to
 * `headless` (their `AskUserQuestion` deny predates this change and stays —
 * see `NO_SELF_QUESTION` — since a read-only/narrow-check agent still has no
 * business opening a question, visible pane or not); a bare `headless` surface
 * remains available and is still exactly what `surfaces/headless.ts` documents
 * (no terminal at all, `stdio` discarded) for whatever explicitly asks for it.
 *
 * THE DENY LISTS ARE WHAT CONFINE A READ-ONLY PROFILE — `allowedTools` does not.
 * `--allowed-tools` GRANTS permission; it does not remove a tool. A worker no
 * longer loads the account's user settings (`launch-policy.ts`), but it still
 * loads the project's, so a `Bash(*)` sitting there hands a shell to an
 * "explorer" whose profile names only Read, Grep and Glob. Observed, not
 * inferred: an explorer-profile agent ran `git log` and got real output back.
 * Only `--disallowed-tools` actually takes the tool away.
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
 * `dismiss`, `send`, `answer`, `approve`, and `inbox --batch --answers`, which
 * reaches `approve` and `endorse` through one door (CC-425) — see `broker/socket.ts`'s `isHuman`).
 * `approve` is the newest and the one with the most to lose (CC-96): it answers a
 * permission prompt, so an agent that reached it would be granting itself a tool
 * call the human never approved, which is `docs/ideas.md` R1. CC-22's
 * adversarial review (2026-07-30) found a `Bash`-capable spawned agent could
 * self-approve its own endorsement by simply shelling out to `agent-chat
 * endorse <id>`. Denying the pattern here is CONFIGURATION, not a guarantee —
 * it stops the straightforward case (a profile-granted `Bash` running the
 * command as written) and nothing more: a differently-invoked form (`node
 * dist/cli.js endorse`, an absolute path, `npx agent-chat endorse`) is a
 * different literal string and will not match; a raw socket write bypasses the
 * CLI, and therefore this list, entirely. Real defense in depth, not a fix —
 * `broker/socket.ts`'s `isHuman` states the same limit from the broker side.
 * `ask` (CC-169) is here too: it puts a question to the human under a service
 * label, which an agent has its own `chat_ask` for and must not borrow.
 * `debug send` (CC-1083) sends `human_send`, so its text arrives `from="human"`.
 * Only that `debug` verb: `ps`, `claims` and `history` stay open as read-only diagnostics.
 */
const HUMAN_ONLY_CLI_DENY = [
  'Bash(agent-chat endorse:*)',
  'Bash(agent-chat dismiss:*)',
  'Bash(agent-chat send:*)',
  'Bash(agent-chat answer:*)',
  'Bash(agent-chat approve:*)',
  'Bash(agent-chat inbox:*)',
  'Bash(agent-chat ask:*)',
  'Bash(agent-chat teleport:*)',
  'Bash(agent-chat debug send:*)',
]

/**
 * CC-216: the CLI's `agent` verbs reach the socket on an unregistered connection,
 * which the broker counts as the human, so a worker with Bash could spawn or
 * resume around the CC-163 role gate. Same configuration-not-guarantee limit as
 * `HUMAN_ONLY_CLI_DENY`. Workers read the roster through `agent_list` instead.
 * CC-1194: the `port` verbs spawn, resume and retire over the same connection.
 * CC-1138: so do the `seats` verbs, and `seats watchdog` also sends `human_send`.
 */
const WORKER_CLI_DENY = ['Bash(agent-chat agent:*)', 'Bash(agent-chat port:*)', 'Bash(agent-chat seats:*)']

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
    surface: 'iterm-pane',
    surfaceLifetime: 'close-on-exit',
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
    // refs/stash is shared by every worktree, so a reviewer's stash can capture a peer's edit.
    disallowedTools: [
      'Write',
      'Edit',
      'Bash(git stash:*)',
      ...HUMAN_ONLY_CLI_DENY,
      ...WORKER_CLI_DENY,
      ...NO_SELF_QUESTION,
    ],
    isolation: 'toolset-limited',
    surface: 'iterm-pane',
    surfaceLifetime: 'close-on-exit',
    // A reviewer finishes inside 5 minutes, so the 1 h cache write premium buys nothing.
    cacheTtl: '5m',
    promptPrelude:
      'You are reviewing work you did not write. Report findings with file and line references. ' +
      'Do not fix what you find unless asked. ' +
      // In the prelude, not only the contract block: CLI, resumed and return_contract none launches get no block.
      PROBE_SANDBOX_RULE,
  },
  {
    name: 'implementer',
    description: 'Writes code in its own worktree, in a visible pane so prompts are answerable.',
    model: 'opus',
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Monitor'],
    disallowedTools: [...HUMAN_ONLY_CLI_DENY, ...WORKER_CLI_DENY, ...NO_SELF_QUESTION],
    isolation: 'worktree',
    surface: 'iterm-pane',
    surfaceLifetime: 'close-on-exit',
    promptPrelude:
      'You are implementing in an isolated worktree. Keep diffs small and reviewable, and run the ' +
      "project's tests before reporting done.",
  },
  {
    // The profile that expresses what this whole system is for: a long-lived
    // agent sharing the checkout, addressable by name — the thing a spawn-tree
    // topology cannot express.
    //
    // A pane rather than a tab (CC-89), which reverses the original choice and
    // makes the header comment above true of all four builtins rather than
    // three. The tab was meant to say "co-equal, not a subordinate", but it says
    // it by hiding the agent behind a tab bar that shows no output until you
    // switch to it — and a peer sharing your checkout is the one whose edits you
    // most need to see landing. The same permissions argument that moved
    // explorer and reviewer applies here with more force, since this profile can
    // write. Co-equality is carried by `isolation: 'none'` and the prelude,
    // which is where it belongs; the surface is about visibility.
    name: 'peer',
    description: 'A long-lived collaborator sharing your checkout, addressable by name.',
    model: 'opus',
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Monitor'],
    disallowedTools: [...HUMAN_ONLY_CLI_DENY, ...WORKER_CLI_DENY, ...NO_SELF_QUESTION],
    isolation: 'none',
    surface: 'iterm-pane',
    // `keep`, alone among the builtins, and for the reason the retire-only rule
    // was written in the first place: a long-lived collaborator sharing your
    // checkout is exactly the agent whose last output someone is still reading
    // when it finishes. The others are dispatched, do a job and go.
    surfaceLifetime: 'keep',
    promptPrelude:
      'You are a peer working alongside other sessions in a shared checkout. Coordinate over ' +
      'agent-chat before editing files someone else may be holding.',
  },
  {
    // CC-136: the explore half of an explore-then-implement split. It shares the
    // checkout, so Write is granted for the plan file but Edit and every
    // state-changing git verb are denied: it reads and runs tests, never alters.
    name: 'planner',
    description: 'Explores a codebase and writes an implementation plan file. Never edits source.',
    model: 'opus',
    allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Bash'],
    disallowedTools: [
      'Edit',
      'Bash(git commit:*)',
      'Bash(git push:*)',
      'Bash(git checkout:*)',
      'Bash(git reset:*)',
      'Bash(git stash:*)',
      ...HUMAN_ONLY_CLI_DENY,
      ...WORKER_CLI_DENY,
      ...NO_SELF_QUESTION,
    ],
    isolation: 'none',
    surface: 'iterm-pane',
    surfaceLifetime: 'close-on-exit',
    promptPrelude:
      'You are planning, not implementing. Write only the plan file named in your brief; Edit is ' +
      'denied and you must not modify existing files. You share this checkout, so never run a ' +
      'state-changing git command. The plan file is your deliverable: write it even if you get blocked.',
  },
]

/** Fields a profile file may not set, with why. Silently ignoring them would be worse. */
const FORBIDDEN_FIELDS: Record<string, string> = {
  permissionMode:
    'a profile widens a posture by naming tools, which is reviewable in a diff; a mode flag widens it by category, which is not',
  permission_mode: 'see permissionMode',
}

const LEAN_FLAGS = ['strictMcpConfig', 'disableSlashCommands'] as const

const leanFlags = (body: Record<string, unknown>): Partial<AgentProfile> =>
  Object.fromEntries(LEAN_FLAGS.filter(field => body[field] !== undefined).map(field => [field, body[field]]))

const isRole = (value: unknown): value is AgentRole => AGENT_ROLES.includes(value as never)

const CONTRACT_CHOICES = [...RETURN_CONTRACTS, 'none'] as const

const isContractChoice = (value: unknown): value is ReturnContract | 'none' =>
  CONTRACT_CHOICES.includes(value as never)

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(entry => typeof entry === 'string')

const isSettingSources = (value: unknown): value is SettingSource[] =>
  isStringArray(value) && value.every(entry => SETTING_SOURCES.includes(entry as never))

const isStringRecord = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every(entry => typeof entry === 'string')

/** Exhaustive over {@link AgentProfile}, so a new field fails to compile until it is listed here. */
const PROFILE_KEYS: Record<Exclude<keyof AgentProfile, 'warnings'>, true> = {
  name: true,
  description: true,
  harness: true,
  model: true,
  allowedTools: true,
  disallowedTools: true,
  isolation: true,
  surface: true,
  surfaceLifetime: true,
  role: true,
  remoteControl: true,
  returnContract: true,
  effort: true,
  cacheTtl: true,
  promptPrelude: true,
  mcpServers: true,
  strictMcpConfig: true,
  settingSources: true,
  disableSlashCommands: true,
  env: true,
}

const isHarness = (value: unknown): value is Harness => HARNESSES.includes(value as never)

/** CC-1516: a Claude model name means nothing to Codex, and a launch must never map it to some other model. */
const CLAUDE_MODEL = /^(?:opus|sonnet|haiku|fable)\b|^claude-/i

function harnessError(name: string, body: Record<string, unknown>): string | undefined {
  if (body.harness === undefined) return undefined
  if (!isHarness(body.harness)) return `${name}: "harness" must be one of ${HARNESSES.join(', ')}`
  if (body.harness === 'codex' && CLAUDE_MODEL.test(body.model as string))
    return `${name}: "model" ${JSON.stringify(body.model)} is a Claude model; a "harness": "codex" profile names a Codex model`
  return undefined
}

/** CC-1516: the capability a harness waits on before it can launch, or undefined once it can. */
const HARNESS_PENDING: Record<Harness, string | undefined> = {
  'claude-code': undefined,
  codex: 'the Codex launch plan (CC-1517)',
}

export const HARNESS_UNSUPPORTED = 'harness_unsupported'

/** The refusal for launching this profile, before any process, worktree or slot exists; undefined when it can launch. */
export function harnessRefusal(profile: AgentProfile): string | undefined {
  const harness = profile.harness ?? 'claude-code'
  const pending = HARNESS_PENDING[harness]
  if (pending === undefined) return undefined
  return `${HARNESS_UNSUPPORTED}: profile "${profile.name}" uses harness "${harness}", unsupported until ${pending}`
}

/** CC-558: a live profile listed tools under `denies`, which no field read, so the tools stayed reachable. */
const DENY_ALIAS = 'denies'

const unknownKeyWarnings = (file: string, body: Record<string, unknown>): string[] =>
  Object.keys(body)
    .filter(key => key !== DENY_ALIAS && !Object.hasOwn(PROFILE_KEYS, key))
    .map(key => `${file}: unknown key "${key}" is ignored; no AgentProfile field has that name`)

const APPROVE_DENY = 'Bash(agent-chat approve:*)'

/** A deny a file implies by denying `when`, unless it allows that pattern by name. */
interface DerivedDeny {
  deny: string
  when: string[]
  why: string
  /** Derived only for a worker-role file: a coordinator runs these verbs itself. */
  workersOnly?: true
}

const DERIVED_DENIES: DerivedDeny[] = [
  {
    // CC-558: `inbox --batch --answers` reaches approve and endorse through one door (CC-425).
    deny: 'Bash(agent-chat inbox:*)',
    when: [APPROVE_DENY, 'Bash(agent-chat endorse:*)'],
    why: 'the file denies approve or endorse, and inbox reaches both',
  },
  {
    // CC-169: a file that keeps the human's verbs from an agent keeps it from asking under a service label too.
    deny: 'Bash(agent-chat ask:*)',
    when: [APPROVE_DENY],
    why: 'the file denies approve, and ask puts a question to the human under a service label',
  },
  {
    // CC-951: `teleport request` sends a from="human" message, the same door `send` closes.
    deny: 'Bash(agent-chat teleport:*)',
    when: ['Bash(agent-chat send:*)'],
    why: 'the file denies send, and teleport request sends a message as the human',
  },
  {
    // CC-1083: `debug send` sends `human_send` on an unregistered connection, so it speaks as the human.
    deny: 'Bash(agent-chat debug send:*)',
    when: ['Bash(agent-chat send:*)'],
    why: 'the file denies send, and debug send sends a message as the human',
  },
  {
    // CC-1138: a kicked tick spawns, resumes and retires with the tick's authority, not the caller's.
    deny: 'Bash(agent-chat burndown:*)',
    when: ['Bash(agent-chat send:*)'],
    why: 'the file denies send, and the burndown verbs spawn and retire agents as the human',
    workersOnly: true,
  },
  {
    // CC-1138: the seat verbs spawn and retire seats, and the watchdog sends `human_send`.
    deny: 'Bash(agent-chat seats:*)',
    when: ['Bash(agent-chat send:*)'],
    why: 'the file denies send, and the seats verbs spawn seats and message them as the human',
    workersOnly: true,
  },
]

const needs = (
  { deny, when, workersOnly }: DerivedDeny,
  denied: string[],
  allowed: string[],
  role: unknown,
): boolean =>
  (workersOnly !== true || role !== 'coordinator') &&
  when.some(verb => denied.includes(verb)) &&
  !denied.includes(deny) &&
  !allowed.some(tool => tool.startsWith(deny.slice(0, deny.indexOf(':'))))

/** `disallowedTools` and its alias as one list, plus each derived deny the file needs. */
function fileDenies(file: string, body: Record<string, unknown>): { denied?: string[]; warnings: string[] } {
  const listed = [...((body.disallowedTools as string[]) ?? []), ...((body[DENY_ALIAS] as string[]) ?? [])]
  const denied = [...new Set(listed)]
  const added = DERIVED_DENIES.filter(rule => needs(rule, denied, body.allowedTools as string[], body.role))
  const warnings = added.map(({ deny, why }) => `${file}: "${deny}" is denied too; ${why}`)
  const named = body.disallowedTools !== undefined || body[DENY_ALIAS] !== undefined
  if (!named && added.length === 0) return { warnings }
  return { denied: [...denied, ...added.map(rule => rule.deny)], warnings }
}

/**
 * Validate a parsed profile file. Returns the profile or an explanatory error —
 * never a partially-trusted object, because a profile that half-loaded would
 * grant whatever its defaults happened to be.
 */
export function parseProfile(
  name: string,
  raw: unknown,
  file: string = `${name}.json`,
): AgentProfile | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: `${name}: not a JSON object` }
  const body = raw as Record<string, unknown>

  for (const [field, why] of Object.entries(FORBIDDEN_FIELDS))
    if (field in body) return { error: `${name}: "${field}" is not allowed — ${why}` }

  if (typeof body.model !== 'string' || body.model === '') return { error: `${name}: "model" is required` }
  const harness = harnessError(name, body)
  if (harness !== undefined) return { error: harness }
  if (!isStringArray(body.allowedTools))
    return { error: `${name}: "allowedTools" must be an array of strings` }
  if (body.disallowedTools !== undefined && !isStringArray(body.disallowedTools))
    return { error: `${name}: "disallowedTools" must be an array of strings` }
  if (body[DENY_ALIAS] !== undefined && !isStringArray(body[DENY_ALIAS]))
    return { error: `${name}: "${DENY_ALIAS}" must be an array of strings` }
  if (!ISOLATION_NAMES.includes(body.isolation as never))
    return { error: `${name}: "isolation" must be one of ${ISOLATION_NAMES.join(', ')}` }
  if (!SURFACE_NAMES.includes(body.surface as never))
    return { error: `${name}: "surface" must be one of ${SURFACE_NAMES.join(', ')}` }
  if (body.surfaceLifetime !== undefined && !SURFACE_LIFETIMES.includes(body.surfaceLifetime as never))
    return { error: `${name}: "surfaceLifetime" must be one of ${SURFACE_LIFETIMES.join(', ')}` }
  if (body.role !== undefined && !isRole(body.role))
    return { error: `${name}: "role" must be one of ${AGENT_ROLES.join(', ')}` }
  if (body.remoteControl !== undefined && typeof body.remoteControl !== 'boolean')
    return { error: `${name}: "remoteControl" must be true or false` }
  if (body.remoteControl === true && body.role !== 'coordinator')
    return {
      error: `${name}: "remoteControl" needs "role": "coordinator"; a worker profile cannot run with Remote Control`,
    }
  if (body.returnContract !== undefined && !isContractChoice(body.returnContract))
    return { error: `${name}: "returnContract" must be one of ${CONTRACT_CHOICES.join(', ')}` }
  if (body.effort !== undefined && !EFFORT_LEVELS.includes(body.effort as never))
    return { error: `${name}: "effort" must be one of ${EFFORT_LEVELS.join(', ')}` }
  if (body.cacheTtl !== undefined && !isCacheTtl(body.cacheTtl))
    return { error: `${name}: "cacheTtl" must be one of ${CACHE_TTLS.join(', ')}` }
  if (body.env !== undefined && !isStringRecord(body.env))
    return { error: `${name}: "env" must be an object whose values are all strings` }
  if (body.settingSources !== undefined && !isSettingSources(body.settingSources))
    return { error: `${name}: "settingSources" must be an array drawn from ${SETTING_SOURCES.join(', ')}` }
  for (const field of LEAN_FLAGS)
    if (body[field] !== undefined && typeof body[field] !== 'boolean')
      return { error: `${name}: "${field}" must be true or false` }

  const denies = fileDenies(file, body)
  const warnings = [...unknownKeyWarnings(file, body), ...denies.warnings]
  return {
    name,
    description: typeof body.description === 'string' ? body.description : '',
    ...(isHarness(body.harness) ? { harness: body.harness } : {}),
    model: body.model,
    allowedTools: body.allowedTools,
    ...(denies.denied === undefined ? {} : { disallowedTools: denies.denied }),
    isolation: body.isolation as AgentProfile['isolation'],
    surface: body.surface as AgentProfile['surface'],
    ...(body.surfaceLifetime === undefined
      ? {}
      : { surfaceLifetime: body.surfaceLifetime as SurfaceLifetime }),
    ...(isRole(body.role) ? { role: body.role } : {}),
    ...(body.remoteControl === true ? { remoteControl: true } : {}),
    ...(isContractChoice(body.returnContract) ? { returnContract: body.returnContract } : {}),
    ...(body.effort === undefined ? {} : { effort: body.effort as EffortLevel }),
    ...(isCacheTtl(body.cacheTtl) ? { cacheTtl: body.cacheTtl } : {}),
    promptPrelude: typeof body.promptPrelude === 'string' ? body.promptPrelude : '',
    ...(typeof body.mcpServers === 'object' && body.mcpServers !== null
      ? { mcpServers: body.mcpServers as Record<string, unknown> }
      : {}),
    ...(body.env === undefined ? {} : { env: body.env }),
    ...(body.settingSources === undefined ? {} : { settingSources: body.settingSources }),
    ...leanFlags(body),
    ...(warnings.length === 0 ? {} : { warnings }),
  }
}

const PROFILE_NAME_MAX = 128
const CONTROL = /[\u0000-\u001f\u007f]/

/** CC-1059: a name becomes a path under the profiles dir, so one that could leave it is refused. */
export function profileNameRefusal(name: string): string | undefined {
  const plain =
    name !== '' &&
    name.length <= PROFILE_NAME_MAX &&
    !/[/\\]/.test(name) &&
    !name.includes('..') &&
    !CONTROL.test(name)
  return plain ? undefined : `the profile name ${JSON.stringify(name)} is not a plain name`
}

/**
 * Resolve a profile BY NAME ONLY. A spawn request names a profile; it never
 * carries a profile body. That single rule is what keeps a spawn request from
 * being "execute arbitrary argv" with extra steps, so there is deliberately no
 * variant of this function that takes a profile object.
 */
export function loadProfile(name: string, dir: string = profilesDir()): AgentProfile | { error: string } {
  return loadProfileSource(name, dir).profile
}

/** `loadProfile`, plus the exact file text it parsed (absent for a builtin), so a check hashes what loaded. */
export function loadProfileSource(
  name: string,
  dir: string = profilesDir(),
): { profile: AgentProfile | { error: string }; source?: string } {
  const refused = profileNameRefusal(name)
  if (refused !== undefined) return { profile: { error: refused } }
  const file = path.join(dir, `${name}.json`)
  if (fs.existsSync(file)) {
    let source: string
    try {
      source = fs.readFileSync(file, 'utf8')
    } catch (err) {
      return { profile: { error: `${name}: cannot read ${file} (${(err as Error).message})` } }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(source)
    } catch (err) {
      return { profile: { error: `${name}: ${file} is not valid JSON (${(err as Error).message})` }, source }
    }
    const profile = parseProfile(name, parsed, file)
    return {
      profile: 'error' in profile ? profile : withWorkerConfigDenies(profile, path.dirname(dir)),
      source,
    }
  }

  const builtin = BUILTIN_PROFILES.find(p => p.name === name)
  if (builtin) return { profile: withWorkerConfigDenies(builtin, path.dirname(dir)) }
  return { profile: { error: unknownProfileError(name, dir) } }
}

const CONFIG_EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit']

/**
 * CC-1094: the edit-tool rules that keep a worker out of `<agentHome>/profiles`
 * and the top-level config json. A worker that rewrote either could drop every
 * other deny it carries. Empty for a home holding a comma, because deny lists
 * travel comma-joined and a split rule would deny the wrong thing.
 */
export function workerConfigDenies(agentHome: string): string[] {
  if (agentHome.includes(',')) return []
  const root = `/${path.resolve(agentHome)}`
  return [`${root}/profiles/**`, `${root}/*.json`].flatMap(target =>
    CONFIG_EDIT_TOOLS.map(tool => `${tool}(${target})`),
  )
}

/**
 * Every non-coordinator gets the rules, builtins included, and `allowedTools`
 * cannot opt out. Silent, unlike `DERIVED_DENIES`: no file can avoid them, so a
 * warning on every worker spawn would only be noise.
 */
function withWorkerConfigDenies(profile: AgentProfile, agentHome: string): AgentProfile {
  if (roleOf(profile) === 'coordinator') return profile
  const denied = profile.disallowedTools ?? []
  const rules = workerConfigDenies(agentHome)
  if (rules.length === 0) {
    const warning = `${profile.name}: agent-chat home ${agentHome} contains a comma, so no edit deny guards its profiles or config`
    return { ...profile, warnings: [...(profile.warnings ?? []), warning] }
  }
  const added = rules.filter(rule => !denied.includes(rule))
  return added.length === 0 ? profile : { ...profile, disallowedTools: [...denied, ...added] }
}

function unknownProfileError(name: string, dir: string): string {
  const listing = profileListing(dir)
  const known = 'names' in listing ? `known: ${listing.names.join(', ')}` : listing.error
  return `no profile named "${name}"; ${known}`
}

/** CC-1208: a missing dir is builtins only; any other listing failure is an error naming the dir, never a throw. */
function profileListing(dir: string): { names: string[] } | { error: string } {
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { error: `cannot list profiles in ${dir} (${(err as Error).message})` }
    }
    entries = []
  }
  const user = entries.filter(f => f.endsWith('.json')).map(f => path.basename(f, '.json'))
  return { names: [...new Set([...BUILTIN_PROFILES.map(p => p.name), ...user])].sort() }
}

export function listProfileNames(dir: string = profilesDir()): string[] {
  const listing = profileListing(dir)
  if ('error' in listing) throw new Error(listing.error)
  return listing.names
}

/** CC-163: fail closed, so a profile written before roles existed cannot spawn or take Remote Control. */
export const roleOf = (profile: AgentProfile): AgentRole => profile.role ?? 'worker'

/**
 * The role an `agent_spawned` row grants, read from the row so it survives the
 * agent's spawner. A row written before roles existed resolves its profile name
 * against the current set; an adopted session is a human's own and coordinates.
 */
export function recordedRole(
  meta: Record<string, string | undefined>,
  dir: string = profilesDir(),
): AgentRole {
  if (meta.origin === 'adopted') return 'coordinator'
  if (isRole(meta.role)) return meta.role
  if (meta.profile === undefined || meta.profile === '') return 'worker'
  const profile = loadProfile(meta.profile, dir)
  return 'error' in profile ? 'worker' : roleOf(profile)
}

const editDistance = (a: string, b: string): number => {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = row
  }
  return prev[b.length]!
}

/** Every profile name when `name` is omitted, else just that one; an unknown name throws naming close matches. */
export function selectProfileNames(name?: string): string[] {
  const all = listProfileNames()
  if (name === undefined || all.includes(name)) return name === undefined ? all : [name]
  const close = all.filter(n => n.includes(name) || name.includes(n) || editDistance(n, name) <= 2)
  const hint = close.length > 0 ? `Close matches: ${close.join(', ')}.` : `Available: ${all.join(', ')}.`
  throw new Error(`No profile "${name}". ${hint}`)
}
