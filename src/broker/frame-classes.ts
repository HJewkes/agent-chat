import type { ClientMessage } from '../protocol.js'

/**
 * The caller-gate class of every client frame (CC-1138, decided in
 * `docs/human-caller-gate.md`):
 *
 * 1. the human decided: refused from a connection that declared an agent id;
 * 2. requester mapped: the declared agent is the requester, an unknown id is refused;
 * 3. session bound: accepted only when the frame's subject is the declared agent;
 * 4. out of scope: guarded by the frame's own check, or read-only.
 *
 * Typed over the whole `ClientMessage` union, so a new frame does not compile until
 * someone decides its class. A test pins this table to the `handleMessage` cases.
 */
export type FrameClass = 1 | 2 | 3 | 4

export const FRAME_CLASSES: Readonly<Record<ClientMessage['t'], FrameClass>> = {
  human_send: 1,
  answer: 1,
  dismiss: 1,
  endorse_approve: 1,
  approve_permission: 1,
  teleport_abort: 1,
  service_ask: 1,
  account_move: 1,

  spawn: 2,
  resume: 2,
  surface: 2,
  park: 2,
  retire_finished: 2,
  retire: 2,

  permission_hook: 3,
  permission_self_granted: 3,
  codex_wake_capped: 3,

  send: 4,
  broadcast: 4,
  ask: 4,
  notify: 4,
  endorse: 4,
  subscribe: 4,
  unsubscribe: 4,
  tag: 4,
  claim: 4,
  release: 4,
  status: 4,
  approval: 4,
  decided: 4,
  teleport: 4,
  teleport_plan_wait: 4,
  teleport_launched: 4,
  background: 4,
  teleport_land_failed: 4,
  register: 4,
  readopt: 4,
  permission_hook_withdrawn: 4,
  host_hello: 4,
  host_challenge: 4,
  host_probe_result: 4,
  host_launch_result: 4,
  spawn_launched: 4,
  spawn_placed: 4,
  job_kick: 4,
  inbox: 4,
  list: 4,
  queue: 4,
  history: 4,
  inbox_since: 4,
  message_by_id: 4,
  activity: 4,
  reported: 4,
  answers_since: 4,
  agents: 4,
  hosts: 4,
}
