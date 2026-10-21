import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { parkWorktree } from '../agents/isolation/park.js'

const owned: string[] = []
const branch = 'agent-chat/late-paid-data'
const tracked = 'owned committed work\n'
const paid = 'owned completed paid output'
const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

function seed() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'park-late-paid-')))
  owned.push(root)
  const repo = path.join(root, 'repo')
  const origin = path.join(root, 'origin.git')
  const tree = path.join(root, 'tree')
  fs.mkdirSync(repo)
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.name', 'Test'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  fs.writeFileSync(path.join(repo, '.gitignore'), '.codewatch/\n')
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-qm', 'seed'])
  git(repo, ['clone', '-q', '--bare', repo, origin])
  git(repo, ['remote', 'add', 'origin', origin])
  git(repo, ['fetch', '-q', 'origin'])
  git(repo, ['worktree', 'add', '-qb', branch, tree])
  fs.writeFileSync(path.join(tree, 'feature.txt'), tracked)
  git(tree, ['add', '.'])
  git(tree, ['commit', '-qm', 'owned work'])
  const head = git(tree, ['rev-parse', 'HEAD'])
  const database = path.join(tree, '.codewatch', 'graph.db')
  fs.mkdirSync(path.dirname(database), { recursive: true })
  const db = new DatabaseSync(database)
  try {
    db.exec(
      'CREATE TABLE snapshot(id INTEGER PRIMARY KEY); INSERT INTO snapshot VALUES(1);' +
        'CREATE TABLE verdict(value TEXT); CREATE TABLE blob_cache(value TEXT); CREATE TABLE unfamiliar(value TEXT);',
    )
  } finally {
    db.close()
  }
  return { repo, tree, head, database, target: { gitRoot: repo, worktree: tree, branch, assigned: false } }
}

afterEach(() => {
  for (const root of owned.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe.each(['proof', 'caller'] as const)('late paid SQLite data at the %s boundary', phase => {
  it.each(['verdict', 'blob_cache', 'unfamiliar'] as const)(
    'keeps completed %s rows and the worktree',
    async table => {
      const f = seed()
      let mutationCompleted = false
      let readerCalls = 0
      const asked: { root: string; branch: string }[] = []
      const insert = () => {
        const db = new DatabaseSync(f.database)
        try {
          db.prepare('INSERT INTO "' + table + '" (value) VALUES (?)').run(paid)
        } finally {
          db.close()
        }
        mutationCompleted = true
      }
      const resources = () => {
        let rows: unknown = null
        if (fs.existsSync(f.database)) {
          const db = new DatabaseSync(f.database, { readOnly: true })
          try {
            rows = db.prepare('SELECT value FROM "' + table + '"').all()
          } finally {
            db.close()
          }
        }
        return {
          tree: fs.existsSync(f.tree),
          tracked: fs.existsSync(path.join(f.tree, 'feature.txt'))
            ? fs.readFileSync(path.join(f.tree, 'feature.txt'), 'utf8')
            : null,
          branchHead: git(f.repo, ['rev-parse', '--verify', 'refs/heads/' + branch]),
          rows,
        }
      }
      const before = resources()
      // 'proof' writes the paid row while park proves HEAD through a merged PR; 'caller' writes it in
      // the recheck, right before removal. Either way the late row must stop the park.
      const reader = async (root: string, actualBranch: string) => {
        readerCalls++
        asked.push({ root, branch: actualBranch })
        if (phase === 'proof') insert()
        return [{ number: 7, headSha: f.head }]
      }
      const result = await parkWorktree(
        f.target,
        () => {
          if (phase === 'caller') insert()
          return undefined
        },
        async () => [],
        reader,
      )
      const observation = {
        phase,
        table,
        before,
        result,
        after: resources(),
        mutationCompleted,
        readerCalls,
        asked,
      }
      expect(observation.before).toMatchObject({ tree: true, tracked, branchHead: f.head, rows: [] })
      expect(observation.mutationCompleted).toBe(true)
      expect(observation.readerCalls).toBe(1)
      expect(observation.asked).toEqual([{ root: f.repo, branch }])
      expect(observation.result).toMatchObject({ ok: false })
      expect(observation.after).toMatchObject({
        tree: true,
        tracked,
        branchHead: f.head,
        rows: [{ value: paid }],
      })
    },
  )
})
