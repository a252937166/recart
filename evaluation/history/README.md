# Historical evaluation sources

The v1 to v3 runs were made before this project used Git, and their runner and language sources were later edited in place. Later edits also touched files the v4 and holdout runs hashed: the adapter on 2026-10-10, and the prompts and date module in release 17 on 2026-10-23. This folder rebuilds the v1 to v3 files by reversing the recorded edits and keeps the v4 files as they were, so each earlier run can be reproduced. Every file that a freeze record hashed matches its hash byte for byte, either at its original path or here; `tests/unit/evaluation-freeze.test.ts` checks this.

| Version | File | Original path | Verified against |
|---|---|---|---|
| v1 | `run-benchmark.ts` | `tools/run-benchmark.ts` | `FREEZE-v1.json` (match) |
| v1 | `prompts.ts`, `adapter.ts`, `rules.ts` | `src/server/language/` | Not hashed at the time; rebuilt from the documented edits. The prompt text equals v3's, which is verified. |
| v2 | `run-benchmark.ts`, `prompts.ts` | as above | `FREEZE-v2.json` (both match) |
| v2 | `adapter.ts`, `rules.ts` | `src/server/language/` | Not hashed at the time; rebuilt from the documented edits |
| v3 | `run-benchmark.ts`, `prompts.ts`, `dates.ts`, `adapter.ts`, `rules.ts` | as above | `FREEZE-v3.json` (all match) |
| v4 | `run-benchmark.ts` | `tools/run-benchmark.ts` | v4 ran with the archived **v3** runner, `v3/run-benchmark.ts` (matches `FREEZE-v4.json`); the current runner differs |
| v4 | `adapter.ts` | `src/server/language/` | `v4/adapter.ts` (matches `FREEZE-v4.json`). The current adapter changed on 2026-10-10 so merchant drafts keep only a hash of the buyer's text |
| v4 | `prompts.ts`, `dates.ts` | `src/server/language/` | `v4/prompts.ts`, `v4/dates.ts` (match `FREEZE-v4.json`), copied from commit `f3d30a2`. Release 17 changed both on 2026-10-23: `lang-prompts-v4` names setups by their labels in explanations, and `postprocess-v4` adds the quote-support check in `spans.ts` |
| v4 | `rules.ts` | `src/server/language/` | the current file (matches `FREEZE-v4.json`) |
| holdout-v1 | `run-benchmark.ts`, `rules.ts` | as above | the current files (match `FREEZE-holdout-v1.json`) |
| holdout-v1 | `adapter.ts`, `prompts.ts`, `dates.ts` | `src/server/language/` | `v4/adapter.ts`, `v4/prompts.ts`, `v4/dates.ts` (match `FREEZE-holdout-v1.json`) |

## Reproducing a version

1. Copy the repository to a scratch directory.
2. Copy that version's files over their original paths.
3. Run the runner as `evaluation/REPORT.md` describes.

The solver and baseline half is deterministic. Running the rebuilt v1 runner with `--skip-language` reproduced every stored v1 solver and baseline row exactly, and it reported the same runner hash.

The extraction half calls the model again, so it gives a new sample rather than the stored outputs. The stored per-case drafts in `evidence/benchmark/*/results.json` can always be rescored.
