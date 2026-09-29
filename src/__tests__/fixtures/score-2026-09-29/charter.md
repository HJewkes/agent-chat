---
schema: autonomy-charter/v1
title: Synthetic charter for the score.py parity fixture (hard_stops and defaults copied from the 2026-09-29 charter)
seats: [sample-seat]
human_only_initiatives: [zeta]
hard_stops:
  - ruleset-write
  - tag-move
  - npm-publish
  - broker-restart
  - launchd-install
  - dotfiles-merge
  - config-edit
  - force-push
  - deploy
  - spend-money
  - third-party-message
  - personal-data
defaults:
  kind_weights: {security: 1.0, product: 1.0, correctness: 0.9, platform: 0.8, agent-tooling: 0.6, docs: 0.5, nit: 0.35}
  share_caps: {agent-tooling: 0.30, nit: 0.20, discovery: 0.25}
  initiative_decay: 0.85
  score_terms: {severity: 0.40, priority_pct: 0.30, unblocks: 0.20, staleness: 0.10}
  severity: {critical: 1.0, high: 0.7, medium: 0.4, low: 0.15, unset: 0.3}
  readiness: {ready: 1.0, untriaged: 0.6, blocked: 0.25}
  size: {le3: 1.0, le8: 0.9, gt8: 0.75}
  stop_short_factor: 0.8
---
