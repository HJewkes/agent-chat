import path from 'node:path'
import { MIRROR_LABEL } from '../paths.js'

/** The only variables the job inherits; a token must never ride along from the caller's env. */
const PASSED_ENV = ['HOME', 'PATH', 'AGENT_CHAT_HOME'] as const

export interface MirrorPlistInput {
  nodePath: string
  cliEntry: string
  logDir: string
  env: Record<string, string>
}

/** HOME and PATH always, AGENT_CHAT_HOME only when set; nothing else from `source`. */
export function mirrorJobEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of PASSED_ENV) {
    const value = source[key]
    if (value !== undefined && value !== '') env[key] = value
  }
  return env
}

const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const stringTag = (value: string): string => `<string>${escapeXml(value)}</string>`

const keyString = (key: string, value: string, indent: string): string =>
  `${indent}<key>${escapeXml(key)}</key>\n${indent}${stringTag(value)}`

/** Pure: the launchd agent that keeps `agent-chat mirror run` alive. It holds no token. */
export function renderMirrorPlist(input: MirrorPlistInput): string {
  const log = path.join(input.logDir, 'mirror.log')
  const args = [input.nodePath, input.cliEntry, 'mirror', 'run']
  const env = Object.entries(input.env).map(([key, value]) => keyString(key, value, '    '))
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    keyString('Label', MIRROR_LABEL, '  '),
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args.map(arg => `    ${stringTag(arg)}`),
    '  </array>',
    '  <key>RunAtLoad</key>\n  <true/>',
    '  <key>KeepAlive</key>\n  <true/>',
    '  <key>ThrottleInterval</key>\n  <integer>30</integer>',
    keyString('StandardOutPath', log, '  '),
    keyString('StandardErrorPath', log, '  '),
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...env,
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}
