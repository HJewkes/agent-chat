import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { SAFE_GIT_PROTOCOLS } from '../git.js'
import { ALIAS_NAME } from './git-alias.js'
import { ENVIRONMENT_SCRUB, hardenedShebang, posixShell } from './posix-shell.js'

/** Names the dir holding the agent's `git` shim in the launch plan; `run-agent` puts it first on PATH. */
export const GIT_SHIM_DIR_ENV = 'AGENT_CHAT_GIT_SHIM_DIR'

/** `<home>/git-bin`, beside the guard's `<home>/git-hooks`, so the pure plan builder needs no extra input. */
export const gitShimDirFor = (hooksDir: string): string => path.join(path.dirname(hooksDir), 'git-bin')

const shQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

// Global options whose value is the next word; every other leading dash word stands alone.
const VALUED_GLOBALS =
  '-C | -c | --git-dir | --work-tree | --namespace | --config-env | --attr-source | --super-prefix | --shallow-file'

const DOCS = 'See docs/leak-guard.md.'

// Every text filter runs as `LC_ALL=C`, so a byte that is not valid UTF-8 cannot make tr fail and blank a check; a failure still refuses.
const FILTER_FAILED =
  'refuse unresolved "a text filter failed, so the shim cannot tell whether this is a push."'

// Pure sh, no fork: sets q to $1 single-quoted for eval.
const QUOTE_FN = `sq="'"
quote() {
  q= rest=$1
  while :; do
    case $rest in
    *"$sq"*) q="$q\${rest%%"$sq"*}'\\\\''"; rest=\${rest#*"$sq"} ;;
    *) q="'$q$rest'"; return ;;
    esac
  done
}`

const REFUSE_FN = `refuse() {
  printf '%s\\n' "git-shim: push refused ($1): $2 ${DOCS}" >&2
  exit 2
}`

// A refused shell alias need not be a push, so this reason does not say "push refused".
const REFUSE_ALIAS_FN = `refuse_alias() {
  printf '%s\\n' "git-shim: refused (shell-alias): $1 ${DOCS}" >&2
  exit 2
}

listed() {
  for listed_name in $shell_aliases; do
    [ "$listed_name" = "$1" ] && return 0
  done
  return 1
}`

// git's split_cmdline: quotes group, a backslash escapes outside single quotes, an open quote fails.
const SPLIT_FN = `tab='	'
nl='
'
split() {
  s=$1 words= word= started= quoted=
  while [ -n "$s" ]; do
    c=\${s%"\${s#?}"}
    s=\${s#?}
    if [ -z "$quoted" ]; then
      case $c in
      ' ' | "$tab" | "$nl")
        [ -z "$started" ] || { quote "$word"; words="$words $q"; word= started=; }
        continue ;;
      \\' | \\") quoted=$c started=1; continue ;;
      esac
    elif [ "$c" = "$quoted" ]; then
      quoted=
      continue
    fi
    if [ "$c" = \\\\ ] && [ "$quoted" != \\' ]; then
      [ -n "$s" ] || return 1
      c=\${s%"\${s#?}"}
      s=\${s#?}
    fi
    word=$word$c started=1
  done
  [ -z "$quoted" ] || return 1
  [ -z "$started" ] || { quote "$word"; words="$words $q"; }
}`

// A direct remote-ext call runs its argument as a shell command without the GIT_ALLOW_PROTOCOL check.
const REFUSE_EXT_FN = `refuse_ext() {
  printf '%s\\n' "git-shim: refused (ext-transport): git remote-ext runs its argument as a shell command, which GIT_ALLOW_PROTOCOL does not stop. ${DOCS}" >&2
  exit 2
}`

// help.autocorrect would run a command the shim never checked; only values git documents as "do not run" pass.
const AUTOCORRECT_FN = `autocorrect_off() {
  ac=$(eval "\\"\\$real\\"$globals config --get --type=bool-or-int help.autocorrect" 2>/dev/null)
  case $? in
  1) return 0 ;;
  0) case $ac in false | 0) return 0 ;; esac; return 1 ;;
  esac
  ac=$(eval "\\"\\$real\\"$globals config --get help.autocorrect" 2>/dev/null)
  case $ac in never | show) return 0 ;; esac
  return 1
}`

// git's own "most similar command" list for a word, read with autocorrect off so nothing runs.
const TYPO_FN = `refuse_typo() {
  similar=$(eval "\\"\\$real\\"$globals -c help.autocorrect=0 \\"\\$1\\"" 2>&1)
  case $similar$nl in *"$tab"push"$nl"*)
    refuse autocorrect "$1 is not a git command and help.autocorrect would run its correction unchecked; set it to show or never." ;;
  esac
  printf '%s\\n' "git-shim: refused (autocorrect): '$1' is not a git command and help.autocorrect would run git's guess at it unchecked; fix the typo, or set help.autocorrect to show or never. ${DOCS}" >&2
  exit 2
}`

// A word git finds as git-<word> on its exec path or PATH runs that command, so git never autocorrects it.
const EXTERNAL_FN = `external() {
  case $1 in */*) return 1 ;; esac
  saved=$PATH
  PATH=\${exec_path:+$exec_path:}$PATH
  command -v "git-$1" >/dev/null 2>&1
  found=$?
  PATH=$saved
  return $found
}`

// git stash push is not a push; push passes only right after stash as git's subcommand, past its global options.
const MENTIONS_PUSH_FN = `mentions_push() {
  stripped=$(printf '%s' "\${1#!}" | LC_ALL=C tr -d "\\"'\\\\\\\\") || ${FILTER_FAILED}
  set -f
  set -- $stripped
  set +f
  at=
  for tok; do
    case $at in
    globals)
      case $tok in
      ${VALUED_GLOBALS}) at=value ;;
      -*) ;;
      stash) at=stash ;;
      *) at= ;;
      esac ;;
    value) at=globals ;;
    stash) at=; [ "$tok" = push ] && continue ;;
    *) [ "$tok" = git ] && at=globals ;;
    esac
    case $tok in *push*) return 0 ;; esac
  done
  return 1
}`

// git appends the arguments to a ! alias, which may read, glob, decode or eval them, so push in any case, a glob, an escape or a $, backtick or { counts.
const ARGS_PUSH_FN = `args_push() {
  flat=$(printf '%s' "$*" | LC_ALL=C tr -d " \\t\\n\\"'") || ${FILTER_FAILED}
  flat=$(printf '%s' "$flat" | LC_ALL=C tr A-Z a-z) || ${FILTER_FAILED}
  case $flat in *push* | *'\\'* | *'?'* | *'*'* | *'['* | *'$'* | *'\`'* | *'{'*) return 0 ;; esac
  return 1
}`

// git config reads only $GIT_CONFIG while git ignores it for aliases and hooks, so every read the shim makes runs without it.
const HIDE_GIT_CONFIG = `unset caller_git_config
case \${GIT_CONFIG+set} in set) caller_git_config=$GIT_CONFIG; unset GIT_CONFIG ;; esac`
const RESTORE_GIT_CONFIG = `[ -z "\${caller_git_config+set}" ] || export GIT_CONFIG="$caller_git_config"`

// pinGitProtocols in sh: git reads GIT_ALLOW_PROTOCOL over every protocol.*.allow scope, so `ext::` never runs (CC-1095).
const PIN_PROTOCOLS = `safe_protocols=${shQuote(SAFE_GIT_PROTOCOLS.join(':'))}
if [ -n "\${GIT_ALLOW_PROTOCOL+set}" ]; then
  pinned= rest=$GIT_ALLOW_PROTOCOL:
  while [ -n "$rest" ]; do
    protocol=\${rest%%:*} rest=\${rest#*:}
    case :$safe_protocols: in *":$protocol:"*) [ -z "$protocol" ] || pinned=\${pinned:+$pinned:}$protocol ;; esac
  done
else
  pinned=$safe_protocols
fi
export GIT_ALLOW_PROTOCOL="$pinned"`

// Sets policy to the last protocol.<name>.allow in a dump on stdin (one "key SOH value" line each), else the last protocol.allow, else unset.
const POLICY_FN = `policy_of() {
  policy=unset own=
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    key=\${line%%"$soh"*} value=\${line#*"$soh"}
    [ "$key" != "$line" ] || value=
    case $key in
    "protocol.$1.allow") policy=$value own=1 ;;
    protocol.allow) [ -n "$own" ] || policy=$value ;;
    esac
  done
}

keep_allowed() {
  narrowed= rest=$GIT_ALLOW_PROTOCOL:
  while [ -n "$rest" ]; do
    protocol=\${rest%%:*} rest=\${rest#*:}
    [ -n "$protocol" ] || continue
    policy_of "$protocol" <<EOF
$1
EOF
    case $policy in unset | [Aa][Ll][Ww][Aa][Yy][Ss]) narrowed=\${narrowed:+$narrowed:}$protocol ;; esac
  done
  GIT_ALLOW_PROTOCOL=$narrowed
}`

// Reads one source, run by the command in $2; a free read ($1), made outside the repo git will use, queues every includeIf target.
// The dump alternates origin lines and "key SOH value" lines; an origin never equals a protocol key, so keep_allowed takes it whole.
const NARROW_BY_FN = `narrow_by() {
  dump=$({ eval "$2 --show-origin -z --get-regexp '^(protocol[.]|init[.]templatedir\\$|includeif[.].*[.]path\\$)'" 2>/dev/null; printf '\\0%s' "$?"; } | LC_ALL=C tr '\\n\\0' "$soh$nl")
  case \${dump##*"$nl"} in 0 | 1) ;; *) GIT_ALLOW_PROTOCOL=; return ;; esac
  keep_allowed "\${dump%"$nl"*}"
  origin=
  while IFS= read -r line; do
    if [ -z "$origin" ]; then origin=$line; continue; fi
    case \${line%%"$soh"*} in
    init.templatedir) add_template "\${line#*"$soh"}" ;;
    includeif.*.path) [ "$1" = repo ] || add_include "$origin" "\${line#*"$soh"}" ;;
    esac
    origin=
  done <<EOF
\${dump%"$nl"*}
EOF
}`

// A free read, then every includeIf target it names with the condition ignored, to git's include depth of 10.
// Outside the repo git will use, a gitdir, onbranch or hasconfig condition cannot be told, so the union narrows more and never less.
const NARROW_FREE_FN = `narrow_free() {
  includes= include_depth=0
  narrow_by free "$1"
  while [ -n "$includes" ]; do
    include_depth=$((include_depth + 1))
    [ "$include_depth" -le 10 ] || { GIT_ALLOW_PROTOCOL=; return; }
    batch=$includes includes=
    eval "set -- $batch"
    for file; do
      quote "$file"
      narrow_by free "GIT_DIR=/dev/null \\"\\$real\\"$cdglobals config --includes --file $q"
    done
  done
}`

// Sets q to a config path quoted, with ~/ and ~ expanded as git does; ~user, %(prefix), :(optional) or a newline fail.
const CONFIG_PATH_FN = `config_path() {
  case $1 in
  *"$soh"* | '~'[!/]* | '%('* | ':('*) return 1 ;;
  '~') quote "$HOME" ;;
  '~/'*) quote "$HOME/\${1#'~/'}" ;;
  *) quote "$1" ;;
  esac
}`

// Adds a template dir, whose config git copies into each repo it creates, to templates; one it cannot place empties the list.
const ADD_TEMPLATE_FN = `add_template() {
  [ -n "$1" ] || return 0
  config_path "$1" || { GIT_ALLOW_PROTOCOL=; return; }
  templates="$templates $q"
}`

// Adds an includeIf target to includes; a relative one resolves beside the file that names it, as git's does.
// A template's relative target lands beside the copy in the new repo, so a .. in it, or one from no file, empties the list.
const ADD_INCLUDE_FN = `add_include() {
  target=$2
  case $target in
  '') return 0 ;;
  '~'* | /* | '%('* | ':('*) ;;
  .. | ../* | */.. | */../*) GIT_ALLOW_PROTOCOL=; return ;;
  *)
    case $1 in
    file:*/*) target=\${1#file:} target=\${target%/*}/$2 ;;
    file:*) ;;
    *) GIT_ALLOW_PROTOCOL=; return ;;
    esac ;;
  esac
  config_path "$target" || { GIT_ALLOW_PROTOCOL=; return; }
  includes="$includes $q"
}`

// Sets clone_cfg to clone's own -c and --config values, which clone writes into the new repo before it fetches, and adds its --template dirs.
// A c anywhere in a short cluster before a valued flag counts, so a misread narrows and never widens.
const CLONE_CONFIGS_FN = `clone_configs() {
  cloning=1 clone_cfg=
  while [ $# -gt 0 ]; do
    kind= next= value=
    case $1 in
    --) return ;;
    --co | --con | --conf | --confi | --config) kind=c next=1 ;;
    --co=* | --con=* | --conf=* | --confi=* | --config=*) kind=c value=\${1#*=} ;;
    --te | --tem | --temp | --templ | --templa | --templat | --template) kind=t next=1 ;;
    --te=* | --tem=* | --temp=* | --templ=* | --templa=* | --templat=* | --template=*) kind=t value=\${1#*=} ;;
    --*) ;;
    -?*)
      rest=\${1#-}
      while [ -n "$rest" ]; do
        c=\${rest%"\${rest#?}"} rest=\${rest#?}
        case $c in [obju]) break ;; c) kind=c value=$rest; [ -n "$rest" ] || next=1; break ;; esac
      done ;;
    esac
    if [ -n "$next" ] && [ $# -ge 2 ]; then value=$2; shift; fi
    case $kind in
    c) quote "$value"; clone_cfg="$clone_cfg -c $q" ;;
    t) add_template "$value" ;;
    esac
    shift
  done
}`

// Every template a clone, or a submodule clone under any command, may copy: --template, GIT_TEMPLATE_DIR and init.templateDir.
// The union narrows more than the one git picks, never less; a relative dir resolves under the caller's -C, as git's does.
const NARROW_TEMPLATES_FN = `narrow_templates() {
  add_template "\${GIT_TEMPLATE_DIR:-}"
  eval "set -- $templates"
  for dir; do
    quote "$dir/config"
    narrow_free "GIT_DIR=/dev/null \\"\\$real\\"$cdglobals config --includes --file $q"
  done
}`

// Sets found to where git keeps $1 for the repo the caller's options name, so a linked worktree's own dirs are the ones read.
const GIT_PATH_FN = `git_path() {
  found=$(eval "\\"\\$real\\"$globals rev-parse --path-format=absolute --git-path \\"\\$1\\"" 2>/dev/null) || return 1
  found=\${found%%"$nl"*}
  [ -n "$found" ]
}`

// A recursing command's children run real git in each submodule with the exported list, which outranks the submodule's own config.
// Reads every git dir under git's modules path, per worktree; a submodule whose git dir sits in its own work tree is not read.
const NARROW_SUBMODULES_FN = `narrow_submodules() {
  git_path modules && [ -d "$found" ] || return 0
  modules=$found
  gitdirs=$(find "$modules" -type d -name objects -prune -print 2>/dev/null) || { GIT_ALLOW_PROTOCOL=; return; }
  while IFS= read -r objects; do
    case $objects in '') continue ;; "$modules/"*/objects) ;; *) GIT_ALLOW_PROTOCOL=; return ;; esac
    quote "\${objects%/objects}"
    narrow_by repo "\\"\\$real\\" --git-dir=$q config"
  done <<EOF
$gitdirs
EOF
}`

// git reads GIT_ALLOW_PROTOCOL over protocol.*.allow, so the pin keeps only protocols every config git may consult allows outright (CC-1336).
// A list cannot say "only from the user", so a user policy drops. Every place a command may read config from is listed here once:
// the caller's repo; the caller's config without a repo, which a clone, a submodule clone or any repo a child creates starts from;
// clone's own -c values; each submodule git dir outside a clone; and each template.
const NARROW_FN = `narrow_protocols() {
  narrow_by repo "\\"\\$real\\"$globals config"
  narrow_free "GIT_DIR=/dev/null \\"\\$real\\"$cfgglobals config"
  [ -z "$clone_cfg" ] ||
    narrow_free "GIT_DIR=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_COUNT=0 GIT_CONFIG_PARAMETERS= \\"\\$real\\"$clone_cfg config"
  [ -n "$cloning" ] || narrow_submodules
  narrow_templates
  export GIT_ALLOW_PROTOCOL
}`

// A listed name runs only the body in the config files the agent had at spawn: a -c, --config-env or
// GIT_CONFIG_* value, an include one adds, or a HOME, XDG_CONFIG_HOME or GIT_CONFIG_* file swap must not replace it.
const SHADOWED_FN = `shadowed() {
  origins=$(eval "\\"\\$real\\"$globals config --show-origin --get-all \\"alias.\\$1\\"" 2>/dev/null) || return 0
  case $nl$origins in *"$nl"'command line:'*) return 0 ;; esac
  body=$(unset GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM GIT_CONFIG_NOSYSTEM HOME XDG_CONFIG_HOME
    [ -z "$spawn_home" ] || export HOME="$spawn_home"
    [ -z "$spawn_xdg" ] || export XDG_CONFIG_HOME="$spawn_xdg"
    eval "\\"\\$real\\"$fileglobals config --get \\"alias.\\$1\\"" 2>/dev/null) || return 0
  [ "$body" != "$alias" ]
}`

// Fails closed: a word it cannot resolve, or an alias chain past the cap, refuses rather than execs.
const RESOLVE_FN = `resolve() {
  globals= fileglobals= cfgglobals= cdglobals= cloning= depth=0
  while [ $# -gt 0 ]; do
    case $1 in
    ${VALUED_GLOBALS})
      [ $# -ge 2 ] || return 1
      quote "$1"; globals="$globals $q"; option=$q; quote "$2"; globals="$globals $q"
      case $1 in -c | --config-env) cfgglobals="$cfgglobals $option $q" ;; *) fileglobals="$fileglobals $option $q" ;; esac
      [ "$1" != -C ] || cdglobals="$cdglobals $option $q"
      shift 2; continue ;;
    -*)
      quote "$1"; globals="$globals $q"
      case $1 in -c?* | --config-env=*) cfgglobals="$cfgglobals $q" ;; *) fileglobals="$fileglobals $q" ;; esac
      shift; continue ;;
    push) break ;;
    clone) shift; clone_configs "$@"; return 1 ;;
    remote-ext) refuse_ext ;;
    esac
    case " $builtins " in *" $1 "*) return 1 ;; esac
    alias=$(eval "\\"\\$real\\"$globals config --get \\"alias.\\$1\\"" 2>/dev/null)
    case $? in
    0) ;;
    1)
      external "$1" || autocorrect_off || refuse_typo "$1"
      return 1 ;;
    *) refuse unresolved "git could not read alias.$1, so the shim cannot tell whether this is a push." ;;
    esac
    case $alias in
    !*)
      name=$1
      listed "$name" ||
        refuse_alias "alias.$name runs a shell command and is not on the shell alias allowlist; run the command directly."
      shadowed "$name" &&
        refuse_alias "alias.$name is on the shell alias allowlist but is set by -c, --config-env, GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT or an include they add; only its config file text runs."
      shift
      args_push "$@" &&
        refuse shell-alias "alias.$name is an allowlisted shell alias and its arguments mention push or hold a glob, backslash, $, backtick or brace; run the command directly."
      mentions_push "$alias $*" &&
        refuse shell-alias "alias.$name is an allowlisted shell alias and the command mentions push; run git push directly."
      return 1 ;;
    esac
    split "$alias" || refuse unresolved "alias.$1 has an open quote or a trailing backslash."
    depth=$((depth + 1))
    [ "$depth" -le 10 ] || refuse alias-depth "alias.$1 is more than 10 aliases deep."
    shift
    eval "set -- $words \\"\\$@\\""
  done
  [ $# -gt 0 ] || return 1
  shift
  pushargs=
  for word; do
    case $word in --no-veri*) refuse no-verify "git push --no-verify skips the pre-push leak scan." ;; esac
    quote "$word"; pushargs="$pushargs $q"
  done
}`

const CFG_FN = `cfg() {
  eval "\\"\\$real\\"$globals config \\"\\$@\\""
}`

// Sets vals to one "=<value>" line per value; a read error or a value holding a newline is status 2.
const VALUES_FN = `soh=$(printf '\\001')
values() {
  vals=
  cfg --get-all "$1" >/dev/null 2>&1
  case $? in 0) ;; 1) return 1 ;; *) return 2 ;; esac
  raw=$({ cfg -z --get-all "$1" 2>/dev/null || echo "$soh"; } | LC_ALL=C tr '\\n\\0' '\\001\\n') || return 2
  vals=$(printf '%s\\n' "$raw" | LC_ALL=C sed 's/^/=/') || return 2
  case $vals in *"$soh"*) return 2 ;; esac
}`

// git's url_is_local_not_ssh: a colon before any slash is a URL, a <transport>:: helper or host:path.
const IS_LOCAL_FN = `is_local() {
  case $1 in
  '') return 1 ;;
  file://*) return 0 ;;
  esac
  head=\${1%%:*}
  [ "$head" = "$1" ] && return 0
  case $head in */*) return 0 ;; esac
  return 1
}`

// Adds a URL and every insteadOf or pushInsteadOf rewrite of it to cands: a superset of what git sends to.
const EXPAND_FN = `expand() {
  cands="$cands$nl=$1"
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    values "$key"; [ $? -le 1 ] || return 1
    base=\${key#url.}; base=\${base%.*}
    while IFS= read -r v; do
      [ -n "$v" ] || continue
      v=\${v#=}
      case $1 in "$v"*) cands="$cands$nl=$base\${1#"$v"}" ;; esac
    done <<EOF
$vals
EOF
  done <<EOF
$rules
EOF
}`

// A remote's pushurls, else its urls, else the word itself as a URL, the way git's remote_get reads it.
const DESTINATIONS_FN = `destinations() {
  case $1 in '' | . | .. | */*) expand "$1"; return ;; esac
  for key in vcs receivepack; do
    values "remote.$1.$key"; [ $? -eq 1 ] || return 1
  done
  [ ! -e "$common/remotes/$1" ] && [ ! -e "$common/branches/$1" ] || return 1
  values "remote.$1.pushurl"
  case $? in
  0) ;;
  1) values "remote.$1.url"; case $? in 0) ;; 1) vals="=$1" ;; *) return 1 ;; esac ;;
  *) return 1 ;;
  esac
  while IFS= read -r u; do
    [ -z "$u" ] || expand "\${u#=}" || return 1
  done <<EOF
$vals
EOF
}`

// git's pushremote_for_branch; every value counts, and a detached HEAD fails closed.
const DEFAULT_REMOTE_FN = `default_remote() {
  ref=$(eval "\\"\\$real\\"$globals symbolic-ref -q HEAD" 2>/dev/null) || return 1
  case $ref in refs/heads/?*) b=\${ref#refs/heads/} ;; *) return 1 ;; esac
  for key in "branch.$b.pushRemote" remote.pushDefault "branch.$b.remote"; do
    values "$key"
    case $? in 0) repos="$repos$nl$vals"; return 0 ;; 1) ;; *) return 1 ;; esac
  done
  repos="$repos$nl=origin"
}`

// A short-option cluster of push's valueless flags, which may end in -o taking the next word.
const CLUSTER_FN = `cluster() {
  rest=\${1#-}
  while [ -n "$rest" ]; do
    c=\${rest%"\${rest#?}"}
    rest=\${rest#?}
    case $c in
    [46dfnquv]) ;;
    o) [ -n "$rest" ] || skip=value; return 0 ;;
    *) return 1 ;;
    esac
  done
}`

const PUSH_TOGGLES = [
  'verbose',
  'quiet',
  'all',
  'branches',
  'mirror',
  'delete',
  'tags',
  'dry-run',
  'porcelain',
  'force',
  'force-with-lease',
  'force-if-includes',
  'thin',
  'set-upstream',
  'progress',
  'prune',
  'follow-tags',
  'signed',
  'atomic',
]

// Flags that take no value and cannot change where a push goes; any other option fails closed.
const PLAIN_FLAGS = [
  ...PUSH_TOGGLES.flatMap(flag => [`--${flag}`, `--no-${flag}`]),
  ...['repo', 'recurse-submodules', 'push-option', 'receive-pack', 'exec'].map(flag => `--no-${flag}`),
  '--verify',
  '--ipv4',
  '--ipv6',
].join(' | ')

// Sets repos to the repository words a push names; --receive-pack, --exec and submodule pushes fail closed.
const PUSH_REPOS_FN = `push_repos() {
  repos= skip= positional= ended=
  for w; do
    case $w in *"$nl"*) return 1 ;; esac
    case $skip in
    repo) repos="$repos$nl=$w"; skip=; continue ;;
    value) skip=; continue ;;
    submodules) case $w in check | no) skip=; continue ;; esac; return 1 ;;
    esac
    [ -n "$ended" ] || case $w in
    --) ended=1; continue ;;
    --repo) skip=repo; continue ;;
    --repo=*) repos="$repos$nl=\${w#--repo=}"; continue ;;
    -o | --push-option) skip=value; continue ;;
    --recurse-submodules) skip=submodules; continue ;;
    -o?* | --push-option=* | --force-with-lease=* | --signed=* | --recurse-submodules=check | --recurse-submodules=no | ${PLAIN_FLAGS}) continue ;;
    -[46dfnquv]*) cluster "$w" || return 1; continue ;;
    -*) return 1 ;;
    esac
    [ -n "$positional" ] || positional=$w
  done
  [ -z "$skip" ] || return 1
  if [ -n "$positional" ]; then repos="=$positional"; else default_remote; fi
}`

const SUBMODULES_OFF_FN = `submodules_off() {
  for key in push.recurseSubmodules submodule.recurse; do
    ac=$(cfg --get "$key" 2>/dev/null)
    case $? in 1) continue ;; 0) ;; *) return 1 ;; esac
    case $ac in no | false | check | 0 | off) ;; *) return 1 ;; esac
  done
}`

// True only when every destination of this push is a path or file:// URL, which cannot leave the machine.
const LOCAL_ONLY_FN = `local_only() {
  common=$(eval "\\"\\$real\\"$globals rev-parse --path-format=absolute --git-common-dir" 2>/dev/null) || return 1
  rules=$(cfg --name-only --get-regexp '^url\\..*\\.(push)?insteadof$' 2>/dev/null)
  case $? in 0 | 1) ;; *) return 1 ;; esac
  submodules_off || return 1
  eval "set -- $pushargs"
  push_repos "$@" || return 1
  cands=
  while IFS= read -r r; do
    [ -z "$r" ] || destinations "\${r#=}" || return 1
  done <<EOF
$repos
EOF
  [ -n "$cands" ] || return 1
  while IFS= read -r c; do
    [ -z "$c" ] || is_local "\${c#=}" || return 1
  done <<EOF
$cands
EOF
}`

const HOOKS_CHECK = `hooks=$(eval "\\"\\$real\\"$globals config --get core.hooksPath" 2>/dev/null)
[ "$hooks" = "$guard" ] || local_only ||
  refuse hooks-path "core.hooksPath is not the leak guard's hooks dir and a destination is not a local repository, so the pre-push leak scan would not run."`

/** Only names an alias can have, lowercased, so a listed name can never inject shell into the shim. */
const bakedShellAliases = (names: readonly string[]): string =>
  names
    .filter(name => ALIAS_NAME.test(name))
    .map(name => name.toLowerCase())
    .join(' ')

/** The config-file locations the agent starts with, baked so one call cannot swap them. */
export interface SpawnConfigHome {
  HOME?: string
  XDG_CONFIG_HOME?: string
}

/**
 * The agent's `git`: a push, found after global options or through `alias.<word>`, is refused when
 * it skips verification or when the hooks path git resolves is not the guard's. A shell (`!`)
 * alias runs only when its name is in `shellAliases` (CC-613). Everything else execs the real
 * git, baked as an absolute path so the shim never finds itself.
 */
export const gitShimScript = (
  real: string,
  guard: string,
  builtins: readonly string[],
  execPath = '',
  shell = posixShell(),
  shellAliases: readonly string[] = [],
  spawnHome: SpawnConfigHome = {},
): string =>
  `${hardenedShebang(shell)}
# Written by agent-chat at each spawn (TP-596); local edits are overwritten.
${ENVIRONMENT_SCRUB}${HIDE_GIT_CONFIG}
${PIN_PROTOCOLS}
real=${shQuote(real)}
guard=${shQuote(guard)}
exec_path=${shQuote(execPath)}
builtins=${shQuote(builtins.join(' '))}
[ -n "$builtins" ] || builtins=$("$real" --list-cmds=builtins 2>/dev/null | LC_ALL=C tr '\\n' ' ')
shell_aliases=${shQuote(bakedShellAliases(shellAliases))}
spawn_home=${shQuote(spawnHome.HOME ?? '')}
spawn_xdg=${shQuote(spawnHome.XDG_CONFIG_HOME ?? '')}
${QUOTE_FN}
${REFUSE_FN}
${REFUSE_ALIAS_FN}
${REFUSE_EXT_FN}
${SPLIT_FN}
${AUTOCORRECT_FN}
${TYPO_FN}
${EXTERNAL_FN}
${MENTIONS_PUSH_FN}
${ARGS_PUSH_FN}
${SHADOWED_FN}
${RESOLVE_FN}
${CFG_FN}
${VALUES_FN}
${IS_LOCAL_FN}
${EXPAND_FN}
${DESTINATIONS_FN}
${DEFAULT_REMOTE_FN}
${CLUSTER_FN}
${PUSH_REPOS_FN}
${SUBMODULES_OFF_FN}
${LOCAL_ONLY_FN}
${POLICY_FN}
${NARROW_BY_FN}
${NARROW_FREE_FN}
${CONFIG_PATH_FN}
${ADD_TEMPLATE_FN}
${ADD_INCLUDE_FN}
${CLONE_CONFIGS_FN}
${NARROW_TEMPLATES_FN}
${GIT_PATH_FN}
${NARROW_SUBMODULES_FN}
${NARROW_FN}
templates=
if resolve "$@"; then
${HOOKS_CHECK}
fi
narrow_protocols
${RESTORE_GIT_CONFIG}
exec "$real" "$@"
`

const realpathOr = (file: string): string => {
  try {
    return fs.realpathSync(file)
  } catch {
    return file
  }
}

const isExecutableFile = (file: string): boolean => {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** The first `git` on PATH that is not the shim; kept unresolved so a package upgrade does not strand it. */
export function findRealGit(pathValue: string, shimDir: string): string | undefined {
  const shim = realpathOr(path.join(shimDir, 'git'))
  const ownDir = realpathOr(shimDir)
  for (const dir of pathValue.split(path.delimiter)) {
    if (!path.isAbsolute(dir) || realpathOr(dir) === ownDir) continue
    const candidate = path.join(dir, 'git')
    if (isExecutableFile(candidate) && realpathOr(candidate) !== shim) return candidate
  }
  return undefined
}

/** Empty on failure; the shim then reads the list itself on each call, and `push` is matched by name first. */
const gitExecPath = (real: string): string => {
  try {
    return execFileSync(real, ['--exec-path'], { encoding: 'utf8', timeout: 5000 }).trim()
  } catch {
    return ''
  }
}

function gitBuiltins(real: string): string[] {
  try {
    return execFileSync(real, ['--list-cmds=builtins'], { encoding: 'utf8', timeout: 5000 })
      .split('\n')
      .filter(name => /^[a-z0-9-]+$/.test(name))
  } catch {
    return []
  }
}

/** Rewritten through a rename, so a git call at that moment never execs a half-written file. */
export function writeGitShim(
  dir: string,
  guard: string,
  pathValue: string = process.env.PATH ?? '',
  shellAliases: readonly string[] = [],
  spawnHome: SpawnConfigHome = process.env,
): boolean {
  const real = findRealGit(pathValue, dir)
  if (real === undefined) return false
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const target = path.join(dir, 'git')
  const temp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(
    temp,
    gitShimScript(real, guard, gitBuiltins(real), gitExecPath(real), posixShell(), shellAliases, spawnHome),
    { mode: 0o755 },
  )
  fs.chmodSync(temp, 0o755)
  fs.renameSync(temp, target)
  return true
}
