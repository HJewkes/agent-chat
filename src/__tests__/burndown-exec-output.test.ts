import { describe, expect, it } from 'vitest'
import { run, type Runner } from '../agents/burndown/exec.js'
import { shepherdListed } from '../agents/burndown/shepherd.js'

describe('burndown exec output size', () => {
  it('reads a Shepherd status listing larger than 1 MiB', () => {
    const script =
      "const rows = Array.from({ length: 12000 }, (_, i) => ({ repo: 'o/r', pr: i + 1, branch: 'b' + i, pad: 'x'.repeat(100) }));" +
      'process.stdout.write(JSON.stringify(rows))'
    const exec: Runner = (_bin, _args, cwd, options) => run(process.execPath, ['-e', script], cwd, options)

    const listing = shepherdListed(exec)

    expect(listing?.prs.size).toBe(12000)
    expect(listing?.prs.has('o/r#12000')).toBe(true)
  })
})
