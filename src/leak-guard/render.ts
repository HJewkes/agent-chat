import type { DenylistLoad } from './denylist.js'
import type { Finding } from './scan.js'

/** A path under the running user's home, shown from `~` so the home itself is never printed. */
export function tildify(file: string, home: string): string {
  const root = home.replace(/\/+$/, '')
  if (root === '') return file
  if (file === root) return '~'
  return file.startsWith(`${root}/`) ? `~${file.slice(root.length)}` : file
}

function where(f: Finding): string {
  const commit = f.commit === undefined ? '' : `${f.commit} `
  if (f.site === 'path') return `${commit}${f.file}  (file name)`
  if (f.site === 'message') return `${f.file}:${f.line}  (commit message)`
  return `${commit}${f.file}:${f.line}`
}

/** One line per finding, location and category only; the matched text is never shown. */
export function renderFindings(findings: readonly Finding[]): string[] {
  if (findings.length === 0) return []
  return [
    ...findings.map(f => `${where(f)}  ${f.category}`),
    `leak-scan: ${findings.length} finding(s). Remove the flagged text; the scan never prints what matched.`,
  ]
}

export type DenylistState = DenylistLoad['kind']

export function renderJson(findings: readonly Finding[], denylist: DenylistState): string {
  const rows = findings.map(({ site, file, line, category, fingerprint, commit }) => ({
    site,
    file,
    line,
    category,
    fingerprint,
    ...(commit === undefined ? {} : { commit }),
  }))
  return JSON.stringify({ denylist, findings: rows })
}

/** Names the file and the problem, never the file's content. */
export function renderDenylistProblem(load: DenylistLoad, displayPath: string): string | undefined {
  if (load.kind === 'ok') return undefined
  const problem =
    load.kind === 'missing'
      ? `no deny-list at ${displayPath}`
      : load.kind === 'empty'
        ? `no deny-list entries at ${displayPath}`
        : `the deny-list at ${displayPath} ${load.reason}`
  return `leak-scan: ${problem}. Only home-path was checked, so the scan cannot pass.`
}
