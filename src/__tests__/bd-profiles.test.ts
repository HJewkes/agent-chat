import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseProfile } from '../agents/profiles.js'
import { contractOf } from '../agents/return-contract.js'
import type { AgentProfile } from '../agents/types.js'

/**
 * Slice 4f follow-up: the shared `~/.claude/settings.json` allows `Bash(*)` with
 * no deny rules, so a burndown worker's confinement is entirely in its own
 * profile's `disallowedTools`. These tests pin the deny list rather than trust
 * the JSON files not to drift — a deny quietly dropped from one profile is
 * exactly the mutation that would let an unattended worker merge, publish, or
 * deploy.
 */

const PROFILES_DIR = path.join(__dirname, '../../profiles')

const WORKER_PROFILES = ['bd-implementer', 'bd-implementer-lite', 'bd-reviewer'] as const

function loadBdProfile(name: string): AgentProfile {
  const raw: unknown = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, `${name}.json`), 'utf8'))
  const profile = parseProfile(name, raw)
  if ('error' in profile) throw new Error(profile.error)
  return profile
}

/** Reserved for humans by the unlock table: never something an unattended worker may reach. */
const HUMAN_ONLY_ACTIONS = [
  'Bash(gh pr merge:*)',
  'Bash(gh pr review:*)',
  'Bash(gh api:*)',
  'Bash(gh release:*)',
  'Bash(gh repo:*)',
  'Bash(npm publish:*)',
  'Bash(npx changeset:*)',
  'Bash(wrangler:*)',
  'Bash(launchctl:*)',
  'Bash(agent-chat agent:*)',
  'Bash(agent-chat port:*)',
  'Bash(agent-chat service:*)',
  'Bash(agent-chat teleport:*)',
  'Bash(agent-chat debug send:*)',
  'Bash(agent-chat mirror:*)',
  'Bash(agent-chat lifecycle:*)',
  'Bash(agent-chat burndown:*)',
]

/** What a worker needs to land its own branch and open a PR; none of this may ever be denied. */
const WORKER_NEEDS = [
  'Bash(git fetch:*)',
  'Bash(git merge --ff-only:*)',
  'Bash(git add:*)',
  'Bash(git commit:*)',
  'Bash(git push -u origin agent-chat/bd-deny:*)',
  'Bash(npm run format:check)',
  'Bash(npm run typecheck)',
  'Bash(npm run build)',
  'Bash(npx vitest run)',
  'Bash(gh pr create:*)',
  'Bash(gh pr view:*)',
  'Bash(gh pr checks:*)',
]

/**
 * Claude Code 2.1.301's Bash rule matching, mirrored from its bundle (rule parse YMe, rule match
 * Kte, deny path mI):
 * - a rule ending `:*` is a prefix, followed by end-of-string or a single space;
 * - any other `*` becomes `.*` (dotAll) inside `^...$`, every other metacharacter escaped;
 * - runs of whitespace collapse to one space on both the rule and the command;
 * - a rule whose only `*` is a trailing ` *` makes that tail optional, `( .*)?`;
 * - deny also tries the rule as `xargs <rule>`;
 * - deny checks the whole compound string and each sub-command split on `&&`, `||`, `;` and `|`;
 * - the command is matched as typed: quotes, backslashes and expansions are not stripped;
 * - `\\` in a rule reads as one backslash, and then `\*` is a literal star and `\\` a literal
 *   backslash, so a rule needs `\\\\` to match one backslash in the command (CC-1425, observed
 *   live in 2.1.310).
 * Because `*` spans `&&`, `;` and `|`, a push rule with a `*` also denies a compound such as
 * `git push origin x && rm -f f`; agents push as their own Bash call.
 */
const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()

const unescapeRule = (body: string): string => body.replace(/\\\\/g, '\\')

const GLOB_TOKEN = /(\\\*|\\\\|\*)/
const REGEX_OF_GLOB_TOKEN = new Map([
  ['*', '.*'],
  ['\\*', '\\*'],
  ['\\\\', '\\\\'],
])

const globToRegex = (source: string): string =>
  source
    .split(GLOB_TOKEN)
    .map(part => REGEX_OF_GLOB_TOKEN.get(part) ?? part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('')

function matchesPattern(body: string, command: string): boolean {
  if (body.endsWith(':*')) {
    const prefix = body.slice(0, -2)
    return command === prefix || command.startsWith(`${prefix} `)
  }
  const lonelyTail = body.endsWith(' *') && body.indexOf('*') === body.length - 1
  const source = lonelyTail ? body.slice(0, -2) : body
  return new RegExp(`^${globToRegex(source)}${lonelyTail ? '( .*)?' : ''}$`, 's').test(command)
}

function ruleMatches(rule: string, command: string): boolean {
  const body = /^Bash\((.*)\)$/.exec(rule)?.[1]
  if (body === undefined) return false
  const pattern = unescapeRule(collapse(body))
  return matchesPattern(pattern, command) || matchesPattern(`xargs ${pattern}`, command)
}

const isDenied = (command: string, denied: string[]): boolean => {
  const whole = collapse(command)
  const parts = whole.split(/&&|\|\||;|\|/).map(collapse)
  return [whole, ...parts].some(text => denied.some(rule => ruleMatches(rule, text)))
}

const GIT_FORMS = [
  'git push',
  'git -C /tmp/work push',
  'git -c k=v push',
  'git --git-dir=/tmp/work/.git push',
  'git --no-pager push',
]

const FORCE_SPELLINGS = [
  '--force-with-lease=agent-chat/x origin agent-chat/x',
  '--force-with-lease=agent-chat/x:0123abc origin agent-chat/x',
  'origin --force-with-lease=agent-chat/x agent-chat/x',
  'origin --force-with-lease=agent-chat/x:0123abc agent-chat/x',
  '-u origin --force-with-lease=agent-chat/x:0123abc agent-chat/x',
  '--set-upstream origin --force-with-lease=agent-chat/x agent-chat/x',
  'origin agent-chat/x --force-with-lease=agent-chat/x:0123abc',
  '--force-if-includes origin agent-chat/x',
  'origin --force-if-includes agent-chat/x',
  '-u origin --force-if-includes agent-chat/x',
  'origin agent-chat/x --force-if-includes',
  '--mirror origin',
  'origin --mirror',
  '-u origin --mirror',
  '-fu origin agent-chat/x',
  '-uf origin agent-chat/x',
  '-vf origin agent-chat/x',
  '-qf origin agent-chat/x',
  '-nf origin agent-chat/x',
  'origin -fu agent-chat/x',
  '-u origin -vf agent-chat/x',
  'origin agent-chat/x -f',
  'origin agent-chat/x -fu',
  'origin +HEAD:agent-chat/x',
  'origin +agent-chat/x',
  '-u origin +agent-chat/x',
  '--set-upstream origin +HEAD:agent-chat/x',
  'origin agent-chat/x +agent-chat/y',
  'origin agent-chat/x --force',
  'origin agent-chat/x --force --no-verify',
  'origin agent-chat/x --force-with-lease',
  'origin agent-chat/x --force-with-lease --no-verify',
]

const GLOBAL_OPTION_FORCES = [
  '--force origin agent-chat/x',
  '--force-with-lease origin agent-chat/x',
  'origin --force agent-chat/x',
  'origin --force-with-lease agent-chat/x',
  '-u origin --force agent-chat/x',
  'origin agent-chat/x --force',
]

const PROTECTED_BRANCH_PUSHES = [
  'origin main',
  'origin master',
  '-u origin main',
  '-u origin master',
  '--set-upstream origin main',
  '--set-upstream origin master',
  'origin HEAD:main',
  'origin HEAD:master',
  'origin :main',
  'origin :master',
  'origin main --no-verify',
  'origin HEAD:main --no-verify',
]

// The `:branch` rules end `:**`, because a rule ending `:*` is read as a prefix, not a glob.
const DELETE_PRUNE_PUSHES = [
  '--delete origin agent-chat/x',
  '-u origin --delete agent-chat/x',
  'origin agent-chat/x --delete',
  'origin --delete agent-chat/x',
  '-d origin agent-chat/x',
  'origin -d agent-chat/x',
  'origin agent-chat/x -d',
  '-ud origin agent-chat/x',
  'origin -vd agent-chat/x',
  'origin :agent-chat/x',
  'origin agent-chat/y :agent-chat/x',
  '--prune origin',
  'origin --prune',
  'origin agent-chat/x --prune',
]

// git 2.53 takes any unambiguous prefix of a long option. The shortest it accepts are `--de`,
// `--force` (`--forc` and `--force-` are ambiguous), `--pru` and `--m`, so the rules anchor
// there after a space and no branch name is touched.
const ABBREVIATED_PUSHES = [
  '--de origin agent-chat/x',
  '--del origin agent-chat/x',
  '--delet origin agent-chat/x',
  'origin --de agent-chat/x',
  '-u origin --dele agent-chat/x',
  'origin agent-chat/x --de',
  '--force-w origin agent-chat/x',
  '--force-with origin agent-chat/x',
  '--force-with-leas origin agent-chat/x',
  'origin --force-w agent-chat/x',
  'origin --force-w=agent-chat/x agent-chat/x',
  '-u origin --force-w agent-chat/x',
  'origin agent-chat/x --force-w',
  '--force-i origin agent-chat/x',
  'origin --force-if agent-chat/x',
  'origin agent-chat/x --force-i',
  '--pru origin',
  '--prun origin',
  'origin --pru',
  'origin agent-chat/x --prun',
  '--m origin',
  '--mi origin',
  'origin --mirr',
  '-u origin --mir',
  'origin agent-chat/x --m',
]

// A destination is main when it is a whole word after a space (`-- main`, `-v origin main`),
// follows a colon (`<src>:main`), or ends `heads/main` (git resolves `HEAD:heads/main` to main).
const mainDestinationPushes = (branch: string): string[] => [
  `origin agent-chat/x:${branch}`,
  `origin HEAD^0:${branch}`,
  `origin ${branch}:${branch}`,
  `origin HEAD:refs/heads/${branch}`,
  `origin HEAD:heads/${branch}`,
  `origin refs/heads/${branch}`,
  `origin -- ${branch}`,
  `-- origin ${branch}`,
  `--set-u origin ${branch}`,
  `--no-verify origin ${branch}`,
  `-v origin ${branch}`,
  `-q origin ${branch}`,
  `-o x origin ${branch}`,
  `--push-option=x origin ${branch}`,
  `-v origin agent-chat/x:${branch}`,
  `origin agent-chat/y agent-chat/x:${branch}`,
  `origin agent-chat/x:${branch} --no-verify`,
  `-v origin ${branch} --no-verify`,
  `origin HEAD:refs/heads/${branch} -v`,
  `origin HEAD:heads/${branch} --no-verify`,
]
const MAIN_DESTINATION_PUSHES = [...mainDestinationPushes('main'), ...mainDestinationPushes('master')]

// `*` spans `&&`, `;` and `|`, so these ordinary commands are denied. Kept: a rule shape that
// stops at a separator would also stop denying the force spellings the rows above pin.
const COMPOUND_OVERMATCHES = [
  'git push origin agent-chat/x && rm -f f',
  'git push origin agent-chat/x && gh pr create -f',
  'git push origin agent-chat/x && date +%s',
  'git push origin agent-chat/x; git commit -m "fix -f"',
  // The main and master rules match the word anywhere after the push, so a later command that
  // names main is denied too.
  'git push -u origin agent-chat/x && gh pr create --base main --title t',
  'git push -u origin agent-chat/x 2>&1 | grep -v main',
  'git push -u origin agent-chat/x && git fetch origin main',
]

// bash strips the quotes, the backslash and the expansion, so each of these really pushes. The
// older `git * push` rules catch them; the newer main and master rules start `git -* push` and
// do not.
const QUOTED_GLOBAL_OPTION_PUSHES = [
  'git "-C" x push origin main',
  'git "-C" x push origin HEAD:main',
  'git "-C" x push --force origin x',
  "git '-c' k=v push --force origin x",
  'git \\-C x push --force origin x',
  'git $G push --force origin x',
  // CC-1425: a git whose first word is quoted, escaped, expanded or a glob is denied any push.
  'git "-C" x push origin "--de" y',
  "git '-C' x push origin --d\\e y",
  'git \\-C x push origin "-f" y',
  'git $G push origin "--de" y',
  'git `echo -C` x push origin "--de" y',
  'git {-C,x} push origin "--de" y',
  'git [-]C x push origin ?-de y',
  'git ?C x push origin [-]-de y',
]

// CC-1425: bash strips each quote, backslash, expansion and glob before git reads the option or
// ref, and the quote may sit anywhere inside the word, so a push holding any of `"`, `'`, `\`,
// `$`, a backtick, `{`, `[` or `?` is denied outright. Each form below printed [deleted] or
// pushed in a scratch repo.
const QUOTED_PUSHES = [
  'origin "--de" x',
  "origin '--de' x",
  'origin --d\\e x',
  "$'--de' origin x",
  '"-f" origin x',
  '"--force" origin x',
  'origin "--force-w" x',
  "'-d' origin x",
  'origin "--m"',
  "origin '--m'",
  'origin "--pru"',
  "origin '--pru'",
  'origin --"de" x',
  'origin -"-de" x',
  "origin --d''e x",
  'origin $"--de" x',
  'origin `cat f` x',
  'origin $(cat f) x',
  'origin $D x',
  'origin {--de,x}',
  'origin [-]-de x',
  'origin ?-de x',
  'origin "+x"',
  'origin "main"',
  "origin 'HEAD:main'",
  'origin ma\\in',
]

// CC-1618: every push rule anchors on a literal ` push`, but bash also strips quotes, backslashes
// and globs inside the subcommand word itself. Each word below reaches git as `push`; three of them
// deleted a scratch branch past main's rules in a live 2.1.310 run.
const GLOBAL_PRELUDES = GIT_FORMS.slice(1).map(form => form.replace(/ push$/, ''))

const QUOTED_SUBCOMMANDS = [
  '"push"',
  "'push'",
  '""push',
  '"p"ush',
  '"pu"sh',
  '"pus"h',
  "''push",
  "'p'ush",
  "'pu'sh",
  "'pus'h",
  '\\push',
  'p\\ush',
  'pu\\sh',
  'pus\\h',
  'p"ush"',
  "pu'sh'",
  'pus"h"',
  'push""',
  "push''",
  "$'push'",
  '$"push"',
  "pu$'s'h",
  'push${X}',
  '{push,}',
  '{,push}',
  '[p]ush',
  '?ush',
  'p?sh',
  'pu[s]h',
]

// Without a global option the subcommand is the first word, so any expansion there is denied too.
const EXPANDED_FIRST_WORDS = ['$P', '${P}', '$(echo push)', '`echo push`', '{p,}ush', 'p{u,}sh']

// A bare `*` expands to every file in the directory, a file named `--delete` included. A rule
// names a literal star as `\*`, which 2.1.310 matched live.
const GLOBBED_PUSHES = ['origin x *', 'origin * x', '-u origin *']

// The global-option rules span the whole line, so a later quoted word that spells the start of
// push is denied too.
const QUOTED_SUBCOMMAND_OVERMATCHES = [
  'git -C x log --grep "push"',
  "git -C x commit -m 'push fix'",
  'git -C x commit -m "Fix [x]"',
  'git -C x commit -m "why ?"',
]

// The quote rules have no word boundary, so a quoted branch, an expansion, or a later command in
// the same call is denied too. Agents push a literal branch name as their own Bash call.
const QUOTED_OVERMATCHES = [
  'git push -u origin "$(git branch --show-current)"',
  'git push -u origin "agent-chat/x"',
  'git push -u origin agent-chat/x && gh pr create --title "t"',
  'git push -u origin agent-chat/x; echo $?',
]

const LEGITIMATE_PUSHES = [
  'origin agent-chat/x --no-verify',
  'origin agent-chat/fix-f',
  'origin agent-chat/c++',
  'origin agent-chat/force-x',
  'origin agent-chat/main-fix',
  'origin HEAD:agent-chat/main',
  'origin agent-chat/x',
  '-u origin agent-chat/x',
  '--set-upstream origin agent-chat/x',
  'origin HEAD:agent-chat/x',
  'origin agent-chat/fix-force-with-lease',
  'origin de',
  'origin dev-x',
  'origin delete-x',
  '-u origin de/x',
  'origin pr-x',
  'origin prune-x',
  'origin HEAD:pru-x',
  'origin mi',
  'origin mirror-x',
  '-u origin m/x',
  'origin agent-chat/x:de-x',
  'origin agent-chat/x--de',
  'origin HEAD:agent-chat/main-fix',
  'origin agent-chat/x:agent-chat/main',
  'origin agent-chat/x:agent-chat/master',
  'origin maintenance',
  'origin mainline-notes',
  'origin HEAD:mainline-notes',
  '-v origin agent-chat/main',
  'origin main:agent-chat/x',
  'origin -- agent-chat/x',
]

// The main and master rules start `git -* push`, since every git global option starts with `-`,
// so a plain subcommand whose message or pattern says push and main is not read as a push.
const LEGITIMATE_COMMANDS = [
  'git push -u origin agent-chat/x && gh pr create --draft --title t',
  'git commit -m "a push b main c"',
  'git log --grep "push main"',
  'git log --grep "push origin HEAD:main --force"',
  'git push -u origin agent-chat/x && gh pr create',
  'git push -u origin agent-chat/x && npm run verify',
  'git push -u origin agent-chat/x 2>&1 | tail -5',
  'git -C /tmp/work push -u origin agent-chat/x',
  'git commit -m "a push \'b\' c"',
  'git -C "$dir" log --oneline',
  // The quote rules for a global option look only after `push`, so the prelude's quoted -C works.
  'git -C "$dir" push -u origin agent-chat/x',
  'git -C "$dir" add "packages/x.ts"',
  'git -C "$dir" commit -m "Deny quoted push"',
  'git -C "$dir" commit -m "Pin {x} rows"',
  'git -C "$dir" commit -m "Fix `git push` docs"',
  'git -C "$dir" commit -m "cost $5"',
  'git pull --ff-only origin main',
  'git commit -m "Fix `git push` [x] {y} ?"',
  'git add src/*.ts',
]

// The older `git * push` rules read any later ` push ` as the subcommand, and a global option
// before any subcommand reaches `git -* push`, so these non-push lines are denied.
const SUBCOMMAND_OVERMATCHES = [
  'git commit -m "a push origin main c"',
  'git -C x commit -m "a push b main c"',
  'git -C x commit -m "no push --force here"',
]

describe.each(WORKER_PROFILES)('the %s profile', name => {
  const profile = loadBdProfile(name)
  const denied = profile.disallowedTools ?? []

  it('reserves every unlock-table action for humans', () => {
    expect(denied).toEqual(expect.arrayContaining(HUMAN_ONLY_ACTIONS))
  })

  it('denies pushing to main or master, however the push is spelled', () => {
    expect(denied).toEqual(
      expect.arrayContaining([
        'Bash(git push origin main:*)',
        'Bash(git push origin master:*)',
        'Bash(git push -u origin main:*)',
        'Bash(git push -u origin master:*)',
        'Bash(git push origin HEAD:main:*)',
        'Bash(git push origin HEAD:master:*)',
      ]),
    )
  })

  it('denies force pushes in every flag spelling', () => {
    expect(denied).toEqual(
      expect.arrayContaining([
        'Bash(git push -f:*)',
        'Bash(git push --force:*)',
        'Bash(git push --force-with-lease:*)',
      ]),
    )
  })

  it.each(FORCE_SPELLINGS)('denies the force push `git push %s`', tail => {
    for (const git of GIT_FORMS) expect(isDenied(`${git} ${tail}`, denied)).toBe(true)
  })

  it.each([...GLOBAL_OPTION_FORCES, ...DELETE_PRUNE_PUSHES, ...PROTECTED_BRANCH_PUSHES])(
    'denies `git push %s` under every global option',
    tail => {
      for (const git of GIT_FORMS) expect(isDenied(`${git} ${tail}`, denied)).toBe(true)
    },
  )

  it.each(ABBREVIATED_PUSHES)('denies the abbreviated `git push %s` under every global option', tail => {
    for (const git of GIT_FORMS) expect(isDenied(`${git} ${tail}`, denied)).toBe(true)
  })

  it.each(QUOTED_GLOBAL_OPTION_PUSHES)('denies `%s`, whose quoting bash strips', command => {
    expect(isDenied(command, denied)).toBe(true)
  })

  it.each(QUOTED_PUSHES)('denies the quoted `git push %s` under every global option', tail => {
    for (const git of GIT_FORMS) expect(isDenied(`${git} ${tail}`, denied)).toBe(true)
  })

  it.each(QUOTED_SUBCOMMANDS)('denies `git %s origin --delete x` under every global option', word => {
    for (const git of ['git', ...GLOBAL_PRELUDES]) {
      expect(isDenied(`${git} ${word} origin --delete x`, denied)).toBe(true)
    }
  })

  it.each(EXPANDED_FIRST_WORDS)('denies `git %s origin --delete x`', word => {
    expect(isDenied(`git ${word} origin --delete x`, denied)).toBe(true)
  })

  it.each(GLOBBED_PUSHES)('denies the globbed `git push %s` under every global option', tail => {
    for (const git of GIT_FORMS) expect(isDenied(`${git} ${tail}`, denied)).toBe(true)
  })

  it.each(QUOTED_SUBCOMMAND_OVERMATCHES)('knowingly denies `%s`', command => {
    expect(isDenied(command, denied)).toBe(true)
  })

  it.each(QUOTED_OVERMATCHES)('knowingly denies the quoted `%s`', command => {
    expect(isDenied(command, denied)).toBe(true)
  })

  it.each(MAIN_DESTINATION_PUSHES)('denies `git push %s`, whose destination is protected', tail => {
    for (const git of GIT_FORMS) expect(isDenied(`${git} ${tail}`, denied)).toBe(true)
  })

  it('denies a force push piped through xargs', () => {
    expect(isDenied('echo origin | xargs git push --force', denied)).toBe(true)
  })

  it.each(COMPOUND_OVERMATCHES)('knowingly denies the compound `%s`', command => {
    expect(isDenied(command, denied)).toBe(true)
  })

  it.each(LEGITIMATE_PUSHES)('still allows `git push %s`', tail => {
    for (const git of GIT_FORMS) expect(isDenied(`${git} ${tail}`, denied)).toBe(false)
  })

  it.each(SUBCOMMAND_OVERMATCHES)('knowingly denies `%s`', command => {
    expect(isDenied(command, denied)).toBe(true)
  })

  it.each(LEGITIMATE_COMMANDS)('still allows `%s`', command => {
    expect(isDenied(command, denied)).toBe(false)
  })

  it('denies deleting a remote branch', () => {
    expect(denied).toEqual(expect.arrayContaining(['Bash(git push --delete:*)']))
  })

  it('does not deny anything a worker legitimately needs to land a branch or open a PR', () => {
    for (const need of WORKER_NEEDS) expect(denied).not.toContain(need)
    // The broad denial a naive fix would reach for — it would also block the
    // worker's own `git push -u origin agent-chat/*`.
    expect(denied).not.toContain('Bash(git push:*)')
  })
})

// CC-1425: Claude Code 2.1.310's decision on `git push o --d\e y` for each rule, run headless with
// the rule in --disallowed-tools and `Bash(git push:*)` allowed.
describe('the matcher mirror on backslashes in a rule', () => {
  const command = 'git push o --d\\e y'

  it.each(['Bash(git push o *\\*)', 'Bash(git push o *\\\\*)'])('lets %s through, as live', rule => {
    expect(isDenied(command, [rule])).toBe(false)
  })

  it.each(['Bash(git push o *\\\\\\*)', 'Bash(git push o *\\\\\\\\*)', 'Bash(git push o *\\e*)'])(
    'denies with %s, as live',
    rule => {
      expect(isDenied(command, [rule])).toBe(true)
    },
  )

  // CC-1618: live, this rule denied `git push origin z *` and allowed `git push -u origin HEAD:x`.
  it('reads `\\*` as a literal star, as live', () => {
    expect(isDenied('git push origin z *', ['Bash(git push *\\**)'])).toBe(true)
    expect(isDenied('git push -u origin HEAD:x', ['Bash(git push *\\**)'])).toBe(false)
  })
})

describe('the bd-reviewer profile', () => {
  const profile = loadBdProfile('bd-reviewer')

  it('denies git stash, Monitor and ScheduleWakeup', () => {
    expect(profile.disallowedTools).toEqual(
      expect.arrayContaining(['Bash(git stash:*)', 'Monitor', 'ScheduleWakeup']),
    )
  })

  it('pins the prompt cache TTL to five minutes', () => {
    expect(profile.env).toEqual({ CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' })
  })

  // Mutation caught: `returnContract: "none"`, or granting Edit so the name rule yields none.
  it('takes the reviewer return contract', () => {
    expect(contractOf(profile)).toBe('reviewer')
  })
})

// CC-1083. Mutation caught: deleting the literal line from a shipped file, which then loads only by
// the derived deny and warns about it on every spawn.
describe('debug send on every shipped profile that denies send', () => {
  const shipped = fs
    .readdirSync(PROFILES_DIR)
    .filter(file => file.endsWith('.json'))
    .map(file => file.replace(/\.json$/, ''))
  const deniesSend = shipped.filter(name =>
    (loadBdProfile(name).disallowedTools ?? []).includes('Bash(agent-chat send:*)'),
  )

  it('covers the burndown, decider and triager profiles', () => {
    expect(deniesSend).toEqual(
      expect.arrayContaining([...WORKER_PROFILES, 'bd-planner', 'decider', 'triager']),
    )
  })

  it.each(deniesSend)('%s denies it outright and loads with no warning about it', name => {
    const profile = loadBdProfile(name)
    const denied = profile.disallowedTools ?? []

    expect(isDenied('agent-chat debug send alice hi', denied)).toBe(true)
    expect(isDenied('agent-chat debug history', denied)).toBe(false)
    expect(profile.warnings ?? []).not.toContainEqual(expect.stringContaining('debug send'))
  })
})

describe('the bd-planner profile', () => {
  const profile = loadBdProfile('bd-planner')
  const denied = profile.disallowedTools ?? []

  it('keeps its existing blanket git push deny, since it shares the checkout and never pushes', () => {
    expect(denied).toContain('Bash(git push:*)')
  })

  it('reserves every unlock-table action for humans, same as the worker profiles', () => {
    expect(denied).toEqual(expect.arrayContaining(HUMAN_ONLY_ACTIONS))
  })

  it('can still write its plan file and run tests', () => {
    expect(denied).not.toContain('Bash(npm run:*)')
    expect(denied).not.toContain('Bash(npx vitest:*)')
  })
})
