import fs from 'node:fs'
import type { z } from 'zod'
import {
  burndownConfigPath,
  burndownOverridePath,
  burndownPausePath,
  burndownSettingsLogPath,
  burndownSettingsPath,
} from '../../paths.js'
import { withLedgerLock } from './ledger.js'
import { Override, Settings } from './settings.js'
import { resolve, type Resolved } from './settings-resolve.js'
import { loadTickConfig } from './source.js'

export interface SettingsPaths {
  flat: string
  settings: string
  override: string
}

export const defaultSettingsPaths = (): SettingsPaths => ({
  flat: burndownConfigPath(),
  settings: burndownSettingsPath(),
  override: burndownOverridePath(),
})

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
}

/** Absent is `undefined`; present but unparseable throws, worded like the flat file's own refusal. */
function readLayer<S extends z.ZodType>(label: string, file: string, schema: S): z.infer<S> | undefined {
  const raw = readText(file)
  if (raw === undefined) return undefined
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new Error(`burndown ${label} ${file} is malformed: ${(err as Error).message}`)
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) throw new Error(`burndown ${label} ${file} is malformed: ${parsed.error.message}`)
  return parsed.data
}

function flatRaw(file: string): Record<string, unknown> {
  const raw = readText(file)
  return raw === undefined ? {} : (JSON.parse(raw) as Record<string, unknown>)
}

function resolveOver(
  paths: SettingsPaths,
  settings?: Settings,
  override?: Override,
  now = Date.now(),
): Resolved {
  return resolve(
    {
      flat: loadTickConfig(paths.flat),
      flatRaw: flatRaw(paths.flat),
      ...(settings === undefined ? {} : { settings }),
      ...(override === undefined ? {} : { override }),
    },
    now,
  )
}

/** CC-955: the flat file read by `loadTickConfig` exactly as before, with the settings and override layered on. */
export function loadResolvedConfig(opts: { paths?: SettingsPaths; now?: number } = {}): Resolved {
  const paths = opts.paths ?? defaultSettingsPaths()
  const settings = readLayer('settings', paths.settings, Settings)
  const override = readLayer('override', paths.override, Override)
  return resolveOver(paths, settings, override, opts.now)
}

/** The read paths plus what only a change touches: the audit log and the tick's pause marker. */
export interface StorePaths extends SettingsPaths {
  log: string
  paused: string
}

export const defaultStorePaths = (): StorePaths => ({
  ...defaultSettingsPaths(),
  log: burndownSettingsLogPath(),
  paused: burndownPausePath(),
})

/** Everything a settings verb may change. The flat file is not here: no verb rewrites it. */
export interface Snapshot {
  settings: Settings
  override?: Override
  paused: boolean
}

export interface Change {
  verb: string
  by: string
  now: number
}

export function readSnapshot(paths: StorePaths): Snapshot {
  const override = readLayer('override', paths.override, Override)
  return {
    settings: readLayer('settings', paths.settings, Settings) ?? Settings.parse({}),
    ...(override === undefined ? {} : { override }),
    paused: fs.existsSync(paths.paused),
  }
}

/** Tmp file then rename, so a reader never sees half a file; the replaced file is kept as a timestamped `.bak`. */
function replaceFile(file: string, value: unknown, stamp: string): void {
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${stamp}`)
  if (value === undefined) {
    fs.rmSync(file, { force: true })
    return
  }
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function writeSnapshot(paths: StorePaths, before: Snapshot, after: Snapshot, at: string): void {
  const stamp = at.replace(/[:.]/g, '-')
  if (!same(before.settings, after.settings)) replaceFile(paths.settings, after.settings, stamp)
  if (!same(before.override, after.override)) replaceFile(paths.override, after.override, stamp)
  if (before.paused === after.paused) return
  if (after.paused) fs.writeFileSync(paths.paused, `${at}\n`)
  else fs.rmSync(paths.paused, { force: true })
}

/** Only the parts that changed, so a log row reads as the change itself. */
function delta(before: Snapshot, after: Snapshot): { before: Partial<Snapshot>; after: Partial<Snapshot> } {
  const keys = (['settings', 'override', 'paused'] as const).filter(k => !same(before[k], after[k]))
  const pick = (s: Snapshot) => Object.fromEntries(keys.map(k => [k, s[k] ?? null])) as Partial<Snapshot>
  return { before: pick(before), after: pick(after) }
}

/**
 * CC-955: applies `edit` under the settings lock, checks the result still resolves, writes what
 * changed and appends one `{at, by, verb, before, after}` row to the audit log.
 */
export async function changeSettings(
  paths: StorePaths,
  change: Change,
  edit: (current: Snapshot) => Snapshot,
): Promise<{ before: Resolved; after: Resolved }> {
  const locked = await withLedgerLock(paths.settings, () => {
    const at = new Date(change.now).toISOString()
    const before = readSnapshot(paths)
    const after = edit(before)
    const resolvedBefore = resolveOver(paths, before.settings, before.override, change.now)
    // Resolving before the write refuses a change that would leave the settings unresolvable.
    const resolvedAfter = resolveOver(paths, after.settings, after.override, change.now)
    writeSnapshot(paths, before, after, at)
    const row = { at, by: change.by, verb: change.verb, ...delta(before, after) }
    fs.appendFileSync(paths.log, `${JSON.stringify(row)}\n`)
    return { before: resolvedBefore, after: resolvedAfter }
  })
  if (!locked.ran) throw new Error(`burndown settings are locked by pid ${locked.holder}; try again`)
  return locked.value
}
