/**
 * TP-4256 A3: whether broker launches go through the integrity ledger and `run-agent` asks its
 * verdict. A compile-time constant, not config, because config is agent-writable. Its own module so
 * `run-agent` reads it without the broker.
 */
export const INTEGRITY_WIRED = true
