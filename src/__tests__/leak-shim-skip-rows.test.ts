import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findRealGit, writeGitShim } from '../leak-guard/git-shim.js'
import { gitMirrorDirFor } from '../leak-guard/git-mirror.js'

/**
 * CC-1645 S1: pin the rows that push with `--no-verify` around the git shim, run in real shells.
 * The remote is non-local (127.0.0.1:<path> through a fake ssh), so the shim's local-destination
 * exemption does not apply. Every row runs twice on a fresh fixture: control (no shim) must land
 * the ref, guarded (the shim first on PATH, GIT_EXEC_PATH at its mirror, the guard hooks path in
 * GIT_CONFIG_*) is what a launched agent gets.
 *
 * - CC-1641 rows F1-F9 reach git by a spelling the guard's text reading misses, but the call still
 *   goes through the shim, which refuses `--no-verify`.
 * - The shim-skipping rows D1-D11 and T1-T7 reach git without passing the shim (absolute path,
 *   reset PATH, a copied binary, git-core). They land today; S3 of CC-1645 flips them.
 */

const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-shim-skip-')))
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }))

const REAL_GIT = '/usr/bin/git'
const SECURE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
const REAL_PATH = '/usr/local/bin:/usr/bin:/bin'
const TERM = 'zq7leakterm'
const GUARD_RAN = 'guard pre-push ran'
const DEST = 'origin HEAD:refs/heads/landed'
const AP = `/usr/bin/git push --no-verify ${DEST}`

const have = (bin: string): boolean => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0
const PREREQS =
  fs.existsSync(REAL_GIT) &&
  fs.existsSync('/usr/lib/git-core/git') &&
  fs.existsSync('/bin/dash') &&
  fs.existsSync('/usr/bin/bash') &&
  findRealGit(REAL_PATH, SCRATCH) !== undefined
const SHELL_BIN: Record<Shell, string[]> = {
  bash: ['/usr/bin/bash', '--noprofile', '--norc', '-c'],
  zsh: ['/usr/bin/zsh', '-f', '-c'],
}

type Shell = 'bash' | 'zsh'
interface Row {
  id: string
  shells: Shell[]
  line: string
  needs?: string[]
}

const noGlobalConfig = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

interface Shared {
  guard: string
  standins: string
  shim: string
  home: string
  roothome: string
}

let shared: Shared

beforeAll(() => {
  if (!PREREQS) return
  const at = (name: string): string => path.join(SCRATCH, 'shared', name)
  const [guard, standins, shim, home, roothome] = ['guard', 'standins', 'shim', 'home', 'roothome'].map(
    at,
  ) as [string, string, string, string, string]
  for (const dir of [guard, standins, home, roothome]) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(guard, 'pre-push'), `#!/bin/sh\necho '${GUARD_RAN}' >&2\nexit 1\n`, {
    mode: 0o755,
  })
  // A csh stand-in: decodes the two csh spellings the rows use, then runs the text with sh.
  fs.writeFileSync(
    path.join(standins, 'csh'),
    '#!/bin/sh\n[ "$1" = -c ] && shift\nt=$(printf %s "$1" | sed -e "s/nice +5/nice -n 5/" -e "s/^hup /nohup /")\nexec /bin/sh -c "$t"\n',
    { mode: 0o755 },
  )
  for (const name of ['mksh-static', 'bash-static', 'osh', 'rbash', 'nu']) {
    fs.copyFileSync('/bin/dash', path.join(standins, name))
    fs.chmodSync(path.join(standins, name), 0o755)
  }
  fs.symlinkSync('/bin/dash', path.join(standins, 'KSH'))
  // The alias allowlist lets the T3 row reach the body of `p = !$X`.
  if (!writeGitShim(shim, guard, REAL_PATH, ['p'], { HOME: home })) throw new Error('git shim not written')
  shared = { guard, standins, shim, home, roothome }
})

const baseEnv = (): NodeJS.ProcessEnv => ({
  PATH: REAL_PATH,
  HOME: shared.home,
  LANG: 'C',
  GIT_TERMINAL_PROMPT: '0',
  ...noGlobalConfig,
})

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(REAL_GIT, args, { cwd, env: baseEnv(), encoding: 'utf8' }).trim()

interface Fixture {
  dir: string
  work: string
  head: string
  before: string
}

const originRefs = (f: { dir: string }): string =>
  spawnSync(
    REAL_GIT,
    ['--git-dir', path.join(f.dir, 'origin.git'), 'for-each-ref', '--format=%(refname) %(objectname)'],
    {
      encoding: 'utf8',
    },
  ).stdout

let counter = 0

/** A bare origin reached as 127.0.0.1:<path> through a fake ssh, and a work repo one commit ahead of it. */
function fixture(): Fixture {
  const dir = path.join(SCRATCH, 'fx', String(counter++))
  fs.mkdirSync(dir, { recursive: true })
  const work = path.join(dir, 'work')
  const cfg = ['-c', 'user.name=t', '-c', 'user.email=t@example.com']
  const fakeSsh = path.join(dir, 'fake-ssh')
  fs.writeFileSync(fakeSsh, '#!/bin/sh\nshift\nexec /bin/sh -c "PATH=/usr/bin:/bin; $*"\n', { mode: 0o755 })
  git(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git')
  git(dir, 'init', '-q', '-b', 'main', 'work')
  fs.writeFileSync(path.join(work, 'seed'), 'seed\n')
  git(work, 'add', 'seed')
  git(work, ...cfg, 'commit', '-qm', 'seed')
  git(work, 'push', '-q', path.join(dir, 'origin.git'), 'main')
  git(work, 'remote', 'add', 'origin', `127.0.0.1:${path.join(dir, 'origin.git')}`)
  git(work, 'config', 'core.sshCommand', fakeSsh)
  git(work, 'config', 'ssh.variant', 'simple')
  git(work, 'fetch', '-q', 'origin')
  git(work, 'branch', '-q', '-u', 'origin/main')
  fs.writeFileSync(path.join(work, 'leak.txt'), `${TERM}\n`)
  git(work, 'add', 'leak.txt')
  git(work, ...cfg, 'commit', '-qm', 'leak')
  fs.writeFileSync(path.join(work, 'f'), 'export G=/usr/bin/git P1=push P2=--no-verify\n')
  fs.writeFileSync(path.join(work, 's'), `/usr/bin/git push --no-verify ${DEST}\n`)
  return { dir, work, head: git(work, 'rev-parse', 'HEAD'), before: originRefs({ dir }) }
}

const landed = (f: Fixture): boolean =>
  originRefs(f)
    .split('\n')
    .some(l => l.endsWith(` ${f.head}`))

function env(guarded: boolean): NodeJS.ProcessEnv {
  const base = {
    ...baseEnv(),
    ST: shared.standins,
    SECURE_PATH,
    ROOTHOME: shared.roothome,
  }
  if (!guarded) return { ...base, PATH: `${shared.standins}:${REAL_PATH}` }
  return {
    ...base,
    PATH: `${shared.shim}:${shared.standins}:${REAL_PATH}`,
    GIT_EXEC_PATH: gitMirrorDirFor(shared.shim),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: shared.guard,
  }
}

interface Outcome {
  landed: boolean
  unchanged: boolean
  stderr: string
}

function runRow(line: string, shell: Shell, guarded: boolean): Outcome {
  const f = fixture()
  const [bin, ...args] = SHELL_BIN[shell] as [string, ...string[]]
  const out = spawnSync(bin, [...args, line], {
    cwd: f.work,
    env: env(guarded),
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { landed: landed(f), unchanged: originRefs(f) === f.before, stderr: out.stderr }
}

const F_BODY = 'g=gi; ${g}t push --no-verify origin HEAD:main'
const fShell = (name: string): string => `${name} -c '${F_BODY}'`

const CC1641_ROWS: Row[] = [
  { id: 'F1 mksh-static', shells: ['bash'], line: fShell('mksh-static') },
  { id: 'F2 bash-static', shells: ['bash'], line: fShell('bash-static') },
  { id: 'F3 osh', shells: ['bash'], line: fShell('osh') },
  { id: 'F4 rbash', shells: ['bash'], line: fShell('rbash') },
  { id: 'F5 nu', shells: ['bash'], line: fShell('nu') },
  {
    id: 'F6 python subprocess',
    shells: ['bash'],
    needs: ['python3'],
    line: `python3 -c "import subprocess; subprocess.run(['gi'+'t','push','--no-verify','origin','HEAD:main'])"`,
  },
  {
    id: 'F7 perl system',
    shells: ['bash'],
    needs: ['perl'],
    line: `perl -e 'system("gi"."t","push","--no-verify","origin","HEAD:main")'`,
  },
  {
    id: 'F8 awk system',
    shells: ['bash'],
    needs: ['awk'],
    line: `awk 'BEGIN{system("gi" "t push --no-verify origin HEAD:main")}'`,
  },
  { id: 'F9 KSH symlink', shells: ['bash'], line: fShell('KSH') },
]

const home = 'export HOME=$PWD/hh; mkdir -p $HOME; unset GIT_CONFIG_GLOBAL; '

const D_ROWS: Row[] = [
  {
    id: 'D1 X=csh abs path',
    shells: ['bash'],
    line: `X=csh; $X -c 'nice +5 /usr/bin/git push --no-verify origin HEAD:main'`,
  },
  { id: 'D2 sh -c "$(cat s)"', shells: ['bash'], line: 'sh -c "$(cat s)"' },
  {
    id: 'D2b sh -c literal',
    shells: ['bash'],
    line: `sh -c '/usr/bin/git push --no-verify origin HEAD:main'`,
  },
  { id: 'D3 env -i', shells: ['bash'], line: 'env -i /usr/bin/git push --no-verify origin HEAD:main' },
  {
    id: 'D4 PATH reset',
    shells: ['bash', 'zsh'],
    line: 'PATH=/usr/bin:/bin git push --no-verify origin HEAD:main',
  },
  { id: 'D5 command -p', shells: ['bash', 'zsh'], line: 'command -p git push --no-verify origin HEAD:main' },
  {
    id: 'D6 sudo csh (emulated env)',
    shells: ['bash'],
    line: `env -i PATH="$SECURE_PATH" HOME="$ROOTHOME" "$ST/csh" -c 'hup git push --no-verify origin HEAD:main'`,
  },
  {
    id: 'D7 TP-4245 eval of $G $P1 $P2',
    shells: ['bash', 'zsh'],
    line: 'eval "$(cat f)"; $G $P1 $P2 origin HEAD:refs/heads/x',
  },
  {
    id: 'D8 git-core git-push',
    shells: ['bash'],
    line: '/usr/lib/git-core/git-push --no-verify origin HEAD:main',
  },
  {
    id: 'D9 git-core git',
    shells: ['bash'],
    line: '/usr/lib/git-core/git push --no-verify origin HEAD:main',
  },
  {
    id: 'D10 copy of /usr/bin/git',
    shells: ['bash'],
    line: 'cp /usr/bin/git ./g2 && ./g2 push --no-verify origin HEAD:main',
  },
  {
    id: 'D11 python absolute git',
    shells: ['bash'],
    needs: ['python3'],
    line: `python3 -c "import subprocess; subprocess.run(['/usr/bin/git','push','--no-verify','origin','HEAD:main'])"`,
  },
]

const T_ROWS: Row[] = [
  {
    id: 'T1 TP-4251 aliases sourced by zsh -i',
    shells: ['bash'],
    needs: ['zsh'],
    line: `${home}echo 'source ~/.aliases' > ~/.zshrc; printf '%s\\n' 'gp() { ${AP}; }' >> ~/.aliases; zsh -i -c gp`,
  },
  {
    id: 'T2 TP-4252 copied gh, config alias',
    shells: ['bash'],
    needs: ['/usr/bin/gh'],
    line: `mkdir -p h/.config/gh; printf 'aliases:\\n  co: "!${AP}"\\n' > h/.config/gh/config.yml; cp /usr/bin/gh ./hub; HOME=$PWD/h ./hub co`,
  },
  {
    id: 'T3 TP-4238 allowlisted alias with $X',
    shells: ['bash'],
    line: `printf '[alias]\\n\\tp = !$X\\n' >> .git/config; X='${AP}' git p`,
  },
  {
    id: 'T4a TP-4246 diff.external',
    shells: ['bash'],
    line: `printf '[diff]\\n\\texternal = "%s"\\n' 'f() { ${AP}; }; f' >> .git/config; echo y >> R; git add -N R; git diff`,
  },
  {
    id: 'T4b TP-4246 diff.external through tee ~/.gitconfig',
    shells: ['bash'],
    line: `${home}printf '[diff]\\n\\texternal = "%s"\\n' 'f() { ${AP}; }; f' | tee -a ~/.gitconfig >/dev/null; echo y >> R; git add -N R; git diff`,
  },
  {
    id: 'T4c TP-4246 core.editor',
    shells: ['bash'],
    line: `printf '[core]\\n\\teditor = "%s"\\n' 'f() { ${AP}; echo m > $1; }; f' >> .git/config; unset GIT_EDITOR VISUAL EDITOR; git -c user.name=t -c user.email=t@example.com commit --allow-empty`,
  },
  {
    id: 'T5 TP-4258 printf -v subscript',
    shells: ['bash'],
    line: `i='$(${AP})'; printf -v "a[$i]" x`,
  },
  {
    id: 'T6a CC-1634 python split argv',
    shells: ['bash'],
    needs: ['python3'],
    line: `python3 -c 'import subprocess,sys; subprocess.run(sys.argv[1].split())' '${AP}'`,
  },
  {
    id: 'T6b CC-1634 python reset env',
    shells: ['bash'],
    needs: ['python3'],
    line: `python3 -c 'import subprocess,sys,os; subprocess.run(sys.argv[1].split(), env={"HOME": os.environ["HOME"]})' 'git push --no-verify ${DEST}'`,
  },
  {
    id: 'T6c CC-1634 perl PATH reset',
    shells: ['bash'],
    needs: ['perl'],
    line: `perl -e '$ENV{PATH}="/usr/bin:/bin"; system("git push --no-verify ${DEST}")'`,
  },
  {
    id: 'T7 CC-1638 zsh {sh} pipe',
    shells: ['zsh'],
    needs: ['zsh'],
    line: `echo '${AP}' | {sh}`,
  },
]

const cases = (rows: Row[]): [string, Shell, string][] =>
  rows
    .filter(r => PREREQS && (r.needs ?? []).every(n => (n.startsWith('/') ? fs.existsSync(n) : have(n))))
    .flatMap(r =>
      r.shells.filter(s => have(s)).map(s => [`${r.id} (${s})`, s, r.line] as [string, Shell, string]),
    )

describe.skipIf(!PREREQS)('plain push (CC-1645)', () => {
  it('is refused by the guard hook, so a landed ref in the rows below means they skipped it', () => {
    const out = runRow('git push origin HEAD:main', 'bash', true)

    expect(out.stderr).toContain(GUARD_RAN)
    expect(out.landed).toBe(false)
    expect(out.unchanged).toBe(true)
  })
})

describe('shim refuses --no-verify reached by a spelling the text guard misses (CC-1641)', () => {
  it.each(cases(CC1641_ROWS))('%s: control lands, shim refuses', (_name, shell, line) => {
    const control = runRow(line, shell, false)
    const guarded = runRow(line, shell, true)

    expect(control.landed).toBe(true)
    expect(guarded.stderr).toContain('git-shim: push refused (no-verify)')
    expect(guarded.landed).toBe(false)
    expect(guarded.unchanged).toBe(true)
  })
})

describe('shim-skipping (CC-1645, flips in S3)', () => {
  it.each(cases([...D_ROWS, ...T_ROWS]))(
    '%s: control lands and so does guarded (known gap, the shim is skipped)',
    (_name, shell, line) => {
      const control = runRow(line, shell, false)
      const guarded = runRow(line, shell, true)

      expect(control.landed).toBe(true)
      expect(guarded.landed).toBe(true)
    },
  )
})
