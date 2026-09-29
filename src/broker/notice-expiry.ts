/**
 * CC-173: a plain notice expires at read time once it is older than the notice TTL.
 *
 * Derived rather than written: no resolution row is appended, so the log keeps
 * exactly what happened and a TTL change applies retroactively in both directions.
 * "Plain" means `kind = 'notice'` with no `meta.kind`. Questions, approvals and
 * endorsements are other event kinds and never match; kinded notices
 * (`ready-to-merge`, `needs-grant`, `stalled`) announce something still waiting
 * on the human, so they stay open until dismissed. Binds one parameter: the
 * oldest `ts` a plain notice may have and still count as open.
 */
export const NOTICE_LIVE = `(kind != 'notice' OR json_extract(meta, '$.kind') IS NOT NULL OR ts > ?)`
