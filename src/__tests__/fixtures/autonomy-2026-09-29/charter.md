---
schema: autonomy-charter/v1
title: Autonomy charter (generic; every seat runs this plus its seat file)
created: '2026-09-29'
owner_seat: hjewkes-surplus
supersedes: ../notes/2026-09-28-overnight-charter.md
design: ../CC-198-autonomy-plan.md
retro: ../notes/2026-09-29-coordination-retro.md
# Global data. A seat file may ADD to the lists and OVERRIDE the defaults; it may never remove a global hard stop.
root: /Users/hjewkes/Library/Application Support/active-work/claude-channels/sources/autonomy
seats: [hjewkes-surplus, titan-coord, voltras-coord, self-improve]
hub: self-improve
charter_owner: hjewkes-surplus
human_only_initiatives: [parents, finances, beken-bio-consulting, fantasy-football, basement-server,
  ai-investing-workflow, dog-oncology, recipes, logan, cars, taxes, denver-rezzy, cooking, youtube,
  computer-organization, farmer-was-replaced, chatgpt-archive]
hard_stops:          # action classes; a match on a task's done_when or on a worker's final action makes the task stop-short
  - ruleset-write          # repo-rulesets apply, branch protection, any repo-settings write
  - tag-move               # moving or cutting tags (HJewkes/ci v1 and all release tags)
  - npm-publish            # publish, Version Packages PRs, changeset releases
  - broker-restart         # except inside an approved restart window (Cross-seat protocol 5)
  - launchd-install        # launchd installs, burndown enable/install
  - dotfiles-merge         # merging or pushing HJewkes/dotfiles, chezmoi apply (PRs are fine)
  - config-edit            # CLAUDE.md, settings.json, ~/.claude*/.claude.json trust, ~/.agent-chat config and profiles
  - force-push             # to a default branch or another session's branch; reset --hard in a shared checkout; deleting unmerged work
  - deploy                 # wrangler deploy, any production deploy not triggered by an approved merge
  - spend-money            # purchases, orders, paid services
  - third-party-message    # mail, Telegram or chat to anyone but the owner; calendar invites
  - personal-data          # reading or writing a real person's health, financial or family data
defaults:
  kind_weights: {security: 1.0, product: 1.0, correctness: 0.9, platform: 0.8, agent-tooling: 0.6, docs: 0.5, nit: 0.35}
  share_caps: {agent-tooling: 0.30, nit: 0.20, discovery: 0.25}
  initiative_decay: 0.85
  score_terms: {severity: 0.40, priority_pct: 0.30, unblocks: 0.20, staleness: 0.10}
  severity: {critical: 1.0, high: 0.7, medium: 0.4, low: 0.15, unset: 0.3}
  readiness: {ready: 1.0, untriaged: 0.6, blocked: 0.25}
  size: {le3: 1.0, le8: 0.9, gt8: 0.75}
  stop_short_factor: 0.8
  gate_free_bonus: 1.15     # work whose value lands tonight without a human gate
  retire_k: {implementer: 200, reviewer: 300, planner: 250}
  teleport_k: 250
  worktrees_per_repo_per_seat: 3
  worktrees_left_free_per_repo: 2
  stale_pr_days: 7
  heartbeat_cron: "17,47 * * * *"
pools:               # billing pools; seats in the same pool share its caps
  claude:  {config_dir: /Users/hjewkes/.claude, human_uses: true, reserve_seven_day: 35, ceiling_five_hour: 70, per_day_points: 13}
  agents:  {config_dir: /Users/hjewkes/.claude-profiles/agents, human_uses: false, reserve_seven_day: 25, night_reserve_seven_day: 10, ceiling_five_hour: 85, per_day_points: 22}
  workout: {config_dir: /Users/hjewkes/.claude-profiles/workout, human_uses: true, reserve_seven_day: 35, ceiling_five_hour: 60, per_day_points: 12}
---
