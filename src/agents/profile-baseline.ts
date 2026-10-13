import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const PROFILE_DRIFT_MODES = ['flag', 'refuse'] as const
export type ProfileDriftMode = (typeof PROFILE_DRIFT_MODES)[number]

const digestOf = (file: string): string | undefined => {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return undefined
  }
}

/**
 * CC-1094: the sha256 of every `<dir>/*.json` when the broker started. A worker that rewrote a profile
 * could drop its own denies, so a later spawn of a profile whose bytes changed is drift. A hash, not an
 * mtime: a rewrite can put the old mtime back.
 */
export class ProfileBaseline {
  private readonly digests = new Map<string, string>()

  constructor(private readonly dir: string) {
    let names: string[]
    try {
      names = fs.readdirSync(dir).filter(file => file.endsWith('.json'))
    } catch {
      return
    }
    for (const file of names) {
      const digest = digestOf(path.join(dir, file))
      if (digest !== undefined) this.digests.set(file.slice(0, -'.json'.length), digest)
    }
  }

  /** Why `name`'s file differs from the baseline, or undefined. A builtin with no file then or now never drifts. */
  drift(name: string): string | undefined {
    const file = path.join(this.dir, `${name}.json`)
    const now = digestOf(file)
    const then = this.digests.get(name)
    if (now === then) return undefined
    if (then === undefined) return `profile file ${file} was created after the broker started`
    if (now === undefined) return `profile file ${file} was removed after the broker started`
    return `profile file ${file} changed after the broker started`
  }

  /** Takes the file's current bytes as the baseline, as a human spawn of it does. */
  accept(name: string): void {
    const digest = digestOf(path.join(this.dir, `${name}.json`))
    if (digest === undefined) this.digests.delete(name)
    else this.digests.set(name, digest)
  }
}
