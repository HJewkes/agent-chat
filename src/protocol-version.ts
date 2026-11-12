/**
 * CC-1728: the wire protocol a client speaks, sent on `register` and `readopt`.
 *
 * `build` (CC-36) says WHICH checkout a client loaded, which only a human can
 * compare. This number says whether the broker can still serve it. Bump
 * PROTOCOL_VERSION when a frame changes shape; raise MIN_CLIENT_PROTOCOL only
 * when the broker drops support for an older shape, since every client below it
 * is refused until it is rebuilt.
 */
export const PROTOCOL_VERSION = 1

/** The oldest client protocol this broker still serves. */
export const MIN_CLIENT_PROTOCOL = 1

/** The register_result `code` a refused client recognises without parsing the reason. */
export const PROTOCOL_TOO_OLD = 'protocol_too_old'

export interface ClientBuild {
  protocol?: number | undefined
  build?: string | undefined
  host?: string | undefined
}

const rebuildAdvice = (host: string | undefined): string =>
  `rebuild agent-chat on ${host ?? 'the machine this session runs on'} at the broker's commit, ` +
  'then restart this session'

/** The named refusal for a client that states a protocol below the minimum; undefined when it is served. */
export function protocolRefusal(client: ClientBuild, min = MIN_CLIENT_PROTOCOL): string | undefined {
  if (typeof client.protocol !== 'number' || client.protocol >= min) return undefined
  return (
    `your agent-chat build (${client.build ?? 'unknown build'}) speaks protocol ${client.protocol}, ` +
    `older than the broker's minimum protocol ${min} (the broker speaks ${PROTOCOL_VERSION}); ` +
    rebuildAdvice(client.host)
  )
}

/**
 * Appended to a registration failure from a client that sent no protocol at all.
 *
 * Such a client predates the handshake, so its failure may be skew rather than
 * the reason it was given. It is not refused outright: sessions that started
 * before a broker deploy run that code too, and most of them still work.
 */
export function legacyClientHint(client: ClientBuild): string {
  return (
    ` (your agent-chat build (${client.build ?? 'unknown build'}) sends no protocol version, so it ` +
    `predates the broker's protocol ${PROTOCOL_VERSION}; if this failure persists, ${rebuildAdvice(client.host)})`
  )
}
