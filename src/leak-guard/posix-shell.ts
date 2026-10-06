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
 * Bash `-p` ignores the inherited SHELLOPTS and keeps the variable read-only; dash, ash and other sh
 * export it untouched, so a hostile `noexec` would reach a bash repo hook and silently skip it. The
 * scrub keys on behaviour, not the interpreter's path, and not on BASH_VERSION, which the agent could
 * set. `command` stops the readonly error from ending a bash-as-sh script.
 */
export const ENVIRONMENT_SCRUB = 'command unset SHELLOPTS 2>/dev/null\n'
