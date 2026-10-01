/** C0 but newline, DEL, C1, and format characters (bidi overrides, zero-width). */
const CONTROL = /[\0-\x09\x0b-\x1f\x7f-\x9f\p{Cf}]/u
const CONTROL_OR_BACKSLASH = /[\0-\x09\x0b-\x1f\x7f-\x9f\p{Cf}\\]/gu

const NAMED: Record<string, string> = { '\t': '\\t', '\r': '\\r', '\\': '\\\\' }

const hex = (n: number, width: number): string => n.toString(16).toUpperCase().padStart(width, '0')

function escapeOne(char: string): string {
  const named = NAMED[char]
  if (named !== undefined) return named
  const code = char.codePointAt(0)!
  if (code <= 0xff) return `\\x${hex(code, 2).toLowerCase()}`
  return code <= 0xffff ? `\\u${hex(code, 4)}` : `\\u{${hex(code, 1)}}`
}

/** Printed above endorse text whose control characters were shown as escapes. */
export const CONTROL_MARK = '[contains control characters, shown escaped]'

export const hasControls = (text: string): boolean => CONTROL.test(text)

/**
 * Text safe to write to a terminal: no control byte reaches it, so stored bytes
 * cannot redraw what the owner reads (CC-419). Backslashes are doubled only when
 * something was escaped, so plain text prints unchanged and escapes stay unambiguous.
 */
export function visible(text: string): { text: string; escaped: boolean } {
  if (!hasControls(text)) return { text, escaped: false }
  return { text: text.replace(CONTROL_OR_BACKSLASH, escapeOne), escaped: true }
}

/** Single-quoted for POSIX sh, so newlines, `$` and backticks pass through as written. */
export function shellQuote(word: string): string {
  if (/^[\w@%+=:,./-]+$/.test(word)) return word
  return `'${word.replaceAll("'", `'\\''`)}'`
}

/**
 * The ready-to-run command that restates an endorsement request byte for byte
 * (CC-369), or undefined when a control character would reach the terminal
 * raw: plain sh has no quoting that shows it and still round-trips.
 */
export function endorseCommand(msgId: string, to: string, text: string): string | undefined {
  const words = ['agent-chat', 'endorse', msgId, '--to', to, '--text', text]
  if (words.some(hasControls)) return undefined
  return words.map(shellQuote).join(' ')
}
