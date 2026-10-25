import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  gitOverlayTargets,
  probeSandbox,
  sandboxArgv,
  writeSandboxGit,
  type SandboxGit,
} from '../agents/git-sandbox.js'
import { gitHooksEnv } from '../leak-guard/hooks-dir.js'

/**
 * CC-1645 S2: the rows that land past main's shim today (a git named by path, a reset PATH, sudo's
 * env), run inside the sandbox this module builds. The origin is non-local (127.0.0.1:<path> through
 * a fake ssh), so the shim's local exemption does not apply, and the guard's pre-push hook refuses
 * every push. R1, the sandbox shim's own real-git copy run by path, is the residual and still lands.
 */

const REAL_PATH = '/usr/local/bin:/usr/bin:/bin'
const SECURE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
const REFUSED = 'git-shim: push refused (no-verify)'
const AP = '/usr/bin/git push --no-verify origin HEAD:refs/heads/landed'
const OWN_HOME = 'export HOME=$PWD/hh; mkdir -p $HOME; unset GIT_CONFIG_GLOBAL; '

const probe = probeSandbox(process.env.PATH ?? '')
const hasZsh = fs.existsSync('/usr/bin/zsh')
const hasGh = fs.existsSync('/usr/bin/gh')
const skipReason = !probe.ok ? probe.reason : !fs.existsSync('/usr/bin/git') ? 'no /usr/bin/git' : ''

type Shell = 'bash' | 'zsh'
interface Row {
  id: string
  line: string
  shells: Shell[]
  needs?: 'gh' | 'zsh'
}

const ROWS: Row[] = [
  {
    id: 'D1 X=csh, nice +5',
    line: `X=csh; $X -c 'nice +5 /usr/bin/git push --no-verify origin HEAD:main'`,
    shells: ['bash'],
  },
  { id: 'D2 sh -c from unread text', line: `sh -c "$(cat s)"`, shells: ['bash'] },
  {
    id: 'D2b sh -c literal',
    line: `sh -c '/usr/bin/git push --no-verify origin HEAD:main'`,
    shells: ['bash'],
  },
  { id: 'D3 env -i', line: `env -i /usr/bin/git push --no-verify origin HEAD:main`, shells: ['bash'] },
  {
    id: 'D4 PATH reset',
    line: `PATH=/usr/bin:/bin git push --no-verify origin HEAD:main`,
    shells: ['bash', 'zsh'],
  },
  { id: 'D5 command -p', line: `command -p git push --no-verify origin HEAD:main`, shells: ['bash', 'zsh'] },
  {
    id: 'D6 sudo csh (emulated env)',
    line: `env -i PATH="$SECURE_PATH" HOME="$ROOTHOME" "$ST/csh" -c 'hup git push --no-verify origin HEAD:main'`,
    shells: ['bash'],
  },
  {
    id: 'D7 TP-4245 eval, $G $P1 $P2',
    line: `eval "$(cat f)"; $G $P1 $P2 origin HEAD:refs/heads/x`,
    shells: ['bash', 'zsh'],
  },
  {
    id: 'D8 git-core dashed',
    line: `/usr/lib/git-core/git-push --no-verify origin HEAD:main`,
    shells: ['bash'],
  },
  {
    id: 'D9 git-core git',
    line: `/usr/lib/git-core/git push --no-verify origin HEAD:main`,
    shells: ['bash'],
  },
  {
    id: 'D10 copy of /usr/bin/git',
    line: `cp /usr/bin/git ./g2 && ./g2 push --no-verify origin HEAD:main`,
    shells: ['bash'],
  },
  {
    id: 'D11 python, git by path',
    line: `python3 -c "import subprocess; subprocess.run(['/usr/bin/git','push','--no-verify','origin','HEAD:main'])"`,
    shells: ['bash'],
  },
  {
    id: 'T1 TP-4251 zsh -i sources an alias file',
    line: `${OWN_HOME}echo 'source ~/.aliases' > ~/.zshrc; printf '%s\\n' 'gp() { ${AP}; }' >> ~/.aliases; zsh -i -c gp`,
    shells: ['bash'],
    needs: 'zsh',
  },
  {
    id: 'T2 TP-4252 copied gh with an alias',
    line: `mkdir -p h/.config/gh; printf 'aliases:\\n  co: "!${AP}"\\n' > h/.config/gh/config.yml; cp /usr/bin/gh ./hub; HOME=$PWD/h ./hub co`,
    shells: ['bash'],
    needs: 'gh',
  },
  {
    id: 'T3 TP-4238 allowlisted alias !$X',
    line: `printf '[alias]\\n\\tp = !$X\\n' >> .git/config; X='${AP}' git p`,
    shells: ['bash'],
  },
  {
    id: 'T4a TP-4246 diff.external',
    line: `printf '[diff]\\n\\texternal = "%s"\\n' 'f() { ${AP}; }; f' >> .git/config; echo y >> R; git add -N R; git diff`,
    shells: ['bash'],
  },
  {
    id: 'T4b TP-4246 diff.external through tee',
    line: `${OWN_HOME}printf '[diff]\\n\\texternal = "%s"\\n' 'f() { ${AP}; }; f' | tee -a ~/.gitconfig >/dev/null; echo y >> R; git add -N R; git diff`,
    shells: ['bash'],
  },
  {
    id: 'T4c TP-4246 core.editor',
    line: `printf '[core]\\n\\teditor = "%s"\\n' 'f() { ${AP}; echo m > $1; }; f' >> .git/config; unset GIT_EDITOR VISUAL EDITOR; git -c user.name=t -c user.email=t@t commit --allow-empty`,
    shells: ['bash'],
  },
  { id: 'T5 TP-4258 printf -v subscript', line: `i='$(${AP})'; printf -v "a[$i]" x`, shells: ['bash'] },
  {
    id: 'T6a CC-1634 python argv split',
    line: `python3 -c 'import subprocess,sys; subprocess.run(sys.argv[1].split())' '${AP}'`,
    shells: ['bash'],
  },
  {
    id: 'T6b CC-1634 python with a bare env',
    line: `python3 -c 'import subprocess,sys,os; subprocess.run(sys.argv[1].split(), env={"HOME": os.environ["HOME"]})' 'git push --no-verify origin HEAD:refs/heads/landed'`,
    shells: ['bash'],
  },
  {
    id: 'T6c CC-1634 perl resets PATH',
    line: `perl -e '$ENV{PATH}="/usr/bin:/bin"; system("git push --no-verify origin HEAD:refs/heads/landed")'`,
    shells: ['bash'],
  },
  { id: 'T7 CC-1638 zsh {sh}', line: `echo '${AP}' | {sh}`, shells: ['zsh'] },
]

const R1 = `"$RG/git" push --no-verify origin HEAD:main`

let scratch = ''
let guard = ''
let standins = ''
let sandbox: SandboxGit
let bwrapArgv: string[] = []

function writeExecutable(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}

/** A csh stand-in that decodes the two csh spellings the rows use, then runs the text with sh. */
function writeStandins(): void {
  writeExecutable(
    path.join(standins, 'csh'),
    '[ "$1" = -c ] && shift\nt=$(printf %s "$1" | sed -e "s/nice +5/nice -n 5/" -e "s/^hup /nohup /")\nexec /bin/sh -c "$t"',
  )
}

beforeAll(() => {
  if (skipReason !== '' || !probe.ok) return
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-sandbox-rows-')))
  guard = path.join(scratch, 'guard')
  standins = path.join(scratch, 'standins')
  writeExecutable(path.join(guard, 'pre-push'), `echo 'guard pre-push ran' >&2; exit 1`)
  writeStandins()
  const built = writeSandboxGit(path.join(scratch, 'state'), guard, REAL_PATH, ['p'], {
    HOME: path.join(scratch, 'home'),
  })
  if (built === undefined) throw new Error('sandbox git not written')
  sandbox = built
  bwrapArgv = [
    probe.bwrap,
    ...sandboxArgv({ shim: sandbox.shim, targets: gitOverlayTargets(REAL_PATH, sandbox) }),
  ]
})
afterAll(() => {
  if (scratch !== '') fs.rmSync(scratch, { recursive: true, force: true })
})

const setupEnv = (): NodeJS.ProcessEnv => ({
  PATH: REAL_PATH,
  HOME: path.join(scratch, 'home'),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Probe',
  GIT_AUTHOR_EMAIL: 'probe@example.com',
  GIT_COMMITTER_NAME: 'Probe',
  GIT_COMMITTER_EMAIL: 'probe@example.com',
})

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('/usr/bin/git', args, { cwd, env: setupEnv(), encoding: 'utf8' }).trim()

/** A non-local origin holding main, and a work tree one synthetic commit ahead of it. */
function fixture(): { root: string; work: string; head: string } {
  const root = fs.mkdtempSync(path.join(scratch, 'fx-'))
  const work = path.join(root, 'work')
  const origin = path.join(root, 'origin.git')
  git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  git(root, 'init', '-q', '-b', 'main', work)
  fs.writeFileSync(path.join(work, 'seed'), 'seed\n')
  git(work, 'add', 'seed')
  git(work, 'commit', '-qm', 'seed')
  git(work, 'push', '-q', origin, 'main')
  writeExecutable(path.join(root, 'fake-ssh'), 'shift\nexec /bin/sh -c "PATH=/usr/bin:/bin; $*"')
  git(work, 'remote', 'add', 'origin', `127.0.0.1:${origin}`)
  git(work, 'config', 'core.sshCommand', path.join(root, 'fake-ssh'))
  git(work, 'config', 'ssh.variant', 'simple')
  fs.writeFileSync(path.join(work, 'leak.txt'), 'synthetic-term\n')
  git(work, 'add', 'leak.txt')
  git(work, 'commit', '-qm', 'leak')
  fs.writeFileSync(path.join(work, 'f'), 'export G=/usr/bin/git P1=push P2=--no-verify\n')
  fs.writeFileSync(path.join(work, 's'), '/usr/bin/git push --no-verify origin HEAD:main\n')
  return { root, work, head: git(work, 'rev-parse', 'HEAD') }
}

/** The env the launcher gives an agent: the sandbox shim first on PATH, its mirror, and the guard. */
const agentEnv = (): NodeJS.ProcessEnv => ({
  HOME: path.join(scratch, 'home'),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  LANG: 'C',
  PATH: `${path.dirname(sandbox.shim)}:${standins}:${REAL_PATH}`,
  GIT_EXEC_PATH: sandbox.mirror,
  ...gitHooksEnv(guard),
  ST: standins,
  RG: path.dirname(sandbox.realCopy),
  SECURE_PATH,
  ROOTHOME: path.join(scratch, 'roothome'),
})

function runSandboxed(line: string, shell: Shell): { landed: boolean; stderr: string } {
  const fx = fixture()
  const shellArgv =
    shell === 'zsh' ? ['/usr/bin/zsh', '-f', '-c', line] : ['/bin/bash', '--noprofile', '--norc', '-c', line]
  const [bin, ...args] = [...bwrapArgv, ...shellArgv] as [string, ...string[]]
  const out = spawnSync(bin, args, { cwd: fx.work, env: agentEnv(), encoding: 'utf8', timeout: 60_000 })
  const refs = git(path.join(fx.root, 'origin.git'), 'for-each-ref', '--format=%(objectname)')
  return { landed: refs.split('\n').includes(fx.head), stderr: out.stderr }
}

const cases = ROWS.flatMap(row => row.shells.map(shell => ({ ...row, shell, name: `${row.id} (${shell})` })))
const unmet = (c: (typeof cases)[number]): string => {
  if (c.needs === 'gh' && !hasGh) return 'no /usr/bin/gh'
  return (c.shell === 'zsh' || c.needs === 'zsh') && !hasZsh ? 'no /usr/bin/zsh' : ''
}

describe.skipIf(skipReason !== '')(
  `rows inside the git sandbox (CC-1645 S2)${skipReason === '' ? '' : `: skipped, ${skipReason}`}`,
  () => {
    it.for(cases)('$name is refused by the shim and lands nothing', (c, ctx) => {
      if (unmet(c) !== '') ctx.skip(unmet(c))

      const result = runSandboxed(c.line, c.shell)

      expect(result.stderr).toContain(REFUSED)
      expect(result.landed).toBe(false)
    })

    it('R1 residual: the sandbox shim’s own real-git copy run by path still lands', () => {
      const result = runSandboxed(R1, 'bash')

      expect(result.landed).toBe(true)
    })
  },
)
