import {
  ITEM_KEY,
  type MatrixEvent,
  type SyncBatch,
  type SyncOptions,
  type TitanItem,
} from '@titan-design/matrix-bus'
import type { MirrorBus } from '@titan-design/queue-mirror'

/**
 * A one-room homeserver for mirror tests. queue-mirror keeps its own fake hub
 * private, so this is the local stand-in: `send` dedupes by txn id the way a
 * real homeserver does, and `/sync` replays the timeline from a numeric `since`.
 */
export class FakeMatrixHub {
  /** Every `send` call, duplicates included; a test counts reposts here. */
  readonly sends: Array<{ type: string; content: Record<string, unknown>; txnId: string | undefined }> = []
  readonly timeline: MatrixEvent[] = []
  private readonly byTxn = new Map<string, string>()
  private readonly waiters = new Set<() => void>()

  bus(userId: string): MirrorBus {
    return {
      userId,
      send: async (_roomId, type, content, txnId) => this.send(userId, type, content, txnId),
      syncLoop: options => this.sync(options),
    }
  }

  /** Items posted (not edits), in timeline order. */
  items(): Array<{ eventId: string; record: TitanItem }> {
    return this.timeline
      .filter(event => event.content[ITEM_KEY] !== undefined && !this.isEdit(event))
      .map(event => ({ eventId: event.event_id, record: event.content[ITEM_KEY] as TitanItem }))
  }

  /** The status lines of every edit made to `eventId`, oldest first. */
  editsOf(eventId: string): string[] {
    return this.timeline
      .filter(event => this.isEdit(event) && this.relation(event)['event_id'] === eventId)
      .map(event => String((event.content['m.new_content'] as { body: string }).body.split('\n').at(-1)))
  }

  reply(sender: string, itemEventId: string, body: string): void {
    this.push(sender, 'm.room.message', {
      msgtype: 'm.text',
      body,
      'm.relates_to': { 'm.in_reply_to': { event_id: itemEventId } },
    })
  }

  private send(sender: string, type: string, content: Record<string, unknown>, txnId?: string) {
    this.sends.push({ type, content, txnId })
    const existing = txnId === undefined ? undefined : this.byTxn.get(txnId)
    if (existing !== undefined) return { event_id: existing }
    const eventId = this.push(sender, type, content)
    if (txnId !== undefined) this.byTxn.set(txnId, eventId)
    return { event_id: eventId }
  }

  private push(sender: string, type: string, content: Record<string, unknown>): string {
    const eventId = `$e${this.timeline.length + 1}`
    this.timeline.push({ type, event_id: eventId, sender, content })
    for (const wake of this.waiters) wake()
    this.waiters.clear()
    return eventId
  }

  private async *sync({ since, signal }: SyncOptions = {}): AsyncGenerator<SyncBatch> {
    let from = since === undefined ? 0 : Number(since)
    while (!signal?.aborted) {
      if (from < this.timeline.length) {
        const events = this.timeline.slice(from)
        from = this.timeline.length
        yield { since: String(from), events }
        continue
      }
      await new Promise<void>(resolve => {
        this.waiters.add(resolve)
        signal?.addEventListener('abort', () => resolve(), { once: true })
      })
    }
  }

  private relation(event: MatrixEvent): Record<string, unknown> {
    return (event.content['m.relates_to'] as Record<string, unknown> | undefined) ?? {}
  }

  private isEdit(event: MatrixEvent): boolean {
    return this.relation(event)['rel_type'] === 'm.replace'
  }
}
