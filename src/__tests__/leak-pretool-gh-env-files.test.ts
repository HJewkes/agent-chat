import { describe, expect, it } from 'vitest'
import { writesEnvFile } from '../leak-guard/env-files.js'
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

describe('a file a later shell sources is owner-only (TP-4232)', () => {
  const denies = (command: string, env: Record<string, string> = ENV) =>
    expect(checkCommand(command, ctx(env))).toBe(REASONS.ghHelperEnvFile)

  it.each([
    `LESSOPEN='|cp /tmp/rc %s' less ~/.zshenv`,
    'less ~/.zshenv',
    `rg --pre /tmp/x '' ~/.zshenv`,
    'GREP_OPTIONS=-r grep x ~/.bashrc',
  ])('denies %s, since a prefix or a reader that runs a program is no plain read (rows 1, 2)', command => {
    denies(command)
  })

  it.each([
    `echo 'export GH_PATH=/opt/x' >> ~/.claude-profiles/agents/session-env/s1/sessionstart-hook-0.sh`,
    `cd ~/.claude/session-env && echo 'export GH_PATH=/x' >> abc/sessionstart-hook-9.sh`,
    `echo 'export GH_PATH=/opt/x' >> /srv/agent/env.sh`,
  ])('denies %s, a write into Claude session-env (rows 4, 7)', command => {
    denies(command, { ...ENV, CLAUDE_ENV_FILE: '/srv/agent/env.sh' })
  })

  it.each([
    `echo 'source /tmp/rc' >> "$CLAUDE_ENV_FILE"`,
    `echo 'alias gh=/tmp/x/gh' >> "$CLAUDE_ENV_FILE"`,
    `echo 'alias gh=/tmp/x/gh' >> ~/.zshenv`,
    `echo '. /tmp/rc' >> ~/.bashrc`,
    `cat >> ~/.zshenv <<'EOF'\nsource /tmp/rc\nEOF`,
  ])('denies %s, a source or alias append (rows 5, 6)', command => {
    denies(command)
  })

  it.each([
    `echo 'export BASH_ENV=/tmp/rc' >> "$CLAUDE_ENV_FILE"`,
    `echo 'ENV=/tmp/rc' >> ~/.profile`,
    `echo 'export ZDOTDIR=/tmp/z' >> ~/.zshenv`,
    `echo 'export GIT_SSH_COMMAND=/tmp/x' >> "$CLAUDE_ENV_FILE"`,
    `echo 'PROMPT_COMMAND=x' >> ~/.bashrc`,
  ])('denies %s, an assignment whose later reader the guard cannot know (rows 8, 9)', command => {
    denies(command)
  })

  it.each([
    `echo 'export GH_PATH=/opt/x' >> ${SNAPSHOT}`,
    'cp /tmp/rc ~/.claude/shell-snapshots/snapshot-bash-1.sh',
    `printf 'export GH_PATH=/x\\n' > ~/.claude/shell-snapshots/snapshot-zsh-1.sh`,
  ])('denies %s, a write into the shell snapshot the Bash tool sources (rows 10, 11)', command => {
    denies(command)
  })

  it.each(['< /tmp/rc >> ~/.zshenv', '>> ~/.zshenv < /tmp/rc'])(
    'denies %s, a bare redirection zsh runs as cat (row 13)',
    command => {
      denies(command)
    },
  )

  it('denies a line naming a sourced file that parses to no command, since that proves no read (row 13)', () => {
    expect(writesEnvFile('< /tmp/rc >> ~/.zshenv', [], ENV)).toBe(true)
  })

  it.each(['echo hi; < /tmp/rc >> ~/.zshenv', 'echo hi && >> ~/.zshenv < /tmp/rc'])(
    'denies %s, a bare redirection after a plain command (row 14)',
    command => {
      denies(command)
    },
  )

  it.each(['/tmp/x/cat /tmp/rc ~/.zshenv', './cat /tmp/rc ~/.zshenv'])(
    'denies %s, since a reader named by path may be any program (row 15)',
    command => {
      denies(command)
    },
  )

  it.each([
    `echo 'export GH_""PATH=/opt/x' >> "$CLAUDE_ENV_FILE"`,
    `printf 'export GH_CONFIG_%sDIR=/opt/c\\n' '' >> "$CLAUDE_ENV_FILE"`,
    `cat /tmp/rc >> "$CLAUDE_ENV_FILE"`,
    'cp /tmp/rc ~/.zshenv',
    'cat /tmp/rc | tee -a ~/.bash_profile',
    `echo 'export GH_PATH=/opt/x' >> ~/.ba""shrc`,
    `echo 'export GH_PATH=/opt/x' >> ~/.BASHRC`,
    `sed -i 's/^#//' ~/.bashrc`,
    'mv /tmp/rc "$CLAUDE_ENV_FILE"',
  ])('denies %s, a write or a writer (row 16)', command => {
    denies(command)
  })

  it.each([
    '{ echo a; } >> ~/.bashrc',
    'exec 3>>~/.bashrc; echo x >&3',
    'f() { cat > ~/.zshenv; }; f < /tmp/rc',
    'cat ~/.zshrc <(cp /tmp/rc ~/.zshenv)',
    `bash -c 'cat /tmp/rc >> ~/.bashrc'`,
  ])('denies %s, a group, exec, function or substitution (row 17)', command => {
    denies(command)
  })

  it.each([
    `echo 'export FOO=1' >> "$CLAUDE_ENV_FILE"`,
    `printf 'export FOO=1\\n' >> ~/.bashrc`,
    `echo 'alias ll="ls -l"' >> ~/.bashrc`,
    `cat >> ~/.zshenv <<'EOF'\nexport FOO=1\nEOF`,
    'grep alias ~/.zshrc > /tmp/aliases.txt',
  ])('denies %s, an accepted over-deny: only the owner changes these files (row 22)', command => {
    denies(command)
  })

  it.each([
    'cat ~/.bashrc',
    'cat ~/.zshrc 2>/dev/null || true',
    'grep x ~/.zshrc 2>&1 | head -5',
    'ls ~/.claude-profiles/agents/shell-snapshots',
    'test -f ~/.zshenv && echo y',
    'echo x # >> ~/.zshenv',
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
    { file: '/srv/agent/.bashrc', tool: 'Write' },
    { file: '/srv/agent/.zshenv', tool: 'Edit' },
    { file: '/srv/agent/env.sh', tool: 'MultiEdit' },
    { file: '/srv/agent/.claude/session-env/s1/sessionstart-hook-0.sh', tool: 'Write' },
    { file: SNAPSHOT, tool: 'Write' },
    { file: SNAPSHOT, tool: 'Edit' },
  ])('denies the $tool tool on $file (rows 4, 12)', ({ file, tool }) => {
    const env = { ...ENV, CLAUDE_ENV_FILE: '/srv/agent/env.sh' }
    expect(checkToolCall(tool, { file_path: file, content: 'export FOO=1\n' }, ctx(env))).toBe(
      REASONS.ghHelperEnvFileEdit,
    )
  })

  it('allows the Write tool on a file no shell sources', () => {
    expect(checkToolCall('Write', { file_path: '/work/build.bash', content: 'x' }, ctx())).toBeUndefined()
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
