import fs from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'
import { fakeGitShells } from './helpers/fake-git-shells.js'

/**
 * A shell, or `source` of a stdin path, reads its script from every fd-0 source in scope: an
 * earlier `exec` redirect, a redirect on an enclosing group, loop or function, and the stdin an
 * outer `-c` shell was fed (CC-1408). Real bash and zsh with a fake `git` first on PATH confirm
 * each bypass row runs the push in every shell it names.
 */

const ctx = (): GuardContext => ({
  terms: { kind: 'ok', rules: [] },
  cwd: '/work',
  env: {},
  protectedPaths: [],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
})

const PUSH = 'git push --no-verify'
const BOTH = ['bash', 'zsh']

// Each row: the line, the reason the guard gives, and the shells that run its push.
const BYPASSES: [string, string, string[]][] = [
  // Drop the indirect feed checkAt joins into the line's stdin: every exec and compound row allows.
  [`exec < push.sh; bash`, REASONS.pipedScript, BOTH],
  [`exec 0<<<'${PUSH}'; bash`, REASONS.noVerify, BOTH],
  [`exec <<'E'\n${PUSH}\nE\nbash`, REASONS.noVerify, BOTH],
  [`exec 3<push.sh; exec 0<&3; bash`, REASONS.pipedScript, BOTH],
  [`{ exec < push.sh; }; bash`, REASONS.pipedScript, BOTH],
  [`if true; then exec <push.sh; fi; bash`, REASONS.pipedScript, BOTH],
  [`{ bash; } <<'E'\n${PUSH}\nE`, REASONS.noVerify, BOTH],
  [`{ bash; } <<<'${PUSH}'`, REASONS.noVerify, BOTH],
  [`F=--no-verify; { bash; } <<EOF\ngit push $F\nEOF`, REASONS.pipedScript, BOTH],
  [`while read -r l; do bash; done <<'E'\nx\n${PUSH}\nE`, REASONS.noVerify, BOTH],
  [`if true; then bash; fi <<'E'\n${PUSH}\nE`, REASONS.noVerify, BOTH],
  [`until bash; do :; done <<'E'\n${PUSH}\nE`, REASONS.noVerify, BOTH],
  [`for i in 1; do bash; done <<'E'\n${PUSH}\nE`, REASONS.noVerify, BOTH],
  [`case x in x) bash;; esac <<'E'\n${PUSH}\nE`, REASONS.noVerify, BOTH],
  [`f() { bash; } <<'E'\n${PUSH}\nE\nf`, REASONS.noVerify, BOTH],
  // Keep no `)` command for a redirect after a subshell: these allow.
  [`( bash ) < push.sh`, REASONS.pipedScript, BOTH],
  [`echo $( ( bash ) < push.sh )`, REASONS.pipedScript, BOTH],
  // Read no function names: a call fed a redirect or pipe feeds a body checked where it is defined.
  [`f() { bash; }; f <<'E'\n${PUSH}\nE`, REASONS.noVerify, BOTH],
  [`function f { bash; }; f < push.sh`, REASONS.pipedScript, BOTH],
  [`f() { bash; }; echo "${PUSH}" | f`, REASONS.noVerify, BOTH],
  [`f() { bash; }; exec <push.sh; f`, REASONS.pipedScript, BOTH],
  // Drop `command` and `builtin` from commandWords, the expanded head, or the eval text: these allow.
  [`command exec < push.sh; bash`, REASONS.pipedScript, ['bash']],
  [`builtin exec < push.sh; bash`, REASONS.pipedScript, ['zsh']],
  [`E=exec; $E < push.sh; bash`, REASONS.pipedScript, BOTH],
  [`eval 'exec < push.sh'; bash`, REASONS.pipedScript, BOTH],
  // Drop checkSourcedStdin: source and . of a stdin path run the pipe or redirect.
  [`echo "${PUSH}" | source /dev/stdin`, REASONS.noVerify, BOTH],
  [`echo "${PUSH}" | . /dev/stdin`, REASONS.noVerify, BOTH],
  [`echo "${PUSH}" | source /dev/fd/0`, REASONS.noVerify, BOTH],
  [`echo "${PUSH}" | . /proc/self/fd/0`, REASONS.noVerify, BOTH],
  [`echo "${PUSH}" | source /dev/./stdin`, REASONS.noVerify, BOTH],
  [`S=/dev/stdin; echo "${PUSH}" | source $S`, REASONS.noVerify, BOTH],
  [`source /dev/stdin < push.sh`, REASONS.pipedScript, BOTH],
  [`. /dev/stdin <<< '${PUSH}'`, REASONS.noVerify, BOTH],
  // Drop mayReadStdin from checkUnknownFeed: a shell's script file that is its stdin allows.
  [`bash /dev/stdin < push.sh`, REASONS.pipedScript, BOTH],
  // Check the -c string with the line's stdin, not the shell's own: an inner shell reads nothing.
  [`F=--no-verify; bash -c bash <<EOF\ngit push $F\nEOF`, REASONS.pipedScript, BOTH],
  [`F=--no-verify; bash -c bash <<< "git push $F"`, REASONS.pipedScript, BOTH],
  [`bash -c bash < push.sh`, REASONS.pipedScript, BOTH],
  [`bash -c bash < <(cat push.sh)`, REASONS.pipedScript, BOTH],
  [`F=--no-verify; sh -c sh <<-EOF\n\tgit push $F\n\tEOF`, REASONS.pipedScript, BOTH],
  [`F=--no-verify; bash -c "true; bash" <<EOF\ngit push $F\nEOF`, REASONS.pipedScript, BOTH],
  [`F=--no-verify; bash -c "cat | bash" <<EOF\ngit push $F\nEOF`, REASONS.pipedScript, BOTH],
  [`F=--no-verify; bash -c "eval bash" <<EOF\ngit push $F\nEOF`, REASONS.pipedScript, BOTH],
  [`bash -c 'exec <push.sh; bash'`, REASONS.pipedScript, BOTH],
  // Gate eval only on namesGit again: a line read from a file the guard cannot read runs.
  [`while read -r l; do eval "$l"; done < push.sh`, REASONS.hiddenScript, BOTH],
  // Mark a word LIVE at a `)` followed by `)`, as if it named a function: every nested row allows.
  ...['bash', 'sh', 'zsh', 'dash'].flatMap(sh =>
    (
      [
        [`echo "${PUSH}" | ( ( ${sh} ) )`, REASONS.pipedScript],
        [`echo "${PUSH}" | ( (${sh}) )`, REASONS.pipedScript],
        [`echo "${PUSH}" | ( true; ( ${sh} ) )`, REASONS.pipedScript],
        [`( ( ${sh} <<< "${PUSH}" ) )`, REASONS.noVerify],
      ] satisfies [string, string][]
    ).map(([src, why]): [string, string, string[]] => [src, why, fs.existsSync(`/bin/${sh}`) ? BOTH : []]),
  ),
]

// Each row's mutation: deny every indirect feed, or deny any redirect on a line that names git.
const BENIGN: [string, RegExp][] = [
  [`cat <<'EOF'\n${PUSH}\nEOF`, /^$/],
  [`{ cat; } <<'E'\n${PUSH}\nE`, /^$/],
  [`exec 2>/dev/null; git status`, /^status$/],
  [`exec < /dev/null; git status`, /^status$/],
  [`exec 3<push.sh; cat <&3; git status`, /^status$/],
  [`exec <<'E'\ngit status\nE\nbash`, /^status$/],
  [`{ bash; } <<'E'\ngit status\nE`, /^status$/],
  [`while read -r l; do echo "$l"; done < push.sh; git status`, /^status$/],
  [`f() { echo hi; }; f < push.sh; git status`, /^status$/],
  [`( cd /tmp && git status ) < /dev/null`, /^status$/],
  [`echo 'git status' | source /dev/stdin`, /^status$/],
  [`bash -c "read x; echo \\$x" <<< "$HOME"`, /^$/],
  [`echo hi | bash -c bash`, /^$/],
  [`git log --oneline | head -3`, /^log --oneline$/],
  [`f() ( bash ); git status`, /^status$/],
  [`( ( echo hi ) ); git status`, /^status$/],
]

describe('checkCommand on every stdin a shell reads its script from', () => {
  it.each(BYPASSES)('denies %j', (src, reason) => {
    expect(checkCommand(src, ctx())).toBe(reason)
  })

  it.each(BENIGN)('allows %j', src => {
    expect(checkCommand(src, ctx())).toBeUndefined()
  })
})

const real = fakeGitShells('agent-chat-pretool-stdin-', PUSH)
const shellsNamed = (names: readonly string[]) =>
  real.shells.filter(([shell]) => names.some(name => shell.endsWith(`/${name}`)))

afterAll(real.cleanup)

describe.skipIf(real.shells.length === 0)('real shells run what the guard reads from stdin', () => {
  it.each(BYPASSES)('each named shell pushes for %j', (src, _, names) => {
    const run = shellsNamed(names)
    for (const [shell, args] of run) expect(real.gitCalls(shell, args, src)).toBe('push --no-verify')
  })

  it.each(BENIGN)('every shell runs only what the guard read for %j', (src, calls) => {
    for (const [shell, args] of real.shells) expect(real.gitCalls(shell, args, src)).toMatch(calls)
  })
})
