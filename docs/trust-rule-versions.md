# Trust rule versions

The burndown trust gate (`src/agents/burndown/trust-gate.ts`) refuses a seats-mode
dispatch unless the installed Claude Code is one whose startup trust rule was read
from its own bundle and matches the rule `src/agents/trust.ts` reproduces. The
verified set is `VERIFIED_TRUST_RULE_VERSIONS` in `trust.ts`; an unverified or
unknown version is refused, because a spawned agent must never land in an untrusted
folder (a hung dialog nobody answers).

## The reproduced rule

Read from the 2.1.284 bundle (`sF`, `VRe`, `hS`, `yS`, `Qt`), then compared with later releases:

- (a) the global config file: a legacy `.config.json` in the config home if it exists, else `.claude.json` in `CLAUDE_CONFIG_DIR` or the home directory;
- (b) keys: the canonical repo root first, then the folder and each ancestor up to its git root (up to `/` outside git);
- (c) a linked worktree's canonical root is its main checkout, resolved through `.git`, `commondir` and the back-pointing `gitdir` file;
- (d) the flag is `projects[key].hasTrustDialogAccepted`.

## Verified releases

The 2.1.284 bundle is no longer on disk, so each later release was compared with the rule
above and with `trust.ts`, not with 2.1.284's code. Checked 2026-10-05 against the
bundles in `~/.local/share/claude/versions/`.

| Release | Checked against                | (a) | (b) | (c) | (d) |
| ------- | ------------------------------ | --- | --- | --- | --- |
| 2.1.284 | itself (original reproduction) | yes | yes | yes | yes |
| 2.1.287 | 2.1.284 rule                   | yes | yes | yes | yes |
| 2.1.288 | 2.1.284 rule                   | yes | yes | yes | yes |
| 2.1.289 | 2.1.284 rule                   | yes | yes | yes | yes |
| 2.1.290 | 2.1.289                        | yes | yes | yes | yes |
| 2.1.295 | 2.1.292 (2026-10-08)           | yes | yes | yes | yes |
| 2.1.296 | 2.1.295 (2026-10-10)           | yes | yes | yes | yes |

2.1.287, 2.1.288, 2.1.289 and 2.1.290 are identical in all four snippets below once minified
identifiers are renamed (a token-level comparison; only the names differ).

## 2.1.289 code (2.1.290 is token-identical)

`node scripts/verify-trust-rule.mjs <version>` prints these snippets for any installed release.

(b)/(d) trust check (`G0`) and key walk (`jE`, `zE`):

```js
function G0() {
  if (a.CLAUDE_CODE_SANDBOXED) return !0
  if (cge()) return !0
  let e = le(),
    n = K0e()
  if (e.projects?.[n]?.hasTrustDialogAccepted) return !0
  return jE(e, Ee()) !== null
}
function jE(e, n) {
  let r = Nn(Xe(n)),
    s = Vrr(r)
  if (s?.rootOnly) {
    let g = mB(Xe(s.root))
    return e.projects?.[g]?.hasTrustDialogAccepted === !0 ? g : null
  }
  return zE(e, r, s !== null ? mB(Xe(s.root)) : null)
}
function Vrr(e) {
  let n = Nn(Xe(e)),
    r = gsr(n, { uncached: !0 })
  if (r !== null && msr(r.root, { uncached: !0 }) !== !0) return { root: r.root, rootOnly: !0 }
  let s = $_(n)
  return s !== null ? { root: s, rootOnly: !1 } : null
}
function zE(e, n, r) {
  let s = mB(n)
  while (!0) {
    if (!(r === null || s === r || s.startsWith(r.endsWith('/') ? r : r + '/'))) return null
    if (e.projects?.[s]?.hasTrustDialogAccepted) return s
    if (s === r) return null
    let h = mB(Xe(s, '..'))
    if (h === s) return null
    s = h
  }
}
```

(c) worktree to main checkout (`tn`):

```js
function tn(e, n) {
  try {
    let r = n.trim()
    if (!r.startsWith('gitdir:')) return e
    let o = r.slice(7).trim()
    if (Bi(o, e)) return e
    if (hy(o, e)) return e
    let s = N(e, o)
    if (GL(x(s, 'commondir'), s)) return e
    let i = B(x(s, 'commondir'), 'utf-8').trim()
    if (Bi(i, s)) return e
    if (hy(i, s)) return e
    let u = N(s, i)
    if (N(V(s)) !== x(u, 'worktrees')) return e
    if (GL(x(s, 'gitdir'), s)) return e
    let f = B(x(s, 'gitdir'), 'utf-8').trim()
    if (Bi(f, e)) return e
    if (hy(f, s, e)) return e
    if (ye(N(s, f)) !== x(ye(e), '.git')) return e
    if (he(u) !== '.git') {
      if (Me(x(u, '.git'), u)) return e
      return Nn(u)
    }
    return Nn(V(u))
  } catch {
    return e
  }
}
```

(b) git root finder (`en`, start of the function):

```js
function en(e){let n=Date.now();te("info","find_git_root_started");let r=N(e),o=r.substring(0,r.indexOf(T)+1)||T,s=0;while(r!==o){let i=x(r,".git");if(s++,Me(i,r))return …
```

(a) global config file (`To`, `Dlr`):

```js
function To() {
  if (se().existsSync(i(we(), '.config.json'))) return i(we(), '.config.json')
  return Dlr()
}
function Dlr() {
  let o = `.claude${kV()}.json`
  return i(process.env.CLAUDE_CONFIG_DIR || Ao(), o)
}
```

## 2.1.295 (checked 2026-10-08 against the 2.1.292 bundle)

`node scripts/verify-trust-rule.mjs 2.1.295` printed NOT FOUND for the trust check and the
git-root finder only because the old matcher used `\w` for identifiers and 2.1.295 names
two of them with `$` (`gl`, `j$e`). The rule itself is unchanged. Byte offsets in
`~/.local/share/claude/versions/2.1.295`, compared token by token (identifiers renamed in
order of appearance) with 2.1.292:

- trust check `jB` at 209633308, key walk `Ow`, `YEr`, `Mw`: identical to 2.1.292's `Y0`, `zE`, `ogr`, `VE`. The one change is the config source: `let e=gl()` where 2.1.292 had `ce()`, and `gl()` is `De()?{}:ce()`.
- project key `j$e` (209665952), `JA`, `Uz`, `oy`: identical to 2.1.292's `$0e`, `sA`, `fW`, `E_`.
- worktree resolver `Xn` (208640846): identical to 2.1.292.
- git root finder `zn` (208639170): identical except a new first statement `if(De())return G8;` (`G8` is the not-found sentinel).
- global config file `Tt`/`jRr` (206870003): identical; suffix function `BY()` unchanged (`-custom-oauth` when `CLAUDE_CODE_CUSTOM_OAUTH_URL` is set).
- the `rootOnly` input finder is still dead: `xr(e,{uncached:n=!1}={}){return!1}` (near 208693100), so `MTr` never returns a root.

`De()` is `host.launchOptions.diskless()`, a session with no storage backend (no shell, no
skills, no config reads). In that mode the CLI sees no config and no git root, so it
treats every folder as untrusted. A local tmux seat is never diskless, and the gate is the
looser side of that difference only in a mode where the CLI cannot run commands at all.

2.1.293 and 2.1.294 are on disk but were not part of this check and stay unverified.

## 2.1.296 (checked 2026-10-10 against the 2.1.295 bundle)

`node scripts/verify-trust-rule.mjs 2.1.296` output matches (a)-(d) above; only the minified names differ:

- (a) `Tt()`: `.config.json` in the config home if it exists, else `.claude${t6()}.json` in `CLAUDE_CONFIG_DIR` or the home dir.
- (b) `YB()`: the canonical root's `projects[pFe()]` flag first, then `Iw`/`Nw` walk the folder and each ancestor up to the git root (`rootOnly` branch included).
- (c) `Jn()`: gitdir, then commondir, then the back-pointing gitdir check, resolving to the main checkout.
- (d) `hasTrustDialogAccepted`.

## Differences that do not change the verdict

- `jE` has a `rootOnly` branch fed by `Vrr`. In 2.1.289 its input finder (`sB`) is a stub
  that returns `null`, so the branch is unreachable and the folder-and-ancestors walk always runs.
  Re-checked in 2.1.290: the finder (`mj`) is still `function mj(e,{uncached:n=!1}={}){return null}`.
  If a later release makes it live, re-read it before adding that release.
- The CLI trusts unconditionally when `CLAUDE_CODE_SANDBOXED` is set or `cge()` is true. That
  is more permissive than the gate, which stays strict.
- The config file name carries `kV()`: empty for the production OAuth endpoint, `-custom-oauth`,
  `-local-oauth` or `-staging-oauth` otherwise. `trust.ts` reads the production name, so a
  non-production OAuth setup would read a different file than the gate does. `kV()` (`Hq()` in
  2.1.290) returns `-custom-oauth` whenever `CLAUDE_CODE_CUSTOM_OAUTH_URL` is non-empty and
  otherwise `""` for prod, so the gate refuses while that variable is set (`trustRefusal`).
- The CLI's ancestor walk accepts any truthy flag; the gate requires `=== true`. Stricter, so safe.

## Adding a release

1. Run `node scripts/verify-trust-rule.mjs <version>` and compare with the snippets above for (a) to (d).
2. If all four match, add the version to `VERIFIED_TRUST_RULE_VERSIONS` and a row to the table.
3. If any differs, do not add it; update `trust.ts` and its tests to the new rule first.
