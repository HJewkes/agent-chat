import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkCommand, checkToolCall, REASONS, type GuardContext } from '../leak-guard/pretool.js'

// Synthetic only.
const ENV = { HOME: '/srv/agent', PATH: '/usr/local/bin:/usr/bin:/bin' }

const ctx = (env: Record<string, string> = ENV): GuardContext => ({
  terms: { kind: 'ok', rules: [] },
  cwd: '/work',
  env,
  protectedPaths: [],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
  readGhAliases: () => ({
    kind: 'ok',
    aliases: new Map([['sg', { shell: false, body: 'pr view 1' }]]),
  }),
})

const SNAPSHOT = '/srv/agent/.claude-profiles/agents/shell-snapshots/snapshot-zsh-1.sh'

const edit = (file: string, env: Record<string, string> = ENV, tool = 'Edit') =>
  checkToolCall(tool, { file_path: file, content: 'export FOO=1\n' }, ctx(env))

describe('a Bash line that names a file a later shell sources is left to the runtime check (TP-4232, TP-4256)', () => {
  it.each([
    'cat ~/.bashrc',
    'cat ~/.zshrc 2>/dev/null || true',
    'grep x ~/.zshrc 2>&1 | head -5',
    'ls ~/.claude-profiles/agents/shell-snapshots',
    'test -f ~/.zshenv && echo y',
    'echo "$CLAUDE_ENV_FILE"',
  ])('allows %s, a plain read (row 20)', command => {
    expect(checkCommand(command, ctx())).toBeUndefined()
  })

  it.each([
    'gh auth setup-git',
    'echo "$PATH"',
    'gh sg',
    'gcloud auth login',
    'echo auth setup-git',
    'bash scripts/build.bash',
  ])('allows %s, which names no sourced file (row 21)', command => {
    expect(checkCommand(command, ctx())).toBeUndefined()
  })

  it.each([
    `echo 'export FOO=1' >> "$CLAUDE_ENV_FILE"`,
    `printf 'export FOO=1\\n' >> ~/.bashrc`,
    `echo 'alias ll="ls -l"' >> ~/.bashrc`,
    `cat >> ~/.zshenv <<'EOF'\nexport FOO=1\nEOF`,
    'grep alias ~/.zshrc > /tmp/aliases.txt',
    'rg CLAUDE_ENV_FILE src',
    `git commit -m 'fix .zshrc'`,
  ])('allows %s, since no Bash-line rule judges writes to these files (row 22)', command => {
    expect(checkCommand(command, ctx())).toBeUndefined()
  })
})

describe('the Edit tools on a file a later shell sources are owner-only (TP-4232)', () => {
  it.each([
    { file: '/srv/agent/.bashrc', tool: 'Write' },
    { file: '/srv/agent/.zshenv', tool: 'Edit' },
    { file: '/srv/agent/env.sh', tool: 'MultiEdit' },
    { file: '/srv/agent/.claude/session-env/s1/sessionstart-hook-0.sh', tool: 'Write' },
    { file: '/srv/agent/.ZSHRC', tool: 'NotebookEdit' },
  ])('denies the $tool tool on $file (row 4)', ({ file, tool }) => {
    expect(edit(file, { ...ENV, CLAUDE_ENV_FILE: '/srv/agent/env.sh' }, tool)).toBe(
      REASONS.ghHelperEnvFileEdit,
    )
  })

  it.each(['Write', 'Edit'])(
    'denies the %s tool on a shell snapshot the Bash tool sources (row 12)',
    tool => {
      expect(edit(SNAPSHOT, ENV, tool)).toBe(REASONS.ghHelperEnvFileEdit)
    },
  )

  it.each(['BASH_ENV', 'ENV'])('denies an Edit on the absolute file the hook names in %s', name => {
    expect(edit('/work/../srv/rc', { ...ENV, [name]: '/srv/rc' })).toBe(REASONS.ghHelperEnvFileEdit)
  })

  it.each([
    { name: 'ENV', value: 'dev', file: 'src/dev/x.ts' },
    { name: 'BASH_ENV', value: 'rc', file: 'rc' },
    { name: 'BASH_ENV', value: '/srv/rc', file: '/srv/rc.d/x' },
    { name: 'CLAUDE_ENV_FILE', value: '/srv/e', file: '/srv/e2' },
  ])(
    'allows an Edit on $file with $name=$value, which is no exact absolute match',
    ({ name, value, file }) => {
      expect(edit(file, { ...ENV, [name]: value })).toBeUndefined()
    },
  )

  it('allows the Write tool on a file no shell sources', () => {
    expect(edit('/work/build.bash', ENV, 'Write')).toBeUndefined()
  })
})

describe('the Edit tools match a sourced file by its real path (TP-4232)', () => {
  const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-env-files-')))
  const home = path.join(ROOT, 'home')
  const scratch = path.join(ROOT, 'scratch')
  fs.mkdirSync(home)
  fs.mkdirSync(scratch)
  fs.writeFileSync(path.join(home, '.zshenv'), '')
  fs.writeFileSync(path.join(home, 'rc'), '')
  fs.symlinkSync(path.join(home, '.zshenv'), path.join(scratch, 'link'))
  fs.symlinkSync(path.join(home, '.zlogin'), path.join(scratch, 'dangling'))
  fs.symlinkSync(path.join(home, 'rc'), path.join(scratch, 'rc-link'))
  fs.symlinkSync(home, path.join(scratch, 'dir'))
  afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }))

  it('denies an Edit on a scratch symlink pointing at the synthetic ~/.zshenv', () => {
    expect(edit(path.join(scratch, 'link'))).toBe(REASONS.ghHelperEnvFileEdit)
  })

  it('denies a Write through a dangling symlink to an absent ~/.zlogin, which the write creates', () => {
    expect(edit(path.join(scratch, 'dangling'), ENV, 'Write')).toBe(REASONS.ghHelperEnvFileEdit)
  })

  it('denies an Edit on a symlink to the hook BASH_ENV file', () => {
    expect(edit(path.join(scratch, 'rc-link'), { ...ENV, BASH_ENV: path.join(home, 'rc') })).toBe(
      REASONS.ghHelperEnvFileEdit,
    )
  })

  it('denies an Edit on the hook BASH_ENV file named through a symlinked directory', () => {
    expect(edit(path.join(home, 'rc'), { ...ENV, BASH_ENV: path.join(scratch, 'dir', 'rc') })).toBe(
      REASONS.ghHelperEnvFileEdit,
    )
  })

  it('allows an Edit on a file in the symlinked directory that no shell sources', () => {
    expect(edit(path.join(scratch, 'dir', 'notes.txt'))).toBeUndefined()
  })
})

describe('GH_CONFIG_DIR, XDG_CONFIG_HOME or HOME carried to a gh alias by a wrapper (TP-4232 row 18)', () => {
  it.each([
    `unset GH_CONFIG_DIR; GH_CONFIG_DIR=/opt/c bash -c 'gh sg'`,
    'unset GH_CONFIG_DIR; function f { gh sg; }; GH_CONFIG_DIR=/opt/c f',
    'unset GH_CONFIG_DIR; GH_CONFIG_DIR=/opt/c eval gh sg',
    `unset XDG_CONFIG_HOME; XDG_CONFIG_HOME=/opt/c bash -c 'gh sg'`,
    `export HOME=/srv/agent; HOME=/opt/h bash -c 'gh sg'`,
  ])('denies %s, though the exports hold the hook value', command => {
    expect(checkCommand(command, ctx())).toBe(REASONS.ghAliasEnv)
  })

  it.each(['gh sg', 'echo "$HOME"; gh sg'])('allows %s', command => {
    expect(checkCommand(command, ctx())).toBeUndefined()
  })
})

describe('a renamed copy of gh writing its own path as the credential helper (TP-4232 rows 3, 19)', () => {
  it.each([
    './x auth setup-git',
    `cp "$(command -v gh)" ./x; ./x auth setup-git`,
    'x auth setup-git --hostname github.com',
    'x auth --with-token login',
    'x auth login --git-protocol https',
    './x auth "$SUB"',
    './grep auth setup-git',
    'grep auth setup-git',
  ])('denies %s', command => {
    expect(checkCommand(command, ctx())).toBe(REASONS.ghRenamed)
  })

  it.each([
    './x sg',
    'cp "$(command -v gh)" ./x; ./x sg',
    'GH_CONFIG_DIR=/opt/c ./x a setup-git',
    'XDG_CONFIG_HOME=/opt/c ./x a',
    'export GH_CONFIG_DIR=/opt/c; ./x a',
  ])('denies %s, since a renamed gh expands the alias the guard does not (adversary on #1233)', command => {
    expect(checkCommand(command, ctx())).toBe(REASONS.ghRenamed)
  })

  it('denies ./x a setup-git after gh alias set a auth (row 3)', () => {
    const aliases = new Map([['a', { shell: false, body: 'auth' }]])
    const withAlias = { ...ctx(), readGhAliases: () => ({ kind: 'ok' as const, aliases }) }
    expect(checkCommand('./x a setup-git', withAlias)).toBe(REASONS.ghRenamed)
  })

  it.each([
    'gcloud auth login',
    'heroku auth login',
    'echo auth setup-git',
    `grep -rn 'auth setup-git' docs`,
    'npm test',
    './x pr view 1',
  ])('allows %s', command => {
    expect(checkCommand(command, ctx())).toBeUndefined()
  })
})
