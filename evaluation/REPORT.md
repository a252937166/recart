# ReCart evaluation report

ReCart was measured on 20 frozen fixture cases and one fresh 8-case extraction holdout. These are team-authored engineering fixtures on brand-free simulated products, not a real-user study. Every run is published, including the ones that went badly.

## How the cases were made

- **Authorship.** The builder (Claude Code, acting for the team) wrote 20 buyer requests from the declared catalog and recipe rules: 14 feasible, 3 complete-search infeasible, 2 evidence-incomplete and 1 unsupported.
- **Labels.** Each case has hand labels for what the request states, what it leaves unknown and what conflicts.
- **Solver inputs.** Each case has a complete reference goal, an availability map and an original bundle with one missing product.
- **Expectations.** Each has a hand-derived best bundle or a written exclusion argument.
- **Freeze.** The cases, the scoring rules (`SCORING-v1.md`) and the runner were hashed in `FREEZE-v1.json` before either the solver or the language model saw any case.
- **Development examples.** The runner was debugged only on two development examples taken from the demo scenarios.

## Solver: v1, unchanged in every later run

| Check | Result |
|---|---|
| Classification correct | 20 of 20 |
| Feasible cases solved with the exact expected bundle and total | 14 of 14 |
| Infeasible, evidence-incomplete, unsupported | 3 of 3, 2 of 2, 1 of 1 |
| Invalid payable bundles | 0 |
| Search completed over the declared domain | 20 of 20 |
| Solve time | median 2.2 ms, max 13.6 ms |

## Whole-bundle recovery against an item-only baseline

The 19 recovery cases are scored against an item-only baseline. The baseline replaces only the missing product's role, keeps every other original line, and uses the same hard checks.

| Outcome | Cases |
|---|---|
| ReCart found a complete bundle | 14 |
| Item-only swap found one | 8 |
| ReCart only | C01, C02, C05, C06, C10, C12 |
| Both | C03, C04, C07, C08, C09, C11, C13, C14 |
| Baseline only | none |

Each ReCart-only case needed a dependent change: a cable plus a host adapter for a USB-B interface, a switch from the USB-mic recipe to the XLR recipe, or a second role change to stay within budget. Every baseline outcome matched its hand-derived expectation. A baseline failure means only that no single-part swap works.

## First-pass AI extraction

Every run uses Claude Haiku 4.5 through the Astropods-hosted endpoint and scores the first returned draft.

| Run | What it is | Whole case | Precision | Recall | Wrong values | Unsupported | Unknowns kept | Conflicts flagged | Failed calls |
|---|---|---|---|---|---|---|---|---|---|
| v1 | Frozen first pass | 17/20 | 143/145 | 143/149 | 0 | 2 | 6/8 | 1/2 | 1 |
| v2 | Rerun, prompt revised | 17/20 | 147/150 | 147/149 | 2 | 1 | 7/8 | 2/2 | 0 |
| v3 | Rerun, v1 prompt plus deterministic dates | 19/20 | 143/143 | 143/149 | 0 | 0 | 8/8 | 1/2 | 1 |
| v4 | Rerun, conflict rule plus budget safety net | 20/20 | 149/149 | 149/149 | 0 | 0 | 8/8 | 2/2 | 0 |
| holdout-v1 | Fresh 8 cases, single run of the v4 system | 8/8 | 55/55 | 55/55 | 0 | 0 | 6/6 | 2/2 | 0 |

**v1 is the untouched result.** Runs v2 to v4 were made after examining earlier failures on the same 20 cases, so they are not holdouts. From v3 onward, the scores describe the product's extraction path, which is the model plus deterministic date and budget checks that run after it. They are not bare-model accuracy. Each has its own freeze record: `FREEZE-v2.json` to `FREEZE-v4.json`. The holdout was labeled and hashed before its single run, in `FREEZE-holdout-v1.json`.

### What failed and what changed

- **v1, C05 and C19.** The model resolved "next Friday" and "this weekend" to single dates instead of asking. The original prompt's own weekday rule encouraged this.
- **v1, C06.** The request gives two budgets. The model wrote two quoted spans into one field, which is invalid JSON, so the product fell back to rules. This happened in two of three calls with the v1 prompt.
- **v2 changed the date rule in the prompt.** It fixed "this weekend" but made a plain "Tuesday", said on a Monday, resolve a week late (C04, C13). "Next Friday" was still guessed. The change was reverted.
- **v3 moved date reading into code.** `src/server/language/dates.ts` recomputes bare weekdays, "today" and "tomorrow" from the reference date in the buyer's timezone. It turns "next weekday", weekends and unnamed next-week phrases into a question. Its unit tests use a different reference date and different phrases.
- **v4 added a conflict rule to the prompt.** A conflicting field is left empty and listed, with one exact span per field. It also added a deterministic safety net: more than one distinct dollar amount in a request becomes a budget question instead of a guess.

### Correction to the published numbers

The runner first subtracted conflict fields from the stated-fact count, although stated labels never include them. This overstated recall. For v1 it showed 97.3% instead of the correct 96.0% (143/149).

The runner was fixed. Every stored run was rescored from its per-case results, and no model output changed. Each summary lists the correction under `corrections`.

## Reproducing earlier runs

The v1 to v3 sources were edited in place before the project used Git. `evaluation/history/` rebuilds them, and every file a freeze record hashed matches it byte for byte. The rebuilt v1 runner reproduces the stored v1 solver and baseline rows exactly.

## Limits

- **Coverage.** Twenty cases plus eight holdout cases, written by the builder, on one simulated catalog and one model. This is not a population accuracy claim.
- **Nondeterminism.** The model can vary even at temperature 0, as C06 showed. One run per version is what the rules allow.
- **Budget safety net.** The net can ask an unnecessary question when a request mentions an unrelated price. That is a deliberate trade toward asking.
- **Buyer confirmation.** The buyer's confirmed form remains the authority, whatever the extraction score.
- **Not run.** The five-person comprehension check from the specification has not been run.

## Reproduce

```sh
set -a; . ~/.config/recart/recart-local.env; set +a   # DATABASE_URL, LANGUAGE_URL, LANGUAGE_TOKEN
npx tsx tools/run-benchmark.ts --cases evaluation/cases-v1.json --out evidence/benchmark/rerun
npx tsx tools/run-benchmark.ts --cases evaluation/cases-v1.json --out /tmp/solver-only --skip-language
```

The solver and baseline need no network access. Extraction needs a running language endpoint and a database for its run records.
