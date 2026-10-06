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
