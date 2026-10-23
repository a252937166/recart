# ReCart evaluation scoring rules, v1

These rules were written and frozen together with `cases-v1.json` before any scored run. `FREEZE-v1.json` records the hashes of the cases, these rules, and the runner. If anything changes after a run, the change gets a new version and the earlier run stays published.

The cases are team-authored engineering fixtures on brand-free simulated products. They are not an independent or real-user study, and the results are not a population accuracy claim.

## Solver scoring (all 20 cases)

Each case runs `solve()` once with its complete reference goal, its availability map, its reference time, and, for recovery cases, the original bundle for least-disruption ranking.

- **Classification** is correct when the returned status equals the expected status.
- **Feasible cases (14).** A case is solved when the status is `FEASIBLE` and the top-ranked bundle:
  - uses the expected recipe and exactly the expected SKUs and quantities;
  - has the expected total, which the runner also recomputes independently from catalog prices and the 8% half-up tax rule;
  - passes the shared hard validator (`revalidateLines`) at the case's reference time.
- **Invalid payable bundle.** Any `FEASIBLE` output on a case not expected to be feasible, or any top bundle that fails the validator. The target is zero.
- **Other cases.** Infeasible, evidence-incomplete and unsupported cases must stop with exactly their expected status. A `FEASIBLE` output there counts as an unsupported capability claim.
- **Also reported.** Changed items versus the original (disruption), combinations checked, whether search completed, and solve duration.

The expected best bundle follows the declared ranking: preference penalty, then fewest changed items, then evidence level, then total, then recipe and SKU order. The hand-derived expectations are the scoring authority, even though the solver and the validator share code.

## Item-only baseline (19 recovery cases)

For each recovery case the baseline replaces only the role of the missing product and keeps every other original line and quantity.

- It tries every product the original recipe allows for that role, including another unit of the same product when stock allows.
- Each candidate is validated with the same hard checks at the same reference time.
- The baseline succeeds when at least one candidate passes every check with no unconfirmed fact.

The runner reports success counts, the cases where ReCart found a bundle and the baseline did not, and whether each baseline outcome matches the hand-derived expectation. A baseline failure means "no solution under the item-only restriction", nothing more.

## First-pass AI extraction (all 20 cases)

Each request is sent once through the product's own extraction path (`HostedLanguageAdapter.extractGoal`), with the case's reference time and buyer timezone. The first returned draft is scored as-is: no retry, no human edit. A call that fails or falls back to the rules extractor counts as a failed call. It stays in the denominator, asserts nothing, and misses all of its stated facts.

**Scored fields.** `localPeople`, `remoteGuests`, `hostPort`, `os`, `callApp`, `budgetCents` (value, plus `allIn` when the wording says "before tax"), `recordingDate`, `recordingTime`, and the owned counts `owned.headphones`, `owned.micCables` and `owned.stands`.

**Normalization.**
- Counts are integers.
- Ports, operating systems and call apps are the schema's enum values.
- Budgets are integer cents.
- Dates are `YYYY-MM-DD`, resolved from the reference date in the buyer timezone.
- Times are 24-hour `HH:MM` local time.
- When a budget label says `allIn: false`, the draft must also say `allIn: false`. When the label says all-in, a draft value of `false` is wrong.

**Assertions.** Any non-null scored field counts as an assertion. Owned counts count only when non-zero, because zero is the schema default.

**Counting.**
- **True positive.** An asserted value equals a stated label.
- **Wrong value.** One false positive and one false negative.
- **Missing stated value.** One false negative.
- **Unsupported assertion.** A non-null value for a field the text does not state, including a non-zero owned count that was never mentioned, or a call app when no remote guest exists. It counts as one false positive and is also listed as unsupported.
- **Not a true positive.** Correctly omitted fields never count.

**Metrics.**
- **Precision** is true positives over assertions. It is reported as not applicable when nothing was asserted.
- **Recall** is true positives over stated labels.
- **Unknown handling.** A labeled unknown is preserved when the draft leaves it null. Whether the field also appears in `unknowns` or a question is reported separately.
- **Conflict handling.** A labeled conflict is handled when `conflicts` names that field. It is silently resolved when it is not named and the field holds a value. Conflict fields are excluded from precision and recall.
- **Whole-case correctness** requires:
  - every stated label correct;
  - no unsupported assertion;
  - every labeled unknown left null;
  - every labeled conflict named.
- **Operational outcome.** Failed calls, latency (median and p95), recorded tokens, and an estimated cost at $1 per million input tokens and $5 per million output tokens (Claude Haiku 4.5 list price).

**Targets** are zero unsupported hard assertions and zero silently resolved conflicts. Every miss is published.
