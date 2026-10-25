/**
 * The builtins a shell git starts may run (TP-4236). git puts its exec-path first on that shell's
 * PATH, so the push shim never sees its git, and a builtin that loads code or changes what a command
 * word runs (`.`, `alias`, `hash -p`, `autoload`, `enable -f`, `zmodload`, `fc`, `emulate -c`) runs
 * text the guard never reads. So the set is an allow-list: every builtin name the observed shells
 * know is denied unless it is inert in every form, or inert in the form it is given.
 */

/**
 * Every builtin and precommand name of bash 5.3 (`enable -a`), zsh 5.9 with no module loaded
 * (`zsh -fc enable`), dash and busybox ash (`help`), and ksh93's own (`nameref`, `getconf`).
 * A name outside it is a program run from PATH, which the guard does not read either way.
 */
const BUILTINS: ReadonlySet<string> = new Set(
  (
    '- . : [ [[ alias autoload bg bind bindkey break builtin bye caller cd chdir command compadd ' +
    'comparguments compcall compctl compdescribe compfiles compgen complete compopt compgroups ' +
    'compquote compset comptags comptry compvalues continue declare dirs disable disown echo echotc ' +
    'echoti emulate enable eval exec exit export false fc fg float functions getconf getln getopts ' +
    'hash help history integer jobs kill let limit local log logout mapfile nameref noglob popd print ' +
    'printf private pushd pushln pwd r read readarray readonly rehash return sched set setopt shift ' +
    'shopt source suspend test times trap true ttyctl type typeset ulimit umask unalias unfunction ' +
    'unhash unlimit unset unsetopt vared wait whence where which zcompile zformat zle zmodload ' +
    'zparseopts zregexparse zstyle'
  ).split(' '),
)

/**
 * Builtins that load no code and leave command lookup alone in any form. `eval`, `trap`, `mapfile`
 * and `readarray` are here because the guard reads the text they run as part of the same shell, and
 * `.`, `source` and `alias` because the caller gives them their own reasons.
 */
const INERT: ReadonlySet<string> = new Set(
  (
    '- . : [ [[ alias bg break bye caller cd chdir command continue dirs disown echo echotc echoti ' +
    'eval exec exit false fg getconf getln getopts help history jobs kill let limit log logout ' +
    'mapfile noglob popd print printf pushd pushln pwd read readarray rehash return set setopt shift ' +
    'shopt source suspend test times trap true ttyctl type ulimit umask unalias unfunction unhash ' +
    'unlimit unset unsetopt vared wait whence where which zformat zparseopts zregexparse zstyle'
  ).split(' '),
)

/** Builtins that only list what they hold when given no words: `hash`, `functions`, `enable`, `zmodload`. */
const LIST_BARE: ReadonlySet<string> = new Set(
  'autoload builtin disable enable functions hash zmodload'.split(' '),
)

/**
 * Declarations that set only variables unless an option word turns on a function or other mode
 * (`typeset -fu` autoloads in zsh, `export -f` exports a function to child shells).
 */
const DECLARES: ReadonlySet<string> = new Set(
  'declare export float integer local nameref private readonly typeset'.split(' '),
)

const isOption = (word: string): boolean => word.startsWith('-') || word.startsWith('+')

/** Whether a builtin named `name`, given `args`, may load code or change what a command word runs. */
export function loadsOrRebinds(name: string, args: readonly string[]): boolean {
  if (!BUILTINS.has(name) || INERT.has(name)) return false
  if (LIST_BARE.has(name)) return args.length > 0
  if (DECLARES.has(name)) return args.some(isOption)
  return true
}
