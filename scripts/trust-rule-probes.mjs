// Matchers for the startup trust-check code in a Claude Code bundle. Identifiers are
// minified, and newer bundles use `$` in them, so every name is matched as [\w$]+.
const id = String.raw`[\w$]+`

export const probes = [
  {
    label:
      'trust check: canonical root, then folder and ancestors up to the git root; flag hasTrustDialogAccepted',
    pattern: new RegExp(
      String.raw`function ${id}\(\)\{if\(${id}\.CLAUDE_CODE_SANDBOXED\)return!0;if\(${id}\(\)\)return!0;let ${id}=${id}\(\),${id}=${id}\(\);if\(${id}\.projects\?\.\[${id}\]\?\.hasTrustDialogAccepted\)`,
    ),
    length: 1050,
  },
  {
    label: 'worktree to main checkout',
    pattern: new RegExp(
      String.raw`function ${id}\(${id},${id}\)\{try\{let ${id}=${id}\.trim\(\);if\(!${id}\.startsWith\("gitdir:"\)\)`,
    ),
    length: 800,
  },
  {
    // 2.1.295 added a leading `if(diskless())return <sentinel>;` before the timer.
    label: 'git root finder',
    pattern: new RegExp(
      String.raw`function ${id}\(${id}\)\{(?:if\(${id}\(\)\)return ${id};)?let ${id}=Date\.now\(\);${id}\("info","find_git_root_started"\)`,
    ),
    length: 420,
  },
  {
    label: 'global config file',
    pattern: new RegExp(
      String.raw`function ${id}\(\)\{if\(${id}\(\)\.existsSync\(${id}\(${id}\(\),"\.config\.json"\)\)\)`,
    ),
    length: 330,
  },
]

export function extractProbes(bundle) {
  return probes.map(({ label, pattern, length }) => {
    const at = bundle.search(pattern)
    return { label, at, code: at < 0 ? null : bundle.slice(at, at + length) }
  })
}
