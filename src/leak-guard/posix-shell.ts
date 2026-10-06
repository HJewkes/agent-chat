import fs from 'node:fs'

const DASH = '/bin/dash'
const FALLBACK = '/bin/sh'

const isExecutableFile = (file: string): boolean => {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * The interpreter a generated script names on its first line, fixed when the script is written.
 * macOS `/bin/sh` re-execs bash, so dash saves one exec per run; no PATH or env lookup is involved.
 */
export const posixShell = (probe: (file: string) => boolean = isExecutableFile): string => {
  try {
    return probe(DASH) ? DASH : FALLBACK
  } catch {
    return FALLBACK
  }
}

/**
 * `-p` makes bash-as-sh ignore SHELLOPTS and imported functions. Dash has no such option (it rejects `-p`)
 * and has no such import, so it needs none; any other interpreter keeps the flag.
 */
export const hardenedShebang = (shell: string): string => (shell === DASH ? `#!${shell}` : `#!${shell} -p`)

/**
 * Under bash `-p` the inherited SHELLOPTS is ignored and re-exported clean; dash exports it untouched, so a
 * hostile `noexec` would reach a bash repo hook and silently skip it. Bash keeps the variable read-only
 * (unset errors there), so only dash scrubs it.
 */
export const environmentScrub = (shell: string): string => (shell === DASH ? 'unset SHELLOPTS\n' : '')
