import { describe, expect, it, vi } from 'vitest'
import {
  branchHead,
  FAILURE_CLASSES,
  failureClassOf,
  reportHead,
  reportPr,
  retireOutcomeOf,
} from '../agents/seats/retire-outcome.js'
import { workObserver, type TranscriptWork } from '../agents/transcript-work.js'

/** CC-645: what a retire row says a run produced and why it stopped. Every repo, sha and text is invented. */

const HEAD = '0123456789abcdef0123456789abcdef01234567'
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98'
const REPORT = `Status: DONE\nPR: example-org/widget#12\nHead: ${HEAD}\nCI: check success`

const work = (over: Partial<TranscriptWork> = {}): TranscriptWork => ({
  tool_errors: 0,
  denied: false,
  api_stop: null,
  report: REPORT,
  ...over,
})

const toolUse = (name: string, input: Record<string, unknown>) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-1', name, input }] } })
const toolResult = (isError: boolean, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'user',
    ...extra,
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', is_error: isError, content: 'x' }] },
  })
const apiError = (error: string, text: string) =>
  JSON.stringify({
    type: 'assistant',
    isApiErrorMessage: true,
    error,
    message: { model: '<synthetic>', content: [{ type: 'text', text }] },
  })

const observed = (...lines: string[]): TranscriptWork => {
  const observer = workObserver()
  for (const line of lines) observer.observe(line)
  return observer.work()
}

describe('the work a transcript shows', () => {
  it('counts every errored tool result and no successful one', () => {
    const found = observed(toolResult(true), toolResult(false), toolResult(true))

    expect(found.tool_errors).toBe(2)
  })

  it('takes the last chat_send that opens as a report, whatever the server prefix', () => {
    const found = observed(
      toolUse('mcp__agent-chat__chat_send', { to: 'coord', text: 'Status: BLOCKED\nfirst try' }),
      toolUse('mcp__plugin_x__chat_send', { to: 'coord', text: REPORT }),
      toolUse('mcp__plugin_x__chat_send', { to: 'peer', text: 'thanks, looking now' }),
    )

    expect(found.report).toBe(REPORT)
  })

  it('reads a report from no other tool', () => {
    expect(observed(toolUse('Bash', { text: REPORT })).report).toBeNull()
  })

  it('marks a permission denial from the row that carries its kind', () => {
    expect(observed(toolResult(true, { toolDenialKind: 'rule' })).denied).toBe(true)
    expect(observed(toolResult(true)).denied).toBe(false)
  })

  it.each([
    ['rate_limit', "You've hit your session limit", 'rate-limited'],
    ['invalid_request', 'Prompt is too long', 'context-exhausted'],
    ['server_error', 'Internal server error', 'api-error'],
  ])('names an API refusal of kind %s', (error, text, stop) => {
    expect(observed(apiError(error, text)).api_stop).toBe(stop)
  })
})

describe('the pr and head a report names', () => {
  it.each([
    ['PR: example-org/widget#12', 'example-org/widget#12'],
    ['**PR:** https://github.com/example-org/widget/pull/12', 'example-org/widget#12'],
    ['PR: `example-org/widget#12`.', 'example-org/widget#12'],
    ['PR: none', null],
    ['Status: DONE', null],
  ])('reads %j as %j', (line, pr) => {
    expect(reportPr(`Status: DONE\n${line}`)).toBe(pr)
  })

  it('reads a full 40-hex head and refuses a short one', () => {
    expect(reportHead(REPORT)).toBe(HEAD)
    expect(reportHead('Head: 0123abc')).toBeNull()
  })
})

describe('the failure class', () => {
  it.each([
    ['Status: DONE', false, 'none'],
    ['Status: DONE_WITH_CONCERNS', false, 'none'],
    ['Verdict: FIX_FIRST\nPR: example-org/widget#12', false, 'none'],
    ['Status: BLOCKED', false, 'blocked'],
    ['Status: BLOCKED', true, 'tool-denied'],
    ['Status: NEEDS_CONTEXT', false, 'needs-context'],
    ['Status: HALF_DONE', false, 'unknown'],
  ])('maps a report of %j (denied %s) to %s', (report, denied, cls) => {
    expect(failureClassOf(work({ report, denied }))).toBe(cls)
  })

  it.each([
    [{}, 'no-report'],
    [{ denied: true }, 'tool-denied'],
    [{ denied: true, api_stop: 'rate-limited' as const }, 'rate-limited'],
    [{ api_stop: 'context-exhausted' as const }, 'context-exhausted'],
    [{ api_stop: 'api-error' as const }, 'api-error'],
  ])('maps a run with no report and %j to %s', (over, cls) => {
    expect(failureClassOf(work({ report: null, ...over }))).toBe(cls)
  })

  it('is unknown when the transcript was not read', () => {
    expect(failureClassOf(undefined)).toBe('unknown')
  })

  it('is always one of the exported list', () => {
    const reports = ['Status: whatever', 'Status:', 'nonsense', null]
    for (const report of reports) expect(FAILURE_CLASSES).toContain(failureClassOf(work({ report })))
  })
})

describe('the retire outcome', () => {
  it("prefers the report's head and never asks the branch", async () => {
    const fallback = vi.fn(async () => OTHER)

    const outcome = await retireOutcomeOf(work({ tool_errors: 3 }), fallback)

    expect(outcome).toEqual({
      pr: 'example-org/widget#12',
      head: HEAD,
      failure_class: 'none',
      tool_errors: 3,
    })
    expect(fallback).not.toHaveBeenCalled()
  })

  it('falls back to the branch head when the report names none, or the transcript was not read', async () => {
    expect(await retireOutcomeOf(work({ report: 'Status: BLOCKED' }), async () => OTHER)).toMatchObject({
      pr: null,
      head: OTHER,
    })
    expect(await retireOutcomeOf(undefined, async () => OTHER)).toEqual({
      pr: null,
      head: OTHER,
      failure_class: 'unknown',
      tool_errors: null,
    })
  })

  it('reads the branch head from the local ref only', async () => {
    const git = vi.fn(async () => OTHER)

    const head = await branchHead({ gitRoot: '/repo', branch: 'feat/x' }, git)

    expect(head).toBe(OTHER)
    expect(git).toHaveBeenCalledWith(
      ['rev-parse', '--verify', '--quiet', 'refs/heads/feat/x^{commit}'],
      '/repo',
    )
  })

  it('has no branch head without a worktree, a ref, or a sha', async () => {
    expect(await branchHead(undefined, async () => OTHER)).toBeNull()
    expect(await branchHead({ gitRoot: '/repo', branch: 'gone' }, async () => null)).toBeNull()
    expect(await branchHead({ gitRoot: '/repo', branch: 'odd' }, async () => 'not a sha')).toBeNull()
  })
})
