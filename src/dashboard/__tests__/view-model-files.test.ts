import { describe, expect, it } from 'vitest'
import { topFilesTouched } from '../view-model.js'

/**
 * `filesTouched` is path -> tools. The first cut of the Files Touched panel
 * read it as tool -> paths, which put "Read" and "Edit" in the list where
 * filenames belonged.
 */
const FILES_TOUCHED = {
  '/repo/src/app.ts': ['Read', 'Edit', 'Write'],
  '/repo/src/util.ts': ['Read', 'Edit'],
  '/repo/README.md': ['Read'],
}

describe('topFilesTouched', () => {
  it('ranks file paths, never tool names', () => {
    const top = topFilesTouched(FILES_TOUCHED, 8)
    expect(top.map(f => f.path)).toEqual(['/repo/src/app.ts', '/repo/src/util.ts', '/repo/README.md'])
    expect(top.flatMap(f => f.path)).not.toContain('Read')
  })

  it('reports the tools that touched each file', () => {
    const [first] = topFilesTouched(FILES_TOUCHED, 8)
    expect(first?.tools).toEqual(['Read', 'Edit', 'Write'])
  })

  it('honours the limit', () => {
    expect(topFilesTouched(FILES_TOUCHED, 2)).toHaveLength(2)
  })

  it('returns nothing for a session that touched no files', () => {
    expect(topFilesTouched({}, 8)).toEqual([])
  })
})
