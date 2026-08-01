export interface PaletteCommand {
  id: string
  label: string
  /** Right-aligned hint, e.g. the destination hash or a shortcut. */
  hint?: string
  /** Extra text matched against the query but not displayed. */
  keywords?: string
  run: () => void
}

/**
 * Every whitespace-separated term must appear somewhere in the command's text,
 * so "go queue" and "queue go" both find the same command.
 *
 * Kept apart from the component so it is testable without a DOM: this package's
 * vitest run has no react-native alias, and the component cannot import.
 */
export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  return commands.filter(command => {
    const haystack = `${command.label} ${command.hint ?? ''} ${command.keywords ?? ''}`.toLowerCase()
    return terms.every(term => haystack.includes(term))
  })
}
