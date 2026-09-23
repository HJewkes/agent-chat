/**
 * A minimal SSE frame parser over a fetch response body.
 *
 * Deliberately dumb: it does no filtering and no JSON parsing. `source.ts`
 * decides what a missing `id`, a `reset` event or a comment-only heartbeat
 * means; this file only turns bytes into `id:`/`event:`/`data:` triples.
 */

export interface SseFrame {
  id?: string
  event?: string
  data: string
}

/** One frame per `\n\n`-terminated block; a block with no `data:` line (a bare heartbeat comment) is dropped. */
export async function* readSseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let sep = buffer.indexOf('\n\n')
      while (sep !== -1) {
        const frame = parseFrame(buffer.slice(0, sep))
        if (frame) yield frame
        buffer = buffer.slice(sep + 2)
        sep = buffer.indexOf('\n\n')
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function parseFrame(raw: string): SseFrame | undefined {
  let id: string | undefined
  let event: string | undefined
  const dataLines: string[] = []
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue
    else if (line.startsWith('id:')) id = line.slice(3).trim()
    else if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  if (dataLines.length === 0) return undefined
  return {
    data: dataLines.join('\n'),
    ...(id !== undefined ? { id } : {}),
    ...(event !== undefined ? { event } : {}),
  }
}
