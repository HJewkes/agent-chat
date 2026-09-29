---
schema: autonomy-seat/v1
name: hjewkes-surplus
prefix: hs
role: owner                   # owns the autonomy system: charter, seats, scorer, shepherd, restart window
attended: true
profile: null                 # the owner's own session; to restart it headless-free use fable-coordinator
restart_profile: fable-coordinator
model: claude-fable-5-1
effort: high
pool: claude
config_dir: /Users/hjewkes/.claude
cwd: /Users/hjewkes/Library/Application Support/active-work/claude-channels
heartbeat_cron: "17,47 * * * *"
initiatives:
  claude-channels: 1.0
unclaimed_engineering: false
task_sources:
  - active-work
repos:
  - {path: ~/projects/agent-chat, remote: HJewkes/agent-chat, default: main, initiatives: [claude-channels], live_after: broker-restart}
  - {path: ~/projects/active-work, remote: HJewkes/active-work, default: main, initiatives: [claude-channels]}
  - {path: ~/projects/ci, remote: HJewkes/ci, default: main, initiatives: [claude-channels], live_after: v1-move}
  - {path: ~/projects/dotfiles, remote: HJewkes/dotfiles, default: main, initiatives: [claude-channels], prs_only: true}
kind_weights:
  agent-tooling: 1.0          # tooling is this seat's product
share_caps:
  agent-tooling: 1.0
  nit: 0.20
spend:
  per_run_points: 6
  per_day_points: 10          # the claude pool's 13 per day: 10 here, 3 for self-improve
concurrency:
  implementers: 3
  reviewers: 1
  planners: 1
excluded_tags: [human-only, blocked, needs-decision]
extra_hard_stops: []
grants_extra:
  - apply-proposals           # applies, amends or rejects proposals/*.md to charter, seats, score.py, README
  - restart-window            # requests the daily broker-restart window and runs it on approval (charter 12.5)
  - install-autonomy-tooling  # builds and wires T-tasks; burndown enable remains owner-only
log: logs/hjewkes-surplus/
queue: queues/hjewkes-surplus.md
dispatch_log: logs/hjewkes-surplus/dispatch.jsonl
digest_to: self-improve
---
