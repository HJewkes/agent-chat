export interface Site {
  path: string
  kind: string
  line: number
}
export interface DoorRecord {
  path: string
  kind: string
  why: string
  owner: string
  coordinatorSideDoor: boolean
  /** A known exception outside src/, kept as a record only; it is never matched against a site. */
  external?: boolean
}
export interface AuditResult {
  sites: Site[]
  unrecorded: Site[]
  stale: DoorRecord[]
  coordinatorSideDoors: DoorRecord[]
}
export const KINDS: Record<string, RegExp>
export function scan(root: string): Site[]
export function loadRecords(root: string): DoorRecord[]
export function audit(root: string): AuditResult
export function report(result: AuditResult): { ok: boolean; text: string }
