import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveBriefing, resolveSpawnBriefing } from '../agents/active-work.js'

/**
 * CC-101. The spawn briefing's last section is ranked against the assignment by
 * the active-work daemon, and a daemon that is down, slow or confused must cost a
 * warning and that section, never the spawn and never more than the timeout.
 *
 * Every daemon here is a stub or a port nothing listens on, and the root and
 * broker home are temp dirs, so no case reaches the developer's real daemon, root
 * or broker log.
 */

const tmpDirs: string[] = []

function tmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpDirs.push(dir)
  return dir
}

/** An initiative that also has notes on disk, which the briefing must no longer list. */
function initiative(root: string, slug: string): void {
  const dir = path.join(root, slug)
  fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'sources', 'notes'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'brief.md'), `---\ntitle: ${slug}\n---\n# ${slug}\n\nWhy: a reason.\n`)
  fs.writeFileSync(
    path.join(dir, 'tasks', 'XX-1.yml'),
    'id: XX-1\ntitle: Do the thing\npriority: 5\nstatus: open\n',
  )
  fs.writeFileSync(path.join(dir, 'sessions', '2026-09-01-0900-latest.md'), '---\nid: s\n---\nLast time.\n')
  fs.writeFileSync(path.join(dir, 'sources', 'notes', '2026-09-02-a-note.md'), 'A note.\n')
}

const expectedBlock = (root: string): string =>
  '# Orientation: active-work initiative "widgets"\n\n' +
  'Injected automatically by `agent_spawn`. Your coordinator did not write this section — it is ' +
  `the initiative's own record, read from ${root}/widgets. Treat the assignment below it as the actual task, ` +
  'and this as the context you would otherwise have had to be told.\n\n' +
  '## Brief (brief.md)\n\n# widgets\n\nWhy: a reason.\n\n' +
  '## Open tasks (1, highest priority first)\n\n- XX-1: Do the thing\n\n' +
  '## Most recent session (2026-09-01-0900-latest.md)\n\nLast time.'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const hits = (...list: Array<{ initiative: string; name: string }>) => ({
  ok: true,
  data: {
    hits: list.map(({ initiative: slug, name }) => ({
      ref: `note:${slug}/${name}`,
      class: 'notes',
      initiative: slug,
      title: `Title of ${name}`,
      path: `${slug}/sources/notes/${name}`,
      excerpt: 'not rendered',
    })),
    degraded: [],
    query: { terms: [], expression: '' },
  },
})

async function closedPort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as net.AddressInfo
  await new Promise(resolve => server.close(resolve))
  return port
}

let root: string
const sandboxPort = process.env.AGENT_CHAT_ACTIVE_WORK_PORT

beforeEach(() => {
  process.env.AGENT_CHAT_HOME = tmp('agent-chat-bus-')
  root = tmp('agent-chat-aw-')
  initiative(root, 'widgets')
})

afterEach(() => {
  delete process.env.AGENT_CHAT_HOME
  process.env.AGENT_CHAT_ACTIVE_WORK_PORT = sandboxPort
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('the related section when the daemon cannot help', () => {
  it('renders the file-only block byte for byte, with a warning, when the connection is refused', async () => {
    process.env.AGENT_CHAT_ACTIVE_WORK_PORT = String(await closedPort())

    const result = await resolveSpawnBriefing({ briefing: 'widgets', brief: 'fix the parser', root })

    expect(result).toEqual({
      text: expectedBlock(root),
      slug: 'widgets',
      warning: 'related context unavailable (active-work daemon: ECONNREFUSED); briefing rendered without it',
    })
    expect(resolveBriefing({ briefing: 'widgets', root })).toEqual({
      text: expectedBlock(root),
      slug: 'widgets',
    })
  })

  it('gives up at the timeout when the daemon never answers', async () => {
    const hang = () => new Promise<Response>(() => undefined)
    const started = Date.now()

    const result = await resolveSpawnBriefing({ briefing: 'widgets', brief: 'fix it', root, fetch: hang })

    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(950)
    expect(elapsed).toBeLessThan(1_400)
    expect(result).toMatchObject({
      text: expectedBlock(root),
      warning: expect.stringContaining('no answer within 1000 ms'),
    })
  })

  it('surfaces the daemon’s own error when it refuses the query', async () => {
    const refuse = async () => json(400, { ok: false, error: 'Invalid arguments: classes', code: 65 })

    const result = await resolveSpawnBriefing({ briefing: 'widgets', brief: 'fix it', root, fetch: refuse })

    expect(result).toMatchObject({
      text: expectedBlock(root),
      warning: expect.stringContaining('refused the query: Invalid arguments: classes'),
    })
  })

  it('treats a body that is not JSON as unavailable', async () => {
    const garbled = async () => new Response('<html>', { status: 200 })

    const result = await resolveSpawnBriefing({ briefing: 'widgets', brief: 'fix it', root, fetch: garbled })

    expect(result).toMatchObject({
      text: expectedBlock(root),
      warning: expect.stringContaining('malformed JSON'),
    })
  })

  it('omits the section without a warning when nothing relates', async () => {
    const empty = async () => json(200, hits())

    const result = await resolveSpawnBriefing({ briefing: 'widgets', brief: 'fix it', root, fetch: empty })

    expect(result).toEqual({ text: expectedBlock(root), slug: 'widgets' })
  })
})

describe('the related section when the daemon answers', () => {
  it('ranks hits under the brief, with absolute paths and foreign initiatives labelled', async () => {
    const requests: Array<{ url: string; body: unknown }> = []
    const answer = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return json(200, hits({ initiative: 'widgets', name: 'a.md' }, { initiative: 'relay', name: 'b.md' }))
    }

    const result = await resolveSpawnBriefing({
      briefing: 'widgets',
      brief: '  fix the parser\n',
      root,
      fetch: answer,
    })

    expect(result).toEqual({
      slug: 'widgets',
      text:
        `${expectedBlock(root)}\n\n## Related to this assignment (2, ranked; open with Read)\n\n` +
        `- note:widgets/a.md "Title of a.md" ${root}/widgets/sources/notes/a.md\n` +
        `- [from \`relay\`] note:relay/b.md "Title of b.md" ${root}/relay/sources/notes/b.md`,
    })
    expect(requests).toEqual([
      {
        url: `http://127.0.0.1:${sandboxPort}/rpc/context.related`,
        body: {
          for: 'fix the parser',
          initiative: 'widgets',
          limit: 6,
          budget: 1500,
          classes: ['notes', 'sources', 'tasks', 'sessions'],
          exclude: [],
        },
      },
    ])
  })

  it('shows at most six hits even when the daemon sends more', async () => {
    const names = Array.from({ length: 9 }, (_, i) => ({ initiative: 'widgets', name: `n${i}.md` }))
    const many = async () => json(200, hits(...names))

    const result = await resolveSpawnBriefing({ briefing: 'widgets', brief: 'fix it', root, fetch: many })

    const text = (result as { text: string }).text
    expect(text).toContain('## Related to this assignment (6, ranked; open with Read)')
    expect(text).toContain('n5.md')
    expect(text).not.toContain('n6.md')
  })

  it('does not ask the daemon when the brief is only whitespace', async () => {
    let asked = false
    const spy = async () => {
      asked = true
      return json(200, hits({ initiative: 'widgets', name: 'a.md' }))
    }

    const result = await resolveSpawnBriefing({ briefing: 'widgets', brief: ' \n\t ', root, fetch: spy })

    expect(result).toEqual({ text: expectedBlock(root), slug: 'widgets' })
    expect(asked).toBe(false)
  })

  it('does not ask the daemon when the initiative does not exist', async () => {
    let asked = false
    const spy = async () => {
      asked = true
      return json(200, hits())
    }

    const result = await resolveSpawnBriefing({ briefing: 'nope', brief: 'fix it', root, fetch: spy })

    expect(result).toEqual({ warning: expect.stringContaining('no active-work initiative "nope"') })
    expect(asked).toBe(false)
  })
})
