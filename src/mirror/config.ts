import fs from 'node:fs'
import { z } from 'zod'
import { mirrorConfigPath, mirrorEnvPath } from '../paths.js'

/** The env file key holding the appservice token; the only secret the mirror uses. */
export const AS_TOKEN_KEY = 'EDGE1_AS_TOKEN'

const MATRIX_USER = /^@[^:]+:.+$/

/** Strict, so a token pasted into the config file is refused rather than silently ignored. */
export const MirrorConfigFile = z
  .object({
    homeserverUrl: z.url(),
    serverName: z.string().min(1),
    ownerUserId: z.string().regex(MATRIX_USER),
    mirrorUserId: z.string().regex(MATRIX_USER).optional(),
    roomAlias: z.string().startsWith('#').optional(),
    machine: z
      .string()
      .regex(/^[a-z0-9]+$/)
      .optional(),
  })
  .strict()

export type MirrorConfigFile = z.infer<typeof MirrorConfigFile>

export interface MirrorConfig {
  homeserverUrl: string
  serverName: string
  ownerUserId: string
  mirrorUserId: string
  roomAlias: string
  machine: string
}

export function withDefaults(file: MirrorConfigFile): MirrorConfig {
  const machine = file.machine ?? 'edge1'
  return {
    homeserverUrl: file.homeserverUrl,
    serverName: file.serverName,
    ownerUserId: file.ownerUserId,
    mirrorUserId: file.mirrorUserId ?? `@ac-${machine}:${file.serverName}`,
    roomAlias: file.roomAlias ?? `#queue:${file.serverName}`,
    machine,
  }
}

export function loadMirrorConfig(file = mirrorConfigPath()): MirrorConfig {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const parsed = MirrorConfigFile.safeParse(raw)
  if (!parsed.success) throw new Error(`${file} is invalid: ${z.prettifyError(parsed.error)}`)
  return withDefaults(parsed.data)
}

/** The permission bits of `file`, or null when it does not exist. */
export function fileMode(file: string): number | null {
  try {
    return fs.statSync(file).mode & 0o777
  } catch {
    return null
  }
}

export const isPrivateMode = (mode: number): boolean => (mode & 0o077) === 0

export const formatMode = (mode: number): string => `0${mode.toString(8).padStart(3, '0')}`

/** `KEY=value` lines; `#` comments, blank lines and one layer of matching quotes are allowed. */
export function parseEnvFile(text: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    const eq = trimmed.indexOf('=')
    if (trimmed === '' || trimmed.startsWith('#') || eq <= 0) continue
    const value = trimmed.slice(eq + 1).trim()
    const unquoted = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value
    entries.set(trimmed.slice(0, eq).trim(), unquoted)
  }
  return entries
}

/** Refuses a group- or world-readable file before reading a byte of it. Never touches `process.env`. */
export function readAsToken(file = mirrorEnvPath()): string {
  const mode = fileMode(file)
  if (mode === null) throw new Error(`${file} is absent; it must hold ${AS_TOKEN_KEY}=<token>`)
  if (!isPrivateMode(mode)) throw new Error(`${file} is ${formatMode(mode)}; must be 0600`)
  const token = parseEnvFile(fs.readFileSync(file, 'utf8')).get(AS_TOKEN_KEY)
  if (!token) throw new Error(`${file} has no ${AS_TOKEN_KEY}`)
  return token
}
