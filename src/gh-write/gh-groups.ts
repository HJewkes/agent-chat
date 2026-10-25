/**
 * gh 2.87's own groups and their cobra aliases; a config alias (`co`) or an extension is refused.
 * Its own module so the gh shim, which runs on every gh call, need not load the leak scan.
 */
export const GH_GROUPS: ReadonlySet<string> = new Set(
  (
    'agent-task alias api attestation auth browse cache codespace cs completion config copilot ' +
    'extension extensions ext gist gpg-key issue label licenses org pr preview project release repo ' +
    'ruleset rs run search secret ssh-key status variable workflow'
  ).split(' '),
)
