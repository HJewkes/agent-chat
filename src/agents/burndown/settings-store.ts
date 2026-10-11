import fs from 'node:fs'
import type { z } from 'zod'
import { burndownConfigPath, burndownOverridePath, burndownSettingsPath } from '../../paths.js'
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

/** CC-955: the flat file read by `loadTickConfig` exactly as before, with the settings and override layered on. */
export function loadResolvedConfig(opts: { paths?: SettingsPaths; now?: number } = {}): Resolved {
  const paths = opts.paths ?? defaultSettingsPaths()
  const flat = loadTickConfig(paths.flat)
  const settings = readLayer('settings', paths.settings, Settings)
  const override = readLayer('override', paths.override, Override)
  return resolve(
    {
      flat,
      flatRaw: flatRaw(paths.flat),
      ...(settings === undefined ? {} : { settings }),
      ...(override === undefined ? {} : { override }),
    },
    opts.now ?? Date.now(),
  )
}
