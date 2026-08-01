import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * CC-63: the onboarding doc a fresh agent never got.
 *
 * A spawned agent starts from its brief and nothing else, so every brief written
 * so far has had to hand-describe the same orientation context — what the
 * initiative is, what is already decided, which files to read. That context
 * already exists on disk, written by the `active-work` tool: `brief.md`, the open
 * task list, and the session log. This module reads it and turns it into a block
 * that gets prepended to the brief, the way a human hands a new hire the
 * onboarding doc before the actual assignment.
 *
 * ## Reading another tool's files
 *
 * `active-work`'s layout is a dependency taken deliberately and kept shallow:
 * directory names, `brief.md`, `tasks/*.yml` and `sessions/*.md`. Nothing here
 * shells out to the CLI (the broker must not depend on another program being
 * installed to spawn an agent), and nothing here writes. When the layout moves,
 * this degrades to "no briefing found" and a warning on the spawn — never to a
 * failed spawn, because orientation is an improvement to a brief and not a
 * precondition for one.
 *
 * ## Which initiative (the decision CC-63 asked for)
 *
 * `cwd` does not map 1:1 to a slug — an agent is routinely spawned into a repo
 * (`~/projects/agent-chat`) from a coordinating session whose own directory is
 * the initiative (`.../active-work/claude-channels`). So:
 *
 * 1. **An explicit slug always wins.** `briefing: "claude-channels"` is the
 *    supported way to be sure, and the only form that can name an initiative
 *    neither party is sitting in.
 * 2. **`briefing: "auto"` resolves from the REQUESTER's directory first**, then
 *    from the spawn's target `cwd`. Requester-first is the decision: the
 *    coordinator is the party that knows which initiative the work belongs to,
 *    and its own cwd is usually the initiative directory itself, whereas the
 *    target cwd is usually a checkout that says nothing about why the work is
 *    happening.
 * 3. **Ambiguity refuses rather than guesses**, as a warning on an otherwise
 *    successful spawn. A confidently wrong onboarding doc is worse than none:
 *    the agent cannot tell it was handed the wrong initiative.
 *
 * Mapping a repo path back to an initiative through `artifacts.yml` was
 * considered and rejected — it records a repo per tracked branch, several
 * initiatives legitimately name the same repo, and the resolution it produces is
 * therefore ambiguous exactly when it would be relied on.
 */

/** Total budget for an injected briefing. Beyond this it stops being orientation. */
const BRIEFING_MAX = 9_000
const BRIEF_MAX = 4_000
const SESSION_MAX = 1_500
const MAX_TASKS = 25
const MAX_NOTES = 5

/** `auto` means "work it out from who asked and where they pointed". */
export const AUTO_BRIEFING = 'auto'

export interface BriefingRequest {
  /** A slug, or `auto`. */
  briefing: string
  /** The requesting session's own cwd, when it has a registry entry. */
  requesterCwd?: string
  /** Where the spawned agent will run. */
  targetCwd?: string
  root?: string
}

export type BriefingResult = { text: string; slug: string } | { warning: string }

/**
 * Where `active-work` keeps its initiatives. Mirrors `env-paths`, which is what
 * that tool uses — and which ignores `XDG_DATA_HOME` on macOS, so this does too.
 */
export const activeWorkRoot = (): string => {
  const override = process.env.AGENT_CHAT_ACTIVE_WORK_ROOT
  if (override) return override
  if (process.platform === 'darwin')
    return path.join(os.homedir(), 'Library', 'Application Support', 'active-work')
  if (process.platform === 'win32')
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'active-work')
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'active-work')
}

const isInitiative = (root: string, slug: string): boolean =>
  slug !== '' && !slug.startsWith('.') && fs.existsSync(path.join(root, slug, 'brief.md'))

/** The slug whose directory contains `dir`, if any. Never matches the root itself. */
const slugForPath = (dir: string | undefined, root: string): string | undefined => {
  if (dir === undefined) return undefined
  let real: string
  let realRoot: string
  try {
    real = fs.realpathSync(dir)
    realRoot = fs.realpathSync(root)
  } catch {
    return undefined
  }
  if (!real.startsWith(realRoot + path.sep)) return undefined
  const slug = real.slice(realRoot.length + 1).split(path.sep)[0]
  return slug !== undefined && isInitiative(root, slug) ? slug : undefined
}

const truncated = (body: string, max: number): string =>
  body.length <= max ? body : `${body.slice(0, max)}\n… (truncated)`

/** Drop YAML frontmatter, which is bookkeeping rather than orientation. */
const withoutFrontmatter = (text: string): string => {
  if (!text.startsWith('---\n')) return text
  const end = text.indexOf('\n---\n', 3)
  return end === -1 ? text : text.slice(end + 5)
}

/**
 * The top-level scalars of one task file.
 *
 * A deliberate three-field subset of YAML rather than a parser: task files are
 * machine-written and flat, and pulling in a YAML dependency to read `status`
 * would be a strange thing for the broker to carry. Continuation lines are
 * folded so a wrapped `title` survives; anything nested lands harmlessly in a
 * key nobody reads.
 */
const taskScalars = (text: string): Record<string, string> => {
  const out: Record<string, string> = {}
  let key: string | undefined
  for (const line of text.split('\n')) {
    const start = /^([A-Za-z_]+):[ ]?(.*)$/.exec(line)
    if (start?.[1] !== undefined) {
      key = start[1]
      out[key] = (start[2] ?? '').trim()
      continue
    }
    if (key !== undefined && /^\s+\S/.test(line)) out[key] = `${out[key]} ${line.trim()}`.trim()
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.replace(/^['"]|['"]$/g, '')]))
}

interface TaskLine {
  id: string
  title: string
  priority: number
}

const openTasks = (dir: string): TaskLine[] => {
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter(name => name.endsWith('.yml'))
  } catch {
    return []
  }
  const tasks: TaskLine[] = []
  for (const file of files) {
    let fields: Record<string, string>
    try {
      fields = taskScalars(fs.readFileSync(path.join(dir, file), 'utf8'))
    } catch {
      continue
    }
    if (fields.status !== 'open') continue
    tasks.push({
      id: fields.id ?? file.replace(/\.yml$/, ''),
      title: fields.title ?? '(untitled)',
      priority: Number.parseInt(fields.priority ?? '', 10) || Number.MAX_SAFE_INTEGER,
    })
  }
  return tasks.sort((a, b) => a.priority - b.priority)
}

/** Newest-first by filename, which `active-work` prefixes with the timestamp. */
const newestFiles = (dir: string, limit: number): string[] => {
  try {
    return fs
      .readdirSync(dir)
      .filter(name => name.endsWith('.md'))
      .sort()
      .reverse()
      .slice(0, limit)
  } catch {
    return []
  }
}

const readOr = (file: string, fallback: string): string => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return fallback
  }
}

const taskSection = (tasks: TaskLine[]): string => {
  if (tasks.length === 0) return '## Open tasks\n\nNone recorded.'
  const shown = tasks.slice(0, MAX_TASKS).map(task => `- ${task.id}: ${task.title}`)
  const more = tasks.length > MAX_TASKS ? `\n- … and ${tasks.length - MAX_TASKS} more` : ''
  return `## Open tasks (${tasks.length}, highest priority first)\n\n${shown.join('\n')}${more}`
}

const sessionSection = (dir: string): string => {
  const [newest, ...older] = newestFiles(dir, 3)
  if (newest === undefined) return ''
  const body = truncated(withoutFrontmatter(readOr(path.join(dir, newest), '')).trim(), SESSION_MAX)
  const earlier = older.length === 0 ? '' : `\n\nEarlier sessions on disk: ${older.join(', ')}`
  return `## Most recent session (${newest})\n\n${body}${earlier}`
}

const notesSection = (initiativeDir: string): string => {
  const dirs = [path.join(initiativeDir, 'notes'), path.join(initiativeDir, 'sources', 'notes')]
  const notes = dirs.flatMap(dir => newestFiles(dir, MAX_NOTES).map(name => path.join(dir, name)))
  if (notes.length === 0) return ''
  return `## Notes on disk (read the ones that touch your task)\n\n${notes
    .slice(0, MAX_NOTES)
    .map(file => `- ${file}`)
    .join('\n')}`
}

/** The whole orientation block for one initiative, or a reason there is none. */
export function briefingFor(slug: string, root = activeWorkRoot()): BriefingResult {
  const dir = path.join(root, slug)
  if (!isInitiative(root, slug))
    return { warning: `no active-work initiative "${slug}" under ${root}; spawned without a briefing` }

  const header =
    `# Orientation: active-work initiative "${slug}"\n\n` +
    'Injected automatically by `agent_spawn`. Your coordinator did not write this section — it is ' +
    `the initiative's own record, read from ${dir}. Treat the assignment below it as the actual task, ` +
    'and this as the context you would otherwise have had to be told.'

  const brief = truncated(withoutFrontmatter(readOr(path.join(dir, 'brief.md'), '')).trim(), BRIEF_MAX)
  const sections = [
    header,
    brief === '' ? '' : `## Brief (brief.md)\n\n${brief}`,
    taskSection(openTasks(path.join(dir, 'tasks'))),
    sessionSection(path.join(dir, 'sessions')),
    notesSection(dir),
  ].filter(section => section !== '')

  return { text: truncated(sections.join('\n\n'), BRIEFING_MAX), slug }
}

/** Resolve the requested briefing to a block of text, or to a reason there is none. */
export function resolveBriefing(req: BriefingRequest): BriefingResult {
  const root = req.root ?? activeWorkRoot()
  if (req.briefing !== AUTO_BRIEFING) return briefingFor(req.briefing, root)

  const slug = slugForPath(req.requesterCwd, root) ?? slugForPath(req.targetCwd, root)
  if (slug === undefined) {
    return {
      warning:
        'briefing: "auto" could not tell which active-work initiative this spawn belongs to — ' +
        'neither your directory nor the target cwd is inside one. Pass the slug explicitly ' +
        '(briefing: "<slug>") to inject one.',
    }
  }
  return briefingFor(slug, root)
}
