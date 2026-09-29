# score.py parity fixture (CC-229)

Every task, initiative and seat here is invented. The backlog lives in `generate.mjs`, which
writes `tasks.json` deterministically. `charter.md` keeps the real charter's `hard_stops` and
`defaults` and nothing else. `seats/sample-seat.md` scopes five invented initiatives with
different weights.

The rows cover equal-score ties (by slug, by initiative weight, and by ID number), a blocked
dependency, stop-short hard-stop words, kinds by tag and by title regex, three `kind:discovery`
rows in the top 10, untriaged tasks, odd and missing dates and severities, a seat-only excluded
tag, reserved tags the seat's list leaves out, an excluded title pattern, and nit and
agent-tooling rows that stay out of the top 10.

## Reproduce

score.py reads `charter.md` and `seats/<name>.md` from its own directory, so run a copy of it
beside the fixture policy. From this directory, with `SCORE_PY` pointing at the autonomy
`score.py`:

```sh
node generate.mjs
W="$(mktemp -d)" && mkdir "$W/seats" && cp "$SCORE_PY" charter.md "$W/" && cp seats/sample-seat.md "$W/seats/"
python3 "$W/score.py" --seat sample-seat --top 10 --json --tasks-json tasks.json --today 2026-09-29 > expected-sample-seat.json
```

Both commands leave `git diff` empty when the fixture and score.py agree.
