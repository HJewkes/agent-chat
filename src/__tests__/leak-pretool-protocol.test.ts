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
  ])('denies a value it cannot read: %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.programEnv)
  })

  it.each([
    'unset GIT_ALLOW_PROTOCOL; git fetch x',
    'unset -v GIT_ALLOW_PROTOCOL; git fetch x',
    'env -u GIT_ALLOW_PROTOCOL git fetch x',
    'env --unset GIT_ALLOW_PROTOCOL git fetch x',
    'env --unset=GIT_ALLOW_PROTOCOL git fetch x',
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
    'git config --"$O" x protocol.ext.allow always',
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

describe('final option state and one table of URL-storing builtins (TP-2371 fix round 6)', () => {
  it.each([
    'git remote set-url --delete --no-delete x "$U"',
    'git remote set-url --del --no-del x "$U"',
    'git remote set-url --delete --add x "$U"',
    'git submodule--helper set-url p "$U"',
    'git submodule--helper set-url -q p "$U"',
    'git submodule--helper set-url --no-quiet p "$U"',
    'git submodule--helper add "$U" p',
    'git submodule--helper add -q "$U" p',
    'git submodule--helper add --no-quiet "$U" p',
    'git submodule--helper clone --path p --name n --url "$U"',
    'git submodule--helper "$V" p "$U"',
  ])('denies %s', command => {
    expect(hookReason(command)).toBe(REASONS.remoteUrlUnresolved)
  })

  it('denies a submodule--helper option it cannot match', () => {
    expect(hookReason('git submodule--helper set-url --bogus p https://github.com/o/s')).toBe(
      REASONS.gitOptionUnmatched,
    )
  })

  it.each([
    'git remote set-url --delete x https://github.com/o/r',
    'git remote set-url --no-add --delete x "$OLD"',
    'git remote set-url --delete origin "$OLD"',
    'git submodule--helper set-url p https://github.com/o/s',
    'git submodule--helper add https://github.com/o/s p',
    'git submodule--helper status',
    'git remote remove "$R"',
    'git submodule update --init "$P"',
  ])('allows %s', command => {
    expect(hookReason(command)).toBeUndefined()
  })
})

describe('words the shell may expand to none or several (TP-2371 fix round 7)', () => {
  it.each([
    'git config {protocol.ext.allow,always}',
    'git config set {protocol.ext.allow,always}',
    'git config --global {protocol.allow,always}',
    'git config protocol.{ext.allow,always}',
    "X='protocol.ext.allow always'; git config $X",
    'set -- protocol.ext.allow always; git config "$@"',
    "git config $(printf 'protocol.ext.allow always')",
    'git config "${A[@]}"',
    'git config *',
    'git config protocol.ext.allow ?',
    'git config set $X',
    'git config --file f $X',
    'git config -- $X',
    'git config {remote.x.url,"$U"}',
    'git remote set-url {origin,"$U"}',
    'git remote $X',
    'git submodule add $X',
    'git submodule--helper set-url {p,"$U"}',
  ])('denies %s', command => {
    expect(hookReason(command)).toBe(REASONS.remoteUrlUnresolved)
  })

  // A brace that may spell an option is read first on every subcommand (CC-1434), under that rule's reason.
  it('denies git config {--rename-section,foo,protocol}', () => {
    expect(hookReason('git config {--rename-section,foo,protocol}')).toBe(REASONS.noVerify)
  })

  it.each([
    'git config -h',
    'git config --help',
    'git config -h protocol.ext.allow always',
    'git remote --help',
    'git remote set-url -h',
    'git config user.name "$NAME"',
    'git config user.name ~/x',
    'git config --get user.name',
  ])('allows %s', command => {
    expect(hookReason(command)).toBeUndefined()
  })

  it('still reads a trailing -h in legacy config as the value pattern', () => {
    expect(hookReason('git config protocol.ext.allow always -h')).toBe(REASONS.extProtocol)
  })
})

describe('a variable name the shell builds, on a line that runs git (TP-2371 fix round 7)', () => {
  it.each([
    'env $A git fetch x',
    'env "$A" git fetch x',
    'export $A; git fetch x',
    'unset $V; git fetch x',
    'env -u $V git fetch x',
    'env -u$V git fetch x',
    'env --unset=$V git fetch x',
    'export GIT_ALLOW_PROTOCOL={https,ext}; git fetch x',
    'export {GIT_ALLOW_PROTOCOL=https,GIT_ALLOW_PROTOCOL=ext}; git fetch x',
  ])('denies %s', command => {
    expect(hookReason(command)).toBe(REASONS.programEnv)
  })

  it.each(['export PATH=$HOME/bin:$PATH; git fetch x', 'env FOO=$X git fetch x', 'unset -f f; git fetch x'])(
    'allows %s',
    command => {
      expect(hookReason(command)).toBeUndefined()
    },
  )
})

describe('every place a variable name is read, failing closed on an expansion (TP-2371 fix round 8)', () => {
  it.each([
    `A=$(printf 'GIT_ALLOW_%s' PROTOCOL); printf -v "$A" ext; git fetch o`,
    `A=$(printf 'GIT_ALLOW_%s' PROTOCOL); read -r "$A" <<< ext; git fetch o`,
    'getopts ab "$A"; git fetch o',
    'X=IT_ALLOW_PROTOCOL; env G$X=ext git fetch o',
    `A=$(printf 'GIT_ALLOW_%s=ext' PROTOCOL); env -- $A git fetch o`,
    `A=$(printf 'GIT_SSH_%s' COMMAND); printf -v "$A" 'sh -c x'; git fetch o`,
    'X=IT_SSH_COMMAND; env G$X=x git fetch o',
    'X=IT_PAGER; env -- G$X=x git log',
    'mapfile "$A" < f; git fetch o',
    'readarray -t "$A" < f; git fetch o',
    'command read "$A"; git fetch o',
    'printf -v"$A" x; git fetch o',
  ])('denies %s', command => {
    expect(hookReason(command)).toBe(REASONS.programEnv)
  })

  it('reads env assignments after -- as env does', () => {
    expect(hookReason('env -- GIT_ALLOW_PROTOCOL=ext git fetch o')).toBe(REASONS.extProtocol)
  })

  it.each([
    'env -- FOO=1 git fetch o',
    'env -C "$D" git fetch o',
    `printf '%s\\n' "$x" | git hash-object --stdin`,
    `printf -v line '%s' "$x"; git fetch o`,
    'read -r line; git fetch o',
    'git log | while read -r line; do echo "$line"; done',
  ])('allows %s', command => {
    expect(hookReason(command)).toBeUndefined()
  })
})

describe('a process substitution is no variable name (TP-2371 final round)', () => {
  it.each([
    'mapfile -t f < <(git ls-files)',
    `readarray -t a < <(git branch --format='%(refname:short)')`,
    'read -r sha < <(git rev-parse HEAD)',
  ])('allows %s', command => {
    expect(hookReason(command)).toBeUndefined()
  })

  it.each(['read -r "$A" < <(git rev-parse HEAD)', 'mapfile -t "$A" < <(git ls-files)'])(
    'still denies a hidden name beside one: %s',
    command => {
      expect(hookReason(command)).toBe(REASONS.programEnv)
    },
  )
})

describe('a nameref or an indirect default assignment, on a line that runs git (TP-2499)', () => {
  it.each([
    `declare -n R=$(printf 'GIT_ALLOW_%s' PROTOCOL); R=ext; git fetch o`,
    'A=GIT_ALLOW_PROTO; declare -n R=${A}COL; R=ext; git fetch o',
    'local -n R=$A; R=ext; git fetch o',
    'typeset -n R=$A; R=ext; git fetch o',
    'declare -gn R=$A; R=ext; git fetch o',
    'declare -n R=GIT_ALLOW_PROTOCOL; R=ext; git fetch o',
    'declare -n R; unset R; git fetch o',
    'declare -n R; R="$A"; git fetch o',
    'declare -n R; for R in $(cat f); do :; done; git fetch o',
    'declare -x -n R=$A; R=ext; git fetch o',
    'declare +n R; git fetch o',
    'declare -$F R=$A; git fetch o',
    'declare -x -- $A=ext; git fetch o',
    'command declare -n R=$A; R=ext; git fetch o',
    ': ${!A:=ext}; git fetch o',
    ': ${!A=ext}; git fetch o',
    'echo "${!A:=ext}"; git fetch o',
    'mapfile -C export -c 1 a < f; git fetch o',
    `mapfile -C 'declare -gx' -c 1 a < f; git fetch o`,
    `readarray -C 'typeset -x' -c 1 a < f; git fetch o`,
    `mapfile -C 'local -x' -c 1 a < f; git fetch o`,
  ])('denies %s', command => {
    expect(hookReason(command)).toBe(REASONS.programEnv)
  })

  it('denies a mapfile callback of eval, which runs the line bash hands it', () => {
    expect(hookReason('mapfile -C eval -c 1 a < f; git fetch o')).toBe(REASONS.hiddenScript)
  })

  it.each([
    'declare -a list=(a b); git fetch o',
    'declare -A map; git fetch o',
    'declare -i n=1; git fetch o',
    'declare -r X=1; git fetch o',
    'declare -gx FOO=$X; git fetch o',
    'local line; git fetch o',
    'local -r sha=$(git rev-parse HEAD)',
    'typeset -i n; git fetch o',
    'declare -p; git status',
    'declare -n R=$A; R=x; ls',
    'echo "${!A:-none}"; git status',
    'echo "${!A}"; git status',
    'echo "${!A#=x}"; git status',
    `echo '\${!A:=x}'; git status`,
    `mapfile -C 'rm -f x' -c 1 a < f; git status`,
    'mapfile -t a < f; git status',
  ])('allows %s', command => {
    expect(hookReason(command)).toBeUndefined()
  })
})

describe('assignments in redirects, heredocs and eval bodies (TP-2499 review)', () => {
  it.each([
    ': <<< ${!A:=ext}; git fetch o',
    ': <<E\n${!A:=ext}\nE\ngit fetch o',
    ': 3<<E\n${!A:=ext}\nE\ngit fetch o',
    ': > ${!A:=x}; git fetch o',
    'read x < ${!A:=x}; git fetch o',
    ': <<< ${GIT_ALLOW_PROTOCOL:=ext}; git fetch o',
    ': <<E\n${GIT_SSH_COMMAND:=x}\nE\ngit fetch o',
    ': > ${GIT_PAGER:=x}; git log',
    `eval 'declare -n R=$A'; R=ext; git fetch o`,
    `eval 'read $A <<< ext'; git fetch o`,
    `eval ': \${!A:=ext}'; git fetch o`,
    `eval -- 'declare -n R=$A'; R=ext; git fetch o`,
    `eval -- 'read $A <<< ext'; git fetch o`,
    `eval -- 'printf -v $A ext'; git fetch o`,
    `eval -- 'export $A=ext'; git fetch o`,
    `eval - 'declare -n R=$A'; R=ext; git fetch o`,
    `eval 'eval -- "declare -n R=\\$A"'; R=ext; git fetch o`,
    '> ${GIT_PAGER:=x}; git log',
    '< ${!A:=x}; git fetch o',
    `A=$(printf GIT_ALLOW_%s PROTOCOL); trap 'git fetch o' EXIT; > \${!A:=ext}`,
    `trap 'git fetch o' EXIT; > \${!A:=ext}`,
    'git fetch o; > ${!A:=ext}',
    `trap 'git fetch o' EXIT && > \${!A:=ext}`,
    `trap 'git fetch o' EXIT; 2> \${!A:=ext}`,
    `trap 'git fetch o' EXIT; 3<<<\${!A:=ext}`,
    `trap 'git fetch o' EXIT; > \${GIT_SSH_COMMAND:=x}`,
    `trap 'git fetch o' EXIT\n> \${!A:=ext}`,
    `trap 'git fetch o' EXIT; 3<<E\n\${!A:=ext}\nE`,
    '3<<E\n${!A:=ext}\nE\ngit fetch o',
    `trap 'git fetch o' EXIT; cat <<E; > \${!A:=ext}\nE`,
  ])('denies %j', command => {
    expect(hookReason(command)).toBe(REASONS.programEnv)
  })

  it.each([
    'git log > out.txt',
    ': <<< "$x"; git status',
    `cat <<'E'\n\${!A:=ext}\nE\ngit status`,
    'read -r sha <<< "$(git rev-parse HEAD)"',
    `eval 'declare -a list=(a b)'; git status`,
    `eval 'x=1'; git status`,
    `eval -- 'x=1'; git status`,
    '> out.txt; git status',
    'rm -f x 2>/dev/null; git status',
    `cat <<'E'\n\${!A:=ext}\nE\ngit fetch o`,
  ])('allows %j', command => {
    expect(hookReason(command)).toBeUndefined()
  })

  it.each([
    `CMD='declare -n R=$A'; eval "$CMD"; R=ext; git fetch o`,
    `X=--; eval "$X" 'declare -n R=$A'; R=ext; git fetch o`,
    `eval -x 'declare -n R=$A'; git fetch o`,
  ])('denies an eval whose first word it cannot read: %j', command => {
    expect(hookReason(command)).toBe(REASONS.hiddenScript)
  })

  it('reads the git eval runs past its --', () => {
    expect(hookReason(`eval -- 'git push --no-verify'`)).toBe(REASONS.noVerify)
  })
})

describe('a hidden name in a script the line runs, on a line that runs git (TP-2499 redesign)', () => {
  it.each([
    `A=GIT_ALLOW_PROTO; trap 'declare -n R=\${A}COL; R=ext' DEBUG; git fetch o`,
    `trap 'read $A <<< ext' DEBUG; git fetch o`,
    `trap ': \${!A:=ext}' DEBUG; git fetch o`,
    `trap -- ': \${!A:=ext}' DEBUG; git fetch o`,
    `trap 'declare -n R=$A; R=ext' RETURN; git fetch o`,
    `bash -c "trap ': \\\${!A:=ext}' DEBUG; git fetch o"`,
    `source /dev/stdin <<< 'declare -n R=$A; R=ext'; git fetch o`,
    `. /dev/stdin <<< 'declare -n R=$A; R=ext'; git fetch o`,
    `mapfile -C 'declare -n R=$A; :' -c 1 a < f; git fetch o`,
  ])('denies %j', command => {
    expect(hookReason(command)).toBe(REASONS.programEnv)
  })

  it('denies a trap action it cannot read', () => {
    expect(hookReason('trap "$T" DEBUG; git fetch o')).toBe(REASONS.hiddenScript)
  })

  it('checks a trap action as a script', () => {
    expect(hookReason(`trap 'git push --no-verify' EXIT`)).toBe(REASONS.noVerify)
  })

  it('denies a nameref in a child shell on a git line, which cannot pass it back', () => {
    expect(hookReason(`bash -c 'declare -n R=$A; R=x'; git fetch o`)).toBe(REASONS.programEnv)
  })

  it.each([
    `trap 'rm -f "$tmp"' EXIT; git fetch o`,
    'trap - EXIT; git status',
    'trap -p; git status',
    `trap 'declare -n R=$A; R=x' DEBUG; ls`,
    'eval "$(ssh-agent -s)"; npm test',
    'mapfile -t a < f; git status',
  ])('allows %j', command => {
    expect(hookReason(command)).toBeUndefined()
  })
})

describe('a {NAME}>file redirect, which writes a descriptor number to NAME (CC-1630)', () => {
  // zsh assigns NAME before an external command starts, so gh itself runs a pager named 11.
  it.each([
    'gh {GH_PAGER}>/dev/null pr view 1',
    'agent-chat gh-write {GH_PAGER}>/dev/null -- pr view 1',
    'gh pr view 1 {GH_PAGER[0]}>/dev/null',
    'gh pr view 1 {GIT_ALLOW_PROTOCOL}>&-',
    'git fetch o {GIT_SSH_COMMAND}>/dev/null',
    'exec {GIT_SSH_COMMAND}>/dev/null; git fetch o',
  ])('denies %j', command => {
    expect(hookReason(command)).toBe(REASONS.programEnv)
  })

  it('denies writing a command search path', () => {
    expect(hookReason(': {path}>/dev/null; git fetch o')).toBe(REASONS.searchPathEnv)
  })

  it('denies writing a shell startup variable', () => {
    expect(hookReason('gh pr view 1 {BASH_ENV}>/dev/null')).toBe(REASONS.shellStartupEnv)
  })

  it.each([
    'gh pr view 1 {fd}>/dev/null',
    'exec {fd}>/dev/null; git fetch o',
    'gh pr view 1 "{GH_PAGER}">/dev/null',
    // GIT_DIR is no program var: a literal GIT_DIR=x before git status is allowed too.
    'export GIT_DIR; exec {GIT_DIR}>/dev/null; git status',
  ])('allows %j', command => {
    expect(hookReason(command)).toBeUndefined()
  })
})

describe('a double-quoted trap action on a line that runs git (CC-1630)', () => {
  it.each([`trap "rm -f tmp" EXIT; git fetch o`, `trap "rm -f \\$tmp" EXIT; git fetch o`])(
    'allows %j, which expands nothing when the trap is set',
    command => {
      expect(hookReason(command)).toBeUndefined()
    },
  )

  it.each([`trap "rm -f $tmp" EXIT; git fetch o`, `trap "git fetch $R" EXIT`])(
    'denies %j, whose value becomes script text',
    command => {
      expect(hookReason(command)).toBe(REASONS.hiddenScript)
    },
  )
})

describe('git clone of a repository the guard cannot read (TP-2444)', () => {
  it.each([
    'git clone "$U"',
    'git clone "$U" d',
    'git clone "${U}" d',
    'git clone "$(cat u)" d',
    'git clone x"$U" d',
    'git clone --bare "$U"',
    'git clone --mirror "$U"',
    'git clone -o up -b main "$U" d',
    'git clone --origin=up --depth 1 "$U"',
    'git clone -- "$U" d',
    'git -C /tmp clone "$U"',
    'git clone --template=t --reference /r "$U" d',
    'git clone -qb main "$U"',
    'git clone --frobnicate "$U" d',
  ])('denies %s', command => {
    expect(hookReason(command)).toBe(REASONS.remoteUrlUnresolved)
  })

  it.each([
    'git clone https://github.com/o/r "$DIR"',
    'git clone -b main https://github.com/o/r',
    'git clone --reference "$R" https://github.com/o/r d',
    'git clone -o "$O" https://github.com/o/r',
    'git clone -h',
    'git clone --frobnicate https://github.com/o/r d',
    'git clone --recurse-submodules=p https://github.com/o/r d',
    'gh repo clone "$R"',
    'gh repo clone o/r "$DIR"',
  ])('allows %s', command => {
    expect(hookReason(command)).toBeUndefined()
  })

  it('keeps gitConfigUnresolved for a word the shell may split', () => {
    expect(hookReason('git clone $U d')).toBe(REASONS.gitConfigUnresolved)
  })

  it.each([
    'git clone -c remote.up.url="$U" https://github.com/o/r',
    'git clone -c remote.origin.pushurl="$U" https://github.com/o/r d',
    'git clone --config remote.up.url="$U" https://github.com/o/r',
    'git clone --config=submodule.s.url="$U" https://github.com/o/r',
    'git clone -c submodule.s.url="$U" https://github.com/o/r',
  ])('denies a URL config value it cannot read: %s', command => {
    expect(hookReason(command)).toBe(REASONS.remoteUrlUnresolved)
  })

  it.each([
    'git clone -c remote.up.url=https://github.com/o/u https://github.com/o/r',
    'git clone --config submodule.s.url=https://github.com/o/s https://github.com/o/r d',
    'git -c remote.up.url=https://github.com/o/u clone https://github.com/o/r',
  ])('allows a readable URL config value: %s', command => {
    expect(hookReason(command)).toBeUndefined()
  })

  it('reads a same-line literal assignment', () => {
    expect(hookReason('U=https://github.com/o/r; git clone "$U"')).toBe(REASONS.remoteUrlUnresolved)
  })
})

describe('GIT_ALLOW_PROTOCOL on a line with no git (CC-1137 d)', () => {
  it.each([
    'GIT_ALLOW_PROTOCOL=ext make',
    'export GIT_ALLOW_PROTOCOL=ext; ./build.sh',
    'GIT_ALLOW_PROTOCOL=https:EXT npm test',
    'env GIT_ALLOW_PROTOCOL=file:ext bash run.sh',
    'GIT_ALLOW_PROTOCOL=ext',
    'declare -x GIT_ALLOW_PROTOCOL=ext; make',
  ])('denies a literal list naming ext anywhere: %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.extProtocol)
  })

  it.each([
    'unset GIT_ALLOW_PROTOCOL; ls',
    'GIT_ALLOW_PROTOCOL="$P" make',
    'env -u GIT_ALLOW_PROTOCOL npm test',
    'GIT_ALLOW_PROTOCOL=https:ssh make',
    'echo $GIT_ALLOW_PROTOCOL',
  ])('leaves an unset or unread list off a git line to the CC-1095 pin: %s', command => {
    expect(checkCommand(command, ctx)).toBeUndefined()
  })
})
