import { isExperimentArm } from '../agents/spawn-provenance.js'
import { FOLLOWUP_KINDS, type ClientMessage } from '../protocol.js'

type SendFrame = Extract<ClientMessage, { t: 'send' }>

/**
 * CC-168: a send's experiment and follow-up kind as message-row meta. Checked here as well as in
 * chat_send because a CLI frame never passes through the tool's schema.
 */
export function sendMetaRefusal(msg: SendFrame): string | undefined {
  if (msg.experiment !== undefined && !isExperimentArm(msg.experiment))
    return 'experiment needs a non-empty id and arm'
  if (msg.followupKind !== undefined && !(FOLLOWUP_KINDS as readonly string[]).includes(msg.followupKind))
    return `followupKind must be one of: ${FOLLOWUP_KINDS.join(', ')}; got "${String(msg.followupKind)}"`
  return undefined
}

/** Undefined for an ordinary send, so its rows keep the meta they had. */
export function sendMeta(msg: SendFrame): Record<string, string> | undefined {
  const meta = {
    ...(msg.experiment === undefined
      ? {}
      : { experiment_id: msg.experiment.id.trim(), experiment_arm: msg.experiment.arm.trim() }),
    ...(msg.followupKind === undefined ? {} : { followup_kind: msg.followupKind }),
  }
  return Object.keys(meta).length > 0 ? meta : undefined
}
