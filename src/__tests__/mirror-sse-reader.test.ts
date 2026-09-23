import { describe, expect, it } from 'vitest'
import { readSseFrames } from '../mirror/sse-reader.js'

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) return controller.close()
      controller.enqueue(encoder.encode(chunks[i]))
      i += 1
    },
  })
}

async function collect(body: ReadableStream<Uint8Array>) {
  const frames = []
  for await (const frame of readSseFrames(body)) frames.push(frame)
  return frames
}

describe('readSseFrames', () => {
  it('parses a plain row frame', async () => {
    const frames = await collect(streamOf(['id: 41\nevent: question\ndata: {"a":1}\n\n']))
    expect(frames).toEqual([{ id: '41', event: 'question', data: '{"a":1}' }])
  })

  it('drops a comment-only heartbeat', async () => {
    const frames = await collect(streamOf([': heartbeat\n\n', 'id: 1\nevent: notice\ndata: {}\n\n']))
    expect(frames).toEqual([{ id: '1', event: 'notice', data: '{}' }])
  })

  it('parses a reset frame, which carries no id', async () => {
    const frames = await collect(
      streamOf(['event: reset\ndata: {"reason":"gap_too_large","latestId":9}\n\n']),
    )
    expect(frames).toEqual([
      { id: undefined, event: 'reset', data: '{"reason":"gap_too_large","latestId":9}' },
    ])
  })

  it('reassembles a frame split across chunks', async () => {
    const frames = await collect(streamOf(['id: 5\nev', 'ent: notice\ndata: {"x":2}', '\n\n']))
    expect(frames).toEqual([{ id: '5', event: 'notice', data: '{"x":2}' }])
  })
})
