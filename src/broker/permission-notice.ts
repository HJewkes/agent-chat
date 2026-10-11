/**
 * CC-610: the line a spawner gets when its headless agent parks on the
 * permission hook. Without it the wait is found only by tailing transcripts.
 */

export const PERMISSION_WAITING = 'permission-waiting'

const COMMAND_LIMIT = 120
const TEXT_LIMIT = 299
const PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const

export interface PermissionNotice {
  agent: string
  toolName: string
  toolInput: unknown
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

function targetOf(toolInput: unknown): string | undefined {
  if (typeof toolInput !== 'object' || toolInput === null) return undefined
  const input = toolInput as Record<string, unknown>
  for (const key of PATH_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value !== '') return value
  }
  const command = input['command']
  if (typeof command === 'string' && command !== '') return clip(command.replace(/\s+/g, ' '), COMMAND_LIMIT)
  return undefined
}

export function permissionNoticeText({ agent, toolName, toolInput }: PermissionNotice): string {
  const target = targetOf(toolInput)
  const call = target === undefined ? toolName : `${toolName} ${target}`
  return clip(`${agent} is waiting on a permission prompt: ${call}`, TEXT_LIMIT)
}
