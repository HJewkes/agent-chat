import { randomUUID } from 'node:crypto'

/**
 * The raw 8-hex draw. It is NOT checked against the log, so it repeats (CC-1187):
 * mint a new id through `EventStore.mintMsgId`, or `append` without a `msgId`.
 */
export const newMsgId = (): string => randomUUID().slice(0, 8)
