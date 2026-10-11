import { describe, expect, it } from 'vitest'
import { permissionNoticeText } from '../broker/permission-notice.js'

/** CC-610: the notice names the agent, the tool and what the tool was about to touch. */

describe('a permission-waiting notice', () => {
  it('names the file a Write was about to create', () => {
    const text = permissionNoticeText({
      agent: 'scout',
      toolName: 'Write',
      toolInput: { file_path: '/repo/sources/plan.md', content: 'x'.repeat(5000) },
    })

    expect(text).toBe('scout is waiting on a permission prompt: Write /repo/sources/plan.md')
  })

  it('clips a long Bash command to 120 characters and stays under 300', () => {
    const command = `cd "$TMPDIR/probe" && ${'git push origin HEAD '.repeat(40)}`

    const text = permissionNoticeText({ agent: 'scout', toolName: 'Bash', toolInput: { command } })

    expect(
      text.startsWith('scout is waiting on a permission prompt: Bash cd "$TMPDIR/probe" && git push'),
    ).toBe(true)
    expect(text.length).toBeLessThan(300)
    expect(text.length).toBe('scout is waiting on a permission prompt: Bash '.length + 120)
    expect(text.endsWith('…')).toBe(true)
  })

  it('names only the tool when it has no path or command', () => {
    const text = permissionNoticeText({ agent: 'scout', toolName: 'mcp__x__do', toolInput: { query: 'q' } })

    expect(text).toBe('scout is waiting on a permission prompt: mcp__x__do')
  })

  it('stays under 300 characters for a very long path', () => {
    const text = permissionNoticeText({
      agent: 'scout',
      toolName: 'Edit',
      toolInput: { path: '/a'.repeat(400) },
    })

    expect(text.length).toBeLessThan(300)
  })
})
