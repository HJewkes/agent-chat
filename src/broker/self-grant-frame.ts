import { AGENT_NAME_PATTERN } from '../launch-identity.js'
import { RESERVED_NAMES } from '../protocol.js'

/**
 * The checks on a `permission_self_granted` frame (CC-694 d). The frame comes from
 * an unregistered process the broker cannot vouch for, and the rows it writes claim
 * an `allow` on the audit trail, so everything the rows repeat is checked here.
 */

const FRAME_KEYS = new Set(['t', 'session', 'toolName', 'toolInput', 'grant'])
const GRANTED_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])
const VALID_SESSION = new RegExp(`^${AGENT_NAME_PATTERN}$`, 'i')
export const MAX_FILE_PATH = 4096
export const MAX_INPUT_JSON = 256 * 1024

function sessionRefusal(session: unknown): string | undefined {
  if (typeof session !== 'string' || !VALID_SESSION.test(session))
    return `session must match ${AGENT_NAME_PATTERN}`
  if (RESERVED_NAMES.has(session.toLowerCase())) return `"${session}" is a reserved name`
  return undefined
}

function toolInputRefusal(toolInput: unknown): string | undefined {
  if (typeof toolInput !== 'object' || toolInput === null || Array.isArray(toolInput))
    return 'toolInput must be an object'
  const filePath = (toolInput as { file_path?: unknown }).file_path
  if (typeof filePath !== 'string' || filePath === '' || filePath.length > MAX_FILE_PATH)
    return `toolInput.file_path must be a string of 1-${MAX_FILE_PATH} characters`
  if (JSON.stringify(toolInput).length > MAX_INPUT_JSON)
    return `toolInput is larger than ${MAX_INPUT_JSON} bytes`
  return undefined
}

/** Why the frame may not be recorded, or undefined when it may. */
export function selfGrantFrameRefusal(frame: Record<string, unknown>): string | undefined {
  const extra = Object.keys(frame).filter(key => !FRAME_KEYS.has(key))
  if (extra.length > 0) return `unexpected keys: ${extra.join(', ')}`
  if (frame.grant !== 'repo-skills') return 'grant must be "repo-skills"'
  if (typeof frame.toolName !== 'string' || !GRANTED_TOOLS.has(frame.toolName))
    return 'toolName must be Write, Edit or MultiEdit'
  return sessionRefusal(frame.session) ?? toolInputRefusal(frame.toolInput)
}
