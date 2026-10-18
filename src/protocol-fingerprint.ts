import { createHash } from 'node:crypto'
import type { ClientMessage } from './protocol.js'

/** The two frames an idempotency key (CC-1454) may ride on. */
export type KeyedFrame = Extract<ClientMessage, { t: 'send' | 'resume' }>

/**
 * CC-1454: what makes two keyed frames the same request. The broker compares it
 * before answering a retry from its cache, and the client uses it to decide when
 * a retry reuses a key, so both import this one list and cannot drift apart.
 */
function semanticFields(frame: KeyedFrame): unknown[] {
  if (frame.t === 'send')
    return [frame.t, frame.to, frame.toTag, frame.text, frame.inReplyTo, frame.experiment, frame.followupKind]
  const fields = [frame.t, frame.name, frame.surface, frame.message, frame.source, frame.remoteControl]
  // CC-1472: appended only when named, so a resume without a host keeps the key it always had.
  return frame.host === undefined ? fields : [...fields, frame.host]
}

/** The first 16 bytes of a sha256 over the frame's semantic fields, as hex. */
export function requestFingerprint(frame: KeyedFrame): string {
  return createHash('sha256')
    .update(JSON.stringify(semanticFields(frame)))
    .digest('hex')
    .slice(0, 32)
}
