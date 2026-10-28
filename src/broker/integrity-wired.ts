/**
 * TP-4256 A3, TP-4347: how broker launches go through the integrity ledger. `off` leaves it out;
 * `shadow` runs it in full but writes an `integrity_would_deny` row where it would refuse, and
 * denies nothing; `enforce` refuses. A compile-time constant, not config, because config is
 * agent-writable. Its own module so `run-agent` and the hook read it without the broker.
 */
export type IntegrityMode = 'off' | 'shadow' | 'enforce'

export const INTEGRITY_MODE: IntegrityMode = 'off'
