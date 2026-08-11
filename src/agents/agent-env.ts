/**
 * What a spawned agent's environment is allowed to carry.
 *
 * ## The problem
 *
 * `run-agent.ts` built `env: { ...process.env, ...plan.env }`, so every agent
 * inherited the whole environment of whatever shell started the broker —
 * `NPM_TOKEN`, `BRIGHTDATA_API_TOKEN` and anything else that happened to be
 * exported. A dispatched agent is a process with real Write, Edit and Bash
 * reading untrusted input, and relay's threat model (T7/M8) has a minimal-env
 * clause that simply did not survive delegation through this file.
 *
 * ## This is a denylist, which is the weaker control
 *
 * Stated plainly rather than discovered later: an allowlist is what M8 actually
 * asks for, and a denylist cannot be complete. A secret in a variable named
 * nothing like a secret still travels, and every new naming convention is a new
 * gap nobody is told about.
 *
 * It is here anyway because the failure modes are not symmetric. A denylist that
 * misses a variable leaks one secret to a process that was already going to run
 * on this machine; an allowlist that misses a variable breaks every spawn for
 * every agent-chat user, and the set a full Claude Code agent needs is not
 * knowable by reading — relay's own `minimalEnv()` reached three variables by
 * measurement, and twice by watching production fail (`env: node: not found`,
 * then a Keychain lookup that needed `USER`).
 *
 * So this closes the observed leak now and leaves the allowlist as its own
 * change, with its own measurement.
 *
 * ## The exemption, and why it is not a hole
 *
 * `ANTHROPIC_API_KEY` and its siblings match the patterns below and are kept
 * anyway. They are not a secret leaking TO the agent — they are the credential
 * the spawned binary uses to be an agent at all, and an operator who
 * authenticates that way rather than through the Keychain has no spawn without
 * them. Withholding a program's own auth is not confinement, it is breakage.
 */

/**
 * Names that read as a credential, anchored at the END so `TOKEN_PATH` and
 * `KEYBOARD_LAYOUT` are not swept up by a substring match.
 */
const SECRET_PATTERNS = [
  /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH)$/,
  /(^|_)API_?KEY$/,
  /(^|_)ACCESS_KEY(_ID)?$/,
  /(^|_)PRIVATE_KEY$/,
]

/**
 * Credential words that count wherever they appear — except as the FIRST
 * segment.
 *
 * This exists because end-anchoring alone was measurably not enough. Run against
 * a real environment, the patterns above caught `NPM_TOKEN` and let
 * `NPM_TOKEN_TITAN_DESIGN` and `NPM_TOKEN_VOLTRAS` straight through: a
 * per-registry token is the same secret with a scope suffix, and suffixing is
 * exactly how one credential becomes five.
 *
 * The first-segment exemption is what keeps `TOKEN_PATH` and `SECRET_DIR` —
 * names that describe where a credential lives rather than being one — from
 * breaking a spawn.
 *
 * `AUTH` is deliberately NOT in this set, only in the end-anchored patterns
 * above. `SSH_AUTH_SOCK` has `AUTH` as its second segment, and stripping it
 * would take the agent's ssh-agent socket with it — no `git push` from any
 * agent, for a variable that carries a path and not a key.
 */
const SECRET_SEGMENTS = new Set([
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'CREDENTIAL',
  'CREDENTIALS',
  'APIKEY',
])

function hasCredentialSegment(name: string): boolean {
  return name
    .split('_')
    .slice(1)
    .some(segment => SECRET_SEGMENTS.has(segment))
}

/**
 * Credential-bearing names the patterns above do not catch, because their
 * naming convention is a vendor's rather than a description.
 *
 * `AWS_` is a prefix rather than an entry: `AWS_SESSION_TOKEN` is caught by
 * pattern, `AWS_SECRET_ACCESS_KEY` is caught twice, and `AWS_PROFILE` names a
 * credential set without being one. Sweeping the prefix is the honest reading
 * of "this process should not be acting as that identity".
 */
const SECRET_NAMES = new Set([
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'BRIGHTDATA_API_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'HF_TOKEN',
  'SENTRY_AUTH_TOKEN',
  'CLOUDFLARE_API_TOKEN',
  'CF_API_TOKEN',
  'STRIPE_API_KEY',
  'SLACK_TOKEN',
  'DATABASE_URL',
])

const SECRET_PREFIXES = ['AWS_', 'AZURE_', 'GOOGLE_APPLICATION_']

/**
 * Kept even though they match. See this file's header: these are the spawned
 * binary's own authentication, not the operator's ambient credentials.
 */
const KEEP = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'])

export function isSecretName(name: string): boolean {
  // Case-folded first, so every rule below judges the same string. Checking
  // KEEP against the raw name would have made `anthropic_api_key` a stripped
  // variable and `ANTHROPIC_API_KEY` a kept one.
  const upper = name.toUpperCase()
  if (KEEP.has(upper)) return false

  if (SECRET_NAMES.has(upper)) return true
  if (SECRET_PREFIXES.some(prefix => upper.startsWith(prefix))) return true
  if (hasCredentialSegment(upper)) return true
  return SECRET_PATTERNS.some(pattern => pattern.test(upper))
}

/**
 * The parent environment with credential-shaped variables removed.
 *
 * Undefined values are dropped too: `process.env` is typed as possibly-undefined
 * per key, and passing `undefined` through to `spawn` is not the same as
 * omitting it.
 */
export function agentEnv(parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue
    if (isSecretName(name)) continue
    kept[name] = value
  }
  return kept
}
