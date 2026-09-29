---
schema: autonomy-seat/v1
name: voltras-coord
prefix: vc
role: product
attended: false
profile: opus-coordinator
model: claude-opus-5-5
effort: high                 # target xhigh once CC-199 lands
pool: workout
config_dir: /Users/hjewkes/.claude-profiles/workout
cwd: /Users/hjewkes/projects/voltras-workspace
heartbeat_cron: "19,49 * * * *"   # offset from the other seats
initiatives:
  voltras-workspace: 1.0
  health: 0.7
unclaimed_engineering: false
task_sources:
  - active-work               # VW-* are THEMES ONLY; HL-* are real tasks
  - {brain_pm: /Users/hjewkes/projects/voltras-workspace/.brain, initiative: voltras-workspace,
     projects: [VMCP, SDK, TD, WA, VP, STATU], exclude_projects: [VLT]}   # the engineering tickets; read by CC-208
repos:
  - {path: ~/projects/voltras-mcp, remote: HJewkes/voltras-mcp, default: main, initiatives: [voltras-workspace]}
  - {path: ~/projects/voltra-node-sdk, remote: HJewkes/voltra-node-sdk, default: main, initiatives: [voltras-workspace], public: true}
  - {path: ~/projects/voltra-private, remote: HJewkes/voltra-private, default: main, initiatives: [voltras-workspace], confidential: true}
  - {path: ~/projects/workout-analytics, remote: HJewkes/workout-analytics, default: main, initiatives: [voltras-workspace], public: true}
  - {path: ~/projects/titan-design, remote: HJewkes/titan-design, default: main, initiatives: [voltras-workspace], shared_with: [titan-coord]}
  - {path: ~/Documents/health, default: main, initiatives: [health], local_only: true}
  - {path: ~/projects/dd-cli-ts, initiatives: [health]}
deny_repos: [~/projects/voltras]   # mobile (VLT): parked 2026-09-09, "stop asking"
kind_weights: {}
share_caps: {}
spend:
  per_run_points: 8
  per_day_points: 12
concurrency:
  implementers: 3
  reviewers: 1
  planners: 1
excluded_tags: [human-only, blocked, needs-decision, bench, human-action, clinical, mobile, household-2]
excluded_title_patterns: [appointment, workup, 'annual .*exam', DEXA, cardiolog, '\blabs?\b', '^book ', '^schedule ', relabel, 'TrueCoach import', onboarding answers]
extra_hard_stops:
  - live-device        # no voltras MCP tools at all (device.*, session.*, set.*, system.*); no wall, BLE or dashboard driving
  - bench-gated        # BENCH-tagged tickets and PRs that "merge from the wall" (voltras-mcp #247) wait for a sitting
  - protocol-disclosure  # no protocol bytes, frames, command codes or register names in any public artifact
  - private-data       # ~/.voltras/*.sqlite, health data/health.db, sources/private/**, TrueCoach imports and write-back, lifter set relabels
  - orders             # dd-cli, Instacart and DoorDash carts are never submitted (spend-money)
  - household-contact  # no message to the second household, the coach or any lifter
  - defaults-decisions # VMCP_AUTO_ARM default, onboarding answers, targets: human decisions
grants_extra: []
log: logs/voltras-coord/
queue: queues/voltras-coord.md
dispatch_log: logs/voltras-coord/dispatch.jsonl
digest_to: self-improve
---
