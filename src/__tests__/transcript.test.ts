import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findTranscript, projectSlug, transcriptLine, transcriptPath } from '../agents/transcript.js'

/**
 * A fake `~/.claude` so nothing here reads the developer's real transcripts —
 * the same discipline the supervisor tests use to stay off real iTerm.
 */
let configDir: string

const writeTranscript = (slug: string, sessionId: string): string => {
  const dir = path.join(configDir, 'projects', slug)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${sessionId}.jsonl`)
  fs.writeFileSync(file, '{"type":"user"}\n')
  return file
}

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-transcript-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR
  fs.rmSync(configDir, { recursive: true, force: true })
})

describe('project slug', () => {
  it('replaces every non-alphanumeric byte, dots and separators alike', () => {
    // Both taken from real directories on the machine this was derived from.
    expect(projectSlug('/Users/hjewkes/projects/agent-chat')).toBe('-Users-hjewkes-projects-agent-chat')
    expect(projectSlug('/Users/hjewkes/.claude/sessions')).toBe('-Users-hjewkes--claude-sessions')
  })

  it('collapses spaces the same way, so a path under Application Support resolves', () => {
    expect(projectSlug('/Users/h/Library/Application Support/x')).toBe(
      '-Users-h-Library-Application-Support-x',
    )
  })
})

describe('finding a spawned agent transcript', () => {
  const CWD = '/Users/hjewkes/projects/agent-chat'
  const SESSION = '90b4944a-2f7e-4142-93e8-572847efd6d3'

  it('resolves the derived path when the cwd is what Claude Code recorded', () => {
    const written = writeTranscript(projectSlug(CWD), SESSION)
    expect(findTranscript(CWD, SESSION)).toEqual({ path: written, exists: true })
    expect(transcriptPath(CWD, SESSION)).toBe(written)
  })

  /**
   * Observed for real: a session recorded a cwd that disagreed with the directory
   * holding it, because the path it was given was a symlink. The session id is a
   * uuid, so scanning for it is exact rather than a guess.
   */
  it('finds a transcript filed under a different cwd than the one we asked for', () => {
    const written = writeTranscript(projectSlug('/Users/hjewkes/Documents/projects/agent-chat'), SESSION)
    const found = findTranscript(CWD, SESSION)
    expect(found).toEqual({ path: written, exists: true })
  })

  it('reports the derived path as not-yet-written rather than claiming a miss is an error', () => {
    const found = findTranscript(CWD, SESSION)
    expect(found.exists).toBe(false)
    expect(found.path).toBe(transcriptPath(CWD, SESSION))
    expect(transcriptLine(CWD, SESSION)).toContain('not written yet')
  })

  it('says plainly that an agent spawned before session ids were recorded has none', () => {
    expect(findTranscript(CWD, '')).toEqual({ path: transcriptPath(CWD, ''), exists: false })
    expect(transcriptLine(CWD, '')).toBe('transcript: none recorded for this agent')
  })

  it('survives a machine with no Claude Code config at all', () => {
    fs.rmSync(configDir, { recursive: true, force: true })
    expect(findTranscript(CWD, SESSION).exists).toBe(false)
  })
})
