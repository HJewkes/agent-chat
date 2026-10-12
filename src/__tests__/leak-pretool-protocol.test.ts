import { parseTerms } from '@titan-design/egress-scan'
import { describe, expect, it } from 'vitest'
import { checkCommand, pretoolDecision, REASONS, type GuardContext } from '../leak-guard/pretool.js'

const ctx: GuardContext = {
  terms: { kind: 'ok', rules: parseTerms('zq7privateseat\n') },
  cwd: '/work',
  env: {},
  protectedPaths: ['titan-egress/private-terms', '.agent-chat/git-hooks'],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
}

describe('GIT_ALLOW_PROTOCOL on a line that may reach git (TP-2371)', () => {
  it.each([
    'GIT_ALLOW_PROTOCOL=ext git fetch x',
    'export GIT_ALLOW_PROTOCOL=https:EXT; git fetch x',
    'env GIT_ALLOW_PROTOCOL=file:ext git fetch',
    'GIT_ALLOW_PROTOCOL=" ext" git fetch x',
  ])('denies a value that lists ext: %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.extProtocol)
  })

  it.each([
    'GIT_ALLOW_PROTOCOL="$P" git fetch x',
    'GIT_ALLOW_PROTOCOL+=:ext git fetch x',
    'read GIT_ALLOW_PROTOCOL; git fetch x',
    ': ${GIT_ALLOW_PROTOCOL:=ext}; git fetch x',
    'env --unset=GIT_ALLOW_PROTOCOL git fetch x',
  ])('denies a value it cannot read: %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.programEnv)
  })

  it.each([
    'unset GIT_ALLOW_PROTOCOL; git fetch x',
    'unset -v GIT_ALLOW_PROTOCOL; git fetch x',
    'env -u GIT_ALLOW_PROTOCOL git fetch x',
    'env --unset GIT_ALLOW_PROTOCOL git fetch x',
  ])('denies unsetting it, which lifts a pinned list: %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.extProtocol)
  })

  it.each([
    'GIT_ALLOW_PROTOCOL=https:ssh git fetch x',
    'GIT_ALLOW_PROTOCOL=https:next git fetch x',
    'echo $GIT_ALLOW_PROTOCOL',
    'echo "${GIT_ALLOW_PROTOCOL:-unset}"; git status',
    'unset GIT_ALLOW_PROTOCOL; ls',
  ])('allows %s', command => {
    expect(checkCommand(command, ctx)).toBeUndefined()
  })
})

describe('git config writes that switch on the ext transport (TP-2371)', () => {
  it.each([
    'git config protocol.ext.allow always',
    'git config --global protocol.allow always',
    'git config set protocol.ext.allow user',
    'git config --file .git/config protocol.EXT.allow always',
    'git config --add Protocol.Allow always',
    'git config protocol.ext.allow "$V"',
  ])('denies %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.extProtocol)
  })

  it.each([
    'git config protocol.ext.allow never',
    'git config --get protocol.ext.allow',
    'git config get protocol.allow',
    'git config protocol.ext.allow',
    'git config --unset protocol.ext.allow',
    'git config protocol.file.allow always',
  ])('allows %s', command => {
    expect(checkCommand(command, ctx)).toBeUndefined()
  })
})

describe('remote URL writes the guard cannot read (TP-2371)', () => {
  it.each([
    'git remote set-url x "$U"',
    'git remote set-url --push x "$U"',
    'git remote add y "$U"',
    'git remote add -t main y $U',
    'git config remote.x.url "$U"',
    'git config set remote.x.pushurl "$U"',
    'git config remote.x.vcs "$H"',
    'git config url."$B".insteadOf https://github.com/',
    'git config --global url.https://x/.pushInsteadOf "$P"',
    'git config "$K" "$V"',
  ])('denies %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.remoteUrlUnresolved)
  })

  it('denies the Shepherd chain: a hidden ext URL, then a protocol list that runs it', () => {
    expect(checkCommand('git remote set-url x "$U"', ctx)).toBeDefined()
    expect(checkCommand('GIT_ALLOW_PROTOCOL=ext git fetch x', ctx)).toBeDefined()
  })

  it.each([
    'git remote set-url origin https://github.com/o/r',
    'git remote add up git@github.com:o/r.git',
    'git remote -v',
    'git remote remove "$R"',
    'git remote set-url --delete origin "$OLD"',
    'git config remote.origin.url',
    'git config --get remote.origin.url',
    'git config remote.origin.url https://github.com/o/r',
    'git config user.name "$NAME"',
  ])('allows %s', command => {
    expect(checkCommand(command, ctx)).toBeUndefined()
  })

  it('keeps denying an ext:: insteadOf base as before', () => {
    expect(checkCommand('git config url."ext::sh -c x".insteadOf https://github.com/', ctx)).toBeDefined()
  })
})

/** The deny reason the hook entry point prints for one Bash command, undefined when it allows. */
function hookReason(command: string): string | undefined {
  const raw = JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: '/work', session_id: 's' })
  const out = pretoolDecision(raw, () => ctx)
  if (out === '') return undefined
  return (JSON.parse(out) as { hookSpecificOutput: Record<string, string> }).hookSpecificOutput
    .permissionDecisionReason
}

describe('section renames and unreadable verbs at the hook entry point (TP-2371 fix round)', () => {
  it.each([
    'git config foo.allow always && git config --rename-section foo protocol',
    'git config --rename-section foo protocol.ext',
    'git config rename-section foo Protocol',
    'git config --global --rename-section foo protocol',
  ])('denies a rename into protocol: %s', command => {
    expect(hookReason(command)).toBe(REASONS.extProtocol)
  })

  it.each([
    'git config foo.url "$U"; git config --rename-section foo remote.x',
    'git config rename-section foo url.x',
    'git config --rename-section foo submodule.s',
    'git config --rename-section foo REMOTE.origin',
    'git config --rename-section foo "$S"',
    'git config rename-section "$A" "$B"',
    'git remote "$V" x "$U"',
    'git remote -v "$V" x https://github.com/o/r',
    'git submodule set-url s "$U"',
    'git submodule set-url -- s "$U"',
    'git submodule add "$U" s',
    'git config -f .gitmodules submodule.s.url "$U"',
  ])('denies %s', command => {
    expect(hookReason(command)).toBe(REASONS.remoteUrlUnresolved)
  })

  it.each([
    'git config --rename-section foo bar',
    'git config --rename-section protocol old-protocol',
    'git config --remove-section protocol',
    'git config set --comment="$C" protocol.ext.allow never',
    'git config --comment "$C" protocol.ext.allow never',
    'git submodule set-url s https://github.com/o/s',
    'git submodule update --init',
    'git remote',
  ])('allows %s', command => {
    expect(hookReason(command)).toBeUndefined()
  })
})

describe("abbreviated options, read as git's parse-options reads them (TP-2371 fix round 2)", () => {
  it.each([
    'git config foo.allow always && git config --ren foo protocol',
    'git config --rena foo protocol',
    'git config --rename foo protocol',
    'git config --fil .git/config protocol.ext.allow always',
    'git config --fil=.git/config protocol.ext.allow always',
    'git config -zf .git/config protocol.ext.allow always',
    'git config --typ bool protocol.ext.allow true',
    'git config --com note protocol.ext.allow always',
    'git config --defa x protocol.ext.allow always',
    'git config --blo HEAD:c protocol.ext.allow always',
    'git config set --val x protocol.ext.allow always',
    'git config --no-fil --typ=bool protocol.allow true',
  ])('denies a protocol write: %s', command => {
    expect(hookReason(command)).toBe(REASONS.extProtocol)
  })

  it.each([
    'git config --fil x remote.x.url "$U"',
    'git remote set-url --pu x "$U"',
    'git submodule --qui set-url s "$U"',
  ])('denies a hidden URL write: %s', command => {
    expect(hookReason(command)).toBe(REASONS.remoteUrlUnresolved)
  })

  it.each([
    'git config --re foo protocol',
    'git config --get-c protocol.ext.allow always',
    'git config --bogus protocol.ext.allow always',
    'git config -x protocol.ext.allow always',
    'git config --$O x protocol.ext.allow always',
    'git remote --bogus add y https://github.com/o/r',
    'git submodule add --bogus https://github.com/o/s s',
  ])('denies an option it cannot match to one git option: %s', command => {
    expect(hookReason(command)).toBe(REASONS.gitOptionUnmatched)
  })

  it.each([
    'git config --ty bool --get protocol.ext.allow',
    'git config --glob user.name x',
    'git config --no-includes --get protocol.allow',
    'git config --fil .git/config protocol.ext.allow never',
    'git remote set-url --del origin "$OLD"',
    'git remote --verb',
    'git submodule --qui update --init',
  ])('allows %s', command => {
    expect(hookReason(command)).toBeUndefined()
  })
})

describe('options after -- and value-taking top-level options (TP-2371 fix round 3)', () => {
  it.each([
    'git config -- --rename-section foo protocol',
    'git config -- --type bool protocol.ext.allow true',
    'git config --global -- -f x protocol.allow always',
    'git --attr-source HEAD config --rename-section foo protocol',
    'git --shallow-file x config protocol.ext.allow always',
    'git --attr-source=HEAD config protocol.ext.allow always',
  ])('denies a protocol write: %s', command => {
    expect(hookReason(command)).toBe(REASONS.extProtocol)
  })

  it.each([
    'git config -- -f x remote.x.url "$U"',
    'git --attr-source HEAD remote set-url x "$U"',
    'git --shallow-file x remote add y "$U"',
  ])('denies a hidden URL write: %s', command => {
    expect(hookReason(command)).toBe(REASONS.remoteUrlUnresolved)
  })

  it('denies a protocol config on git behind --attr-source', () => {
    expect(hookReason('git --attr-source HEAD -c protocol.ext.allow=always fetch origin')).toBeDefined()
  })

  it.each([
    'git config -- user.name x',
    'git --attr-source HEAD config --get protocol.ext.allow',
    'git --attr-source HEAD remote set-url origin https://github.com/o/r',
    'git submodule set-url -- s https://github.com/o/s',
  ])('allows %s', command => {
    expect(hookReason(command)).toBeUndefined()
  })
})

describe('legacy git config stops reading options at its first positional (TP-2371 fix round 4)', () => {
  it.each([
    'git config protocol.ext.allow always --get',
    'git config protocol.allow always --list',
    'git config protocol.ext.allow always --unset',
    'git config protocol.ext.allow always -l',
    'git config --global protocol.allow always --get-all',
    'git config protocol.ext.allow always --remove-section',
  ])('denies a protocol write with a trailing mode word: %s', command => {
    expect(hookReason(command)).toBe(REASONS.extProtocol)
  })

  it.each([
    'git config remote.z.url "$U" --get',
    'git config remote.z.url "$U" --unset',
    'git config url."$B".insteadOf https://github.com/ --unset',
    'git config url."$B".insteadOf https://github.com/ --list',
  ])('denies a hidden URL write with a trailing mode word: %s', command => {
    expect(hookReason(command)).toBe(REASONS.remoteUrlUnresolved)
  })

  it('reads the URL a trailing mode word follows, as git writes it', () => {
    expect(hookReason("git config remote.z.url 'ext::sh -c git% push% --no-verify' --unset")).toBeDefined()
  })

  it.each([
    'git config --get protocol.ext.allow',
    'git config --unset protocol.ext.allow',
    'git config get protocol.ext.allow',
    'git config protocol.ext.allow never --get',
    'git config --file x set protocol.ext.allow',
  ])('allows %s', command => {
    expect(hookReason(command)).toBeUndefined()
  })
})

describe('git config <subcommand> stops reading options at -- (TP-2371 fix round 5)', () => {
  it.each([
    'git config set -- "$K" --get',
    'git config set -- "$K" --list',
    'git config set -- url."$B".insteadOf --get',
  ])('denies a write whose option-looking value follows --: %s', command => {
    expect(hookReason(command)).toBe(REASONS.remoteUrlUnresolved)
  })

  it('still denies a protocol write after --', () => {
    expect(hookReason('git config set -- protocol.allow always')).toBe(REASONS.extProtocol)
  })

  it.each(['git config set --append user.name x', 'git config set --no-append user.name x'])(
    'allows %s',
    command => {
      expect(hookReason(command)).toBeUndefined()
    },
  )
})
