---
schema: autonomy-seat/v1
name: self-improve
prefix: si
role: hub
attended: false
profile: opus-coordinator
model: claude-opus-5-5
effort: high                 # target xhigh once CC-199 lands
pool: claude
config_dir: /Users/hjewkes/.claude
cwd: /Users/hjewkes/Library/Application Support/active-work/claude-channels/sources/autonomy
heartbeat_cron: "33 * * * *"  # hourly; this seat reads, it does not babysit PRs
initiatives: {}               # no product dispatch
unclaimed_engineering: false
analysis_scope: [hjewkes-surplus, titan-coord, voltras-coord]
task_sources: []
repos: []
spend:
  per_run_points: 2
  per_day_points: 3
  yield_when: {pool_five_hour_over: 50, owner_typed_within_min: 15}
concurrency:
  implementers: 0
  reviewers: 0
  planners: 0
  analysts: 2                 # explorer (sonnet) or reviewer (sonnet), read-only, for digests and retro data pulls
may_edit:                     # directly, no proposal needed
  - retros/**                 # daily retros and weekly calibration reports
  - logs/self-improve/**
  - queues/self-improve.md
  - proposals/**              # authoring only; hjewkes-surplus applies
  - morning/**                # the compiled Morning digest
  - tasks: {initiative: claude-channels, tag: self-improve, verbs: [add, edit]}   # friction and autonomy-tooling tasks
  - tasks: {initiative: any-in-a-seat-scope, verbs: [add], tag: self-improve}    # file friction where the tool lives
must_propose:                 # to hjewkes-surplus through proposals/
  - charter.md
  - seats/*.md
  - score.py
  - README.md
  - any other seat's queue file
  - any code, profile, skill or config
extra_hard_stops:
  - product-dispatch          # never spawns implementers or planners
  - agent-lifecycle           # never retires, resumes or messages another seat's agents
grants_extra: []
log: logs/self-improve/
queue: queues/self-improve.md
digest_to: null
---
