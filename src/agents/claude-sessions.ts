import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defaultConfigDir, profileRoot } from './config-dir.js'

/**
 * CC-450: Claude Code's own record of its running sessions, read to decide whether a
 * session with no launcher pid still has a process.
 *
 * Every interactive Claude Code process writes `<configDir>/sessions/<pid>.json`
 * holding its pid and current session id, and removes it on exit. The file is keyed
 * by pid, so a later claude that reuses the pid overwrites it with its own session id.
 * The format is Claude Code's, not ours: a reader that finds no parseable record at
 * all reports nothing, and callers must read that as "cannot tell", never "gone".
 */

export interface SessionRecord {
  pid: number
  sessionId: string
}

const parseRecord = (raw: string): SessionRecord | undefined => {
  try {
    const value = JSON.parse(raw) as { pid?: unknown; sessionId?: unknown }
    if (typeof value.pid !== 'number' || typeof value.sessionId !== 'string') return undefined
    return { pid: value.pid, sessionId: value.sessionId }
  } catch {
    return undefined
  }
}

const listDir = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

const readFile = (file: string): string => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** Every account dir a session on this machine may run under: the default, the env's, and each profile. */
export function knownConfigDirs(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string[] {
  const root = profileRoot(env, home)
  const profiles = listDir(root).map(name => path.join(root, name))
  const dirs = [defaultConfigDir(home), env.CLAUDE_CONFIG_DIR ?? '', ...profiles]
  return [...new Set(dirs.filter(dir => dir !== ''))]
}

export function readSessionRecords(configDirs: readonly string[]): SessionRecord[] {
  const records: SessionRecord[] = []
  for (const dir of new Set(configDirs)) {
    const sessions = path.join(dir, 'sessions')
    for (const name of listDir(sessions).filter(n => n.endsWith('.json'))) {
      const record = parseRecord(readFile(path.join(sessions, name)))
      if (record) records.push(record)
    }
  }
  return records
}
