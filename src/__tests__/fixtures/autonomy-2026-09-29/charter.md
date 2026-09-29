---
schema: autonomy-charter/v1
title: Synthetic autonomy charter for the policy tests
created: '2026-09-29'
root: /tmp/autonomy
seats: [seat-a, seat-b, seat-c, seat-hub]
hub: seat-hub
human_only_initiatives: [init-private, init-household]
hard_stops: [broker-restart, deploy, spend-money]
defaults:
  kind_weights: {security: 1.0, product: 1.0, correctness: 0.9, platform: 0.8, agent-tooling: 0.6, docs: 0.5, nit: 0.35}
  share_caps: {agent-tooling: 0.30, nit: 0.20, discovery: 0.25}
  initiative_decay: 0.85
  score_terms: {severity: 0.40, priority_pct: 0.30, unblocks: 0.20, staleness: 0.10}
  severity: {critical: 1.0, high: 0.7, medium: 0.4, low: 0.15, unset: 0.3}
  readiness: {ready: 1.0, untriaged: 0.6, blocked: 0.25}
  size: {le3: 1.0, le8: 0.9, gt8: 0.75}
  stop_short_factor: 0.8
pools:
  pool-x: {config_dir: /tmp/pool-x, human_uses: true}
  pool-y: {config_dir: /tmp/pool-y, human_uses: false}
---
