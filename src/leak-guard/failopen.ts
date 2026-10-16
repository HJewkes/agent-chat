import fs from 'node:fs'

/** Records why the pretool hook allowed a call it could not decide (CC-371). */
export type FailOpen = (cause: string) => void

const stamp = (): string => new Date().toISOString()

const errorClass = (err: unknown): string => (err instanceof Error ? err.constructor.name : typeof err)

export const crashCause = (err: unknown): string => `crash (${errorClass(err)})`

/** One line per fail-open; a log that cannot be written never turns the allow into a failure. */
export function failOpenLogger(file: string): FailOpen {
  return cause => {
    try {
      fs.appendFileSync(file, `${stamp()} leak-guard pretool fail-open: ${cause}\n`)
    } catch {
      // The allow stands without its log line.
    }
  }
}

/** How long the decision may run, and the deny it gives when it runs longer (CC-1407). */
export interface Deadline {
  ms: number
  denial: () => string
}

/**
 * The decision. A rejection gives `onCrash`'s answer when it has one (a deny, so unlogged), else
 * '' (allow) with one log line. A run past the deadline gives the deadline's deny, unlogged: an
 * allow there would let a line padded to outrun the check run unchecked.
 */
export async function decideWithin(
  decide: () => Promise<string>,
  deadline: Deadline,
  onFailOpen: FailOpen,
  onCrash: () => string | undefined = () => undefined,
): Promise<string> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<string>(resolve => {
    timer = setTimeout(() => resolve(deadline.denial()), deadline.ms)
  })
  try {
    return await Promise.race([decide(), late])
  } catch (err) {
    const answer = onCrash()
    if (answer !== undefined) return answer
    onFailOpen(crashCause(err))
    return ''
  } finally {
    clearTimeout(timer)
  }
}
