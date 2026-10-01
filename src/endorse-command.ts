/** Single-quoted for POSIX sh, so newlines, `$` and backticks pass through as written. */
export function shellQuote(word: string): string {
  if (/^[\w@%+=:,./-]+$/.test(word)) return word
  return `'${word.replaceAll("'", `'\\''`)}'`
}

/** The ready-to-run command that restates an endorsement request byte for byte (CC-369). */
export function endorseCommand(msgId: string, to: string, text: string): string {
  return ['agent-chat', 'endorse', msgId, '--to', to, '--text', text].map(shellQuote).join(' ')
}
