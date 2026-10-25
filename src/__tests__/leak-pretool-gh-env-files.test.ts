import { describe, expect, it } from 'vitest'
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

describe('a gh helper or config variable written into a file a later shell sources (TP-4232)', () => {
  it.each([
    `echo 'export GH_PATH=/opt/x' >> "$CLAUDE_ENV_FILE"`,
    `echo 'export PATH=/opt/bin' >> "$CLAUDE_ENV_FILE"`,
    `echo 'export GH_CONFIG_DIR=/opt/c' >> "$CLAUDE_ENV_FILE"`,
    `printf 'export GH_PATH=/opt/x\\n' >> ~/.bashrc`,
    `echo 'GH_PATH=/opt/x' > ~/.profile`,
    `echo 'export XDG_CONFIG_HOME=/opt/c' >> ~/.zshenv`,
    `echo 'path=(/opt/bin $path)' >> ~/.zshrc`,
    `cat >> ~/.zshenv <<'EOF'\nexport GH_PATH=/opt/x\nEOF`,
    `echo 'export GH_PATH=/opt/x' >> /srv/agent/env.sh`,
    `echo 'export GH_PATH=/opt/x' >> ~/.claude/session-env/s1/sessionstart-hook-0.sh`,
  ])('denies %s, since it names the variable', command => {
    expect(checkCommand(command, ctx({ ...ENV, CLAUDE_ENV_FILE: '/srv/agent/env.sh' }))).toBe(
      REASONS.ghHelperEnvFile,
    )
  })

  it.each([
    `echo 'export GH_""PATH=/opt/x' >> "$CLAUDE_ENV_FILE"`,
    `echo 'export GH_\\PATH=/opt/x' >> "$CLAUDE_ENV_FILE"`,
    `echo 'export GH_PATH=/opt/x' >> ~/.ba""shrc`,
    `echo 'export GH_PATH=/opt/x' >> ~/.BASHRC`,
  ])('denies %s, since quoting and case do not hide a name', command => {
    expect(checkCommand(command, ctx())).toBe(REASONS.ghHelperEnvFile)
  })

  it.each([
    `echo 'export G\${E}H_CONFIG_DIR=/opt/c' >> ~/.zshenv`,
    `printf 'export GH_CONFIG_%sDIR=/opt/c\\n' '' >> "$CLAUDE_ENV_FILE"`,
    `echo 'export GH_CONFIG_\\x44IR=/opt/c' >> "$CLAUDE_ENV_FILE"`,
    `printf 'export GH_CONFIG_' >> "$CLAUDE_ENV_FILE"`,
    `echo -n 'export GH_CONFIG_' >> "$CLAUDE_ENV_FILE"`,
    `echo "$X" >> "$CLAUDE_ENV_FILE"`,
    `echo * >> ~/.bashrc`,
    `cat >> ~/.zshenv <<'EOF'\nexport GH_CONFIG_\\\nDIR=/opt/c\nEOF`,
    `cat >> ~/.zshenv <<EOF\n$X\nEOF`,
    `cat /tmp/rc >> "$CLAUDE_ENV_FILE"`,
    `echo x | cat >> ~/.bashrc`,
  ])('denies %s, since the line does not show the whole text it writes', command => {
    expect(checkCommand(command, ctx())).toBe(REASONS.ghHelperEnvFile)
  })

  it.each([
    'cp /tmp/rc ~/.zshenv',
    'tee -a ~/.bash_profile < /tmp/rc',
    `sed -i 's/^#//' ~/.bashrc`,
    `bash -c 'cat /tmp/rc >> ~/.bashrc'`,
    'mv /tmp/rc "$CLAUDE_ENV_FILE"',
    `LESSOPEN='|cp /tmp/rc %s' less ~/.zshenv`,
    'less ~/.zshenv',
    `rg --pre /tmp/x '' ~/.zshenv`,
    'GREP_OPTIONS=-r grep x ~/.bashrc',
  ])('denies %s, since a command other than a read or echo may write it', command => {
    expect(checkCommand(command, ctx())).toBe(REASONS.ghHelperEnvFile)
  })

  it.each([
    `echo 'source /tmp/rc' >> "$CLAUDE_ENV_FILE"`,
    `echo '. /tmp/rc' >> ~/.bashrc`,
    `echo 'alias gh=/tmp/x/gh' >> "$CLAUDE_ENV_FILE"`,
    `echo 'alias ll="ls -l"' >> ~/.bashrc`,
    `echo 'eval "$(/tmp/x/gh completion)"' >> ~/.zshenv`,
    `echo 'export FOO=1; source /tmp/rc' >> ~/.zshenv`,
    `echo 'f() { gh auth setup-git; }' >> ~/.bashrc`,
    `cat >> ~/.zshenv <<'EOF'\nsource /tmp/rc\nEOF`,
    `cd ~/.claude/session-env && echo 'source /tmp/rc' >> abc/sessionstart-hook-9.sh`,
  ])('denies %s, since the file sourced runs it and the text is no plain assignment', command => {
    expect(checkCommand(command, ctx())).toBe(REASONS.ghHelperEnvFile)
  })

  it.each([
    `echo 'export FOO=1' >> "$CLAUDE_ENV_FILE"`,
    `echo 'FOO=1' >> ~/.bashrc`,
    `echo 'export MYPATH=/opt/bin' >> ~/.zshrc`,
    `echo '# a comment' >> ~/.bashrc`,
    `printf 'export FOO=1\\n' >> ~/.zshenv`,
    `cat >> ~/.zshenv <<'EOF'\nexport FOO=1\nexport BAR=2\nEOF`,
    'cat ~/.bashrc',
    'grep -n alias ~/.zshrc > /tmp/aliases.txt',
    'echo "$CLAUDE_ENV_FILE"',
    'gh auth setup-git',
    'echo "$PATH"',
    'bash scripts/build.bash',
  ])('allows %s', command => {
    expect(checkCommand(command, ctx())).toBeUndefined()
  })

  it.each([
    { file: '/srv/agent/.bashrc', tool: 'Write' },
    { file: '/srv/agent/.zshenv', tool: 'Edit' },
    { file: '/srv/agent/env.sh', tool: 'MultiEdit' },
    { file: '/srv/agent/.claude/session-env/s1/sessionstart-hook-0.sh', tool: 'Write' },
  ])('denies the $tool tool on $file', ({ file, tool }) => {
    const env = { ...ENV, CLAUDE_ENV_FILE: '/srv/agent/env.sh' }
    expect(checkToolCall(tool, { file_path: file, content: 'export FOO=1\n' }, ctx(env))).toBe(
      REASONS.ghHelperEnvFileEdit,
    )
  })

  it('allows the Write tool on a file no shell sources', () => {
    expect(checkToolCall('Write', { file_path: '/work/build.bash', content: 'x' }, ctx())).toBeUndefined()
  })
})

describe('GH_CONFIG_DIR, XDG_CONFIG_HOME or HOME carried to a gh alias by a wrapper (TP-4232)', () => {
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

describe('a renamed copy of gh writing its own path as the credential helper (TP-4232)', () => {
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
