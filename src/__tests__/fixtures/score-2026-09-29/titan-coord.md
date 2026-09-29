---
schema: autonomy-seat/v1
name: titan-coord
prefix: tc
role: product
attended: false
profile: opus-coordinator
model: claude-opus-5-5
effort: high                 # target xhigh once CC-199 (profile effort field) lands
pool: agents
config_dir: /Users/hjewkes/.claude-profiles/agents
cwd: /Users/hjewkes/projects
heartbeat_cron: "17,47 * * * *"
initiatives:                 # slug: owner scope weight
  relay: 1.0
  titan-platform: 0.8
  codewatch: 0.8
  herald: 0.7
  titan-design: 0.6
  brain: 0.6
  audiobook: 0.6
  demo-video-tooling: 0.5
  hermes: 0.4
unclaimed_engineering: true  # also takes any focused, non-human-only initiative no seat lists
unclaimed_weight: 0.5
task_sources:
  - active-work
  - {brain_pm: /Users/hjewkes/projects/brain/.brain, initiative: brain}   # read by CC-208; until then run `brain pm tasks` by hand
repos:
  - {path: ~/projects/relay, remote: HJewkes/relay, default: main, initiatives: [relay]}
  - {path: ~/projects/titan-platform, remote: HJewkes/titan-platform, default: main, initiatives: [titan-platform]}
  - {path: ~/projects/titan-design, remote: HJewkes/titan-design, default: main, initiatives: [titan-design], shared_with: [voltras-coord]}
  - {path: ~/projects/codewatch, remote: HJewkes/codewatch, default: main, initiatives: [codewatch]}
  - {path: ~/projects/herald, remote: HJewkes/herald, default: main, initiatives: [herald]}
  - {path: ~/projects/brain, remote: HJewkes/brain, default: main, initiatives: [brain]}
  - {path: ~/projects/audiobook, initiatives: [audiobook]}
  - {path: ~/projects/demo-video-tooling, initiatives: [demo-video-tooling]}
  - {path: ~/projects/home_assistant, remote: HJewkes/home_assistant, initiatives: [hermes]}
  - {path: ~/projects/workflow-improvement, initiatives: [titan-platform]}
  - {path: ~/projects/webfetch, initiatives: [titan-platform]}
  - {path: ~/projects/mascot-madness, initiatives: [titan-platform]}   # clone pending (hjewkes-surplus)
kind_weights: {}             # charter defaults
share_caps: {}               # charter defaults
spend:
  per_run_points: 15
  per_day_points: 20
concurrency:
  implementers: 5
  reviewers: 2
  planners: 2
excluded_tags: [human-only, blocked, needs-decision, owner-review-round]
extra_hard_stops: []
grants_extra:
  - relay-stack-50-55-merge   # owner-approved 2026-09-29, including migrations and the Worker deploy those merges trigger
log: logs/titan-coord/
queue: queues/titan-coord.md
dispatch_log: logs/titan-coord/dispatch.jsonl
digest_to: self-improve
---
