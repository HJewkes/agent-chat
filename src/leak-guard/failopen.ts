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

/**
 * The decision. A rejection gives `onCrash`'s answer when it has one (a deny, so unlogged), else
 * '' (allow) with one log line. A run past the deadline allows with one log line.
 */
export async function decideWithin(
  decide: () => Promise<string>,
  deadlineMs: number,
  onFailOpen: FailOpen,
  onCrash: () => string | undefined = () => undefined,
): Promise<string> {
  const started = Date.now()
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<string>(resolve => {
    timer = setTimeout(() => {
      onFailOpen(`timeout after ${Date.now() - started}ms`)
      resolve('')
    }, deadlineMs)
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
