---
schema: autonomy-seat/v1
name: seat-a
prefix: sa
role: owner
pool: pool-x
config_dir: /tmp/pool-x
initiatives:
  init-alpha: 1.0
unclaimed_engineering: false
kind_weights:
  agent-tooling: 1.0
share_caps:
  agent-tooling: 1.0
  nit: 0.20
excluded_tags: [human-only, blocked]
repos:
  - {path: /tmp/repos/alpha-app, default: main, initiatives: [init-alpha]}
  - {path: /tmp/repos/alpha-docs, initiatives: [init-alpha]}
concurrency:
  implementers: 4
  reviewers: 2
  planners: 1
grants_extra: [grant-merge-alpha]
spend:
  per_run_points: 5
  per_day_points: 9
---
